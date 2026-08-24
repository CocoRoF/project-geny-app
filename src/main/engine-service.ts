/**
 * EngineService — the app's agent runtime, everything Geny's FastAPI backend
 * did for a turn, minus the server.
 *
 * Owns: the sidecar lifecycle, the runtime ladder, turn routing, and the
 * mapping from an agent record + stored secret to a TurnConfig. Deliberately
 * free of `import 'electron'` so it unit-tests in plain Node.
 */
import { randomUUID } from 'node:crypto';
import type { AgentRecord, EngineStatus } from '@shared/api-types';
import { TURN_TIMEOUT_SECONDS } from '@shared/models';
import type { SidecarEvent, TurnConfig } from '@shared/sidecar-protocol';
import { locateRuntime, type LocateInput } from './runtime-locate';
import { SidecarDaemon } from './sidecar';

export interface EngineDeps {
  locate: LocateInput;
  /** cwd for the sidecar child (repo root in dev, resources in prod) */
  cwd: string;
  secret(provider: string): string | undefined;
  agentDir(agentId: string): string;
  emit(event: SidecarEvent): void;
  onStatus(status: EngineStatus): void;
  /** called once per turn with the assistant's full reply (never per chunk:
   *  that would be one write per token) */
  persistAssistant(agentId: string, text: string): void;
  log?: (line: string) => void;
}

/**
 * The workspace IS the containment boundary: every agent gets its own
 * `<data-root>/agents/<id>/workspace` and the engine's fs tools refuse
 * anything outside it (`allowedPaths`). Inside that jail, editing files is
 * the job, not a risk — so edits are pre-approved and only genuinely
 * escalating operations should stop to ask.
 *
 * For `claude_code_cli` this is not merely a preference: geny-executor only
 * passes `--permission-mode` when the mode is NOT 'default'
 * (llm_client/translators/_cli.py), so 'default' leaves the CLI on its own
 * interactive default. Under a piped, non-interactive host that means writes
 * are refused and the refusal appears only as assistant prose — a silent
 * block, which an E2E run reproduced (the agent "succeeded" but wrote no
 * file). Being explicit is the fix.
 */
export function defaultPermissionMode(provider: AgentRecord['provider']): TurnConfig['permissionMode'] {
  return provider === 'claude_code_cli' ? 'acceptEdits' : 'default';
}

export class EngineService {
  private daemon: SidecarDaemon | null = null;
  private status: EngineStatus = { state: 'stopped' };
  /** turnId → { agentId, streamed text } — the attribution the UI events
   *  lack, and the buffer that makes one write per turn possible */
  private readonly turns = new Map<string, { agentId: string; text: string }>();

  constructor(private readonly deps: EngineDeps) {}

  getStatus(): EngineStatus {
    return this.status;
  }

  private setStatus(next: EngineStatus): void {
    this.status = next;
    this.deps.onStatus(next);
  }

  async start(): Promise<EngineStatus> {
    if (this.daemon?.running && this.status.state === 'ready') return this.status;
    this.setStatus({ state: 'starting' });

    const located = await locateRuntime(this.deps.locate);
    if (!located.active) {
      const why = located.candidates
        .map((c) => `${c.source}:${c.exists ? (c.error ?? 'unhealthy') : 'missing'}`)
        .join(' · ');
      this.setStatus({ state: 'failed', error: `no usable python runtime (${why})` });
      return this.status;
    }

    const daemon = new SidecarDaemon({
      pythonExe: located.active.exe,
      cwd: this.deps.cwd,
      onEvent: (event) => this.route(event),
      onExit: (code, tail) => {
        this.daemon = null;
        for (const [turnId, turn] of this.turns) {
          if (turn.text.trim()) this.deps.persistAssistant(turn.agentId, turn.text);
          this.deps.emit({ id: turnId, type: 'error', error: `engine exited (code ${code})`, trace: tail.slice(-800) });
        }
        this.turns.clear();
        this.setStatus({ state: 'failed', error: `engine exited (code ${code})` });
      },
      log: this.deps.log,
    });

    try {
      const ready = await daemon.start();
      this.daemon = daemon;
      this.setStatus({
        state: 'ready',
        protocol: ready.protocol,
        engine: ready.engine,
        python: ready.python,
        runtime: { source: located.active.source === 'dev' ? 'system' : located.active.source, exe: located.active.exe },
      });
    } catch (err) {
      this.setStatus({ state: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
    return this.status;
  }

  private route(event: SidecarEvent): void {
    if ('id' in event) {
      const turn = this.turns.get(event.id);
      if (turn) {
        if (event.type === 'chunk') {
          turn.text += event.text;
        } else if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
          this.turns.delete(event.id);
          // a cancelled or failed turn still keeps whatever was said before
          // it stopped — losing it would make the transcript lie
          if (turn.text.trim()) this.deps.persistAssistant(turn.agentId, turn.text);
        }
      }
    }
    this.deps.emit(event);
  }

  turnConfig(agent: AgentRecord): TurnConfig {
    const dir = this.deps.agentDir(agent.id);
    return {
      provider: agent.provider,
      model: agent.model,
      apiKey: this.deps.secret(agent.provider),
      agentDir: dir,
      allowedPaths: [`${dir}/workspace`],
      permissionMode: defaultPermissionMode(agent.provider),
    };
  }

  async send(agent: AgentRecord, text: string): Promise<{ turnId: string }> {
    if (!this.daemon?.running) await this.start();
    const daemon = this.daemon;
    if (!daemon) throw new Error(this.status.error ?? 'engine unavailable');

    const turnId = randomUUID();
    this.turns.set(turnId, { agentId: agent.id, text: '' });
    daemon.send({ id: turnId, op: 'turn', session: agent.id, text, config: this.turnConfig(agent) });
    return { turnId };
  }

  /** Apply a config change to a live session at its next turn boundary. */
  refresh(agent: AgentRecord): void {
    if (!this.daemon?.running) return;
    this.daemon.send({
      id: this.daemon.nextId('rf'),
      op: 'refresh',
      session: agent.id,
      config: this.turnConfig(agent),
    });
  }

  cancel(turnId: string): void {
    this.daemon?.send({ id: this.daemon.nextId('cx'), op: 'cancel', target: turnId });
  }

  replyPrompt(promptId: string, value: string | null): void {
    this.daemon?.send({ id: this.daemon.nextId('pr'), op: 'prompt_reply', promptId, value });
  }

  decideHitl(token: string, decision: 'approve' | 'reject' | 'cancel'): void {
    this.daemon?.send({ id: this.daemon.nextId('hl'), op: 'hitl', token, decision });
  }

  async stop(): Promise<void> {
    await this.daemon?.stop();
    this.daemon = null;
    this.setStatus({ state: 'stopped' });
  }
}
