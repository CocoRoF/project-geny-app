/**
 * SidecarDaemon — the Node side of the JSON-lines protocol.
 *
 * A direct descendant of xgen-connector's protocol-v2 client, which replaced
 * a per-turn-spawn v1 because spawning Python per turn cost seconds on
 * Windows and rebuilt MCP children every turn. Hard-won details kept:
 *  · `-I -X utf8 -u`: isolate from the user's PYTHON* env, force UTF-8
 *    (`-I` also ignores PYTHONIOENCODING, hence `-X utf8`)
 *  · scrub PYTHON* from the child env, windowsHide
 *  · ready timeout, failAll() on close so no turn can hang forever
 *  · stderr tail surfaced in errors — a Python traceback is the whole
 *    diagnosis and it never reaches stdout
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { SidecarCommand, SidecarEvent } from '@shared/sidecar-protocol';
import { SIDECAR_PROTOCOL } from '@shared/sidecar-protocol';

export interface SidecarOptions {
  pythonExe: string;
  /** cwd for the child; also where `geny_app` must be importable from */
  cwd: string;
  /** extra env (never PYTHON*) */
  env?: Record<string, string>;
  readyTimeoutMs?: number;
  onEvent: (e: SidecarEvent) => void;
  onExit?: (code: number | null, stderrTail: string) => void;
  log?: (line: string) => void;
}

const SCRUB = ['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PYTHONSAFEPATH', 'PYTHONIOENCODING'];

export class SidecarDaemon {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private stderrTail = '';
  private readyPromise: Promise<SidecarEvent & { type: 'ready' }> | null = null;
  private seq = 0;

  constructor(private readonly opts: SidecarOptions) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  nextId(prefix = 'c'): string {
    this.seq += 1;
    return `${prefix}${this.seq}-${Date.now().toString(36)}`;
  }

  async start(): Promise<SidecarEvent & { type: 'ready' }> {
    if (this.readyPromise) return this.readyPromise;

    const env: Record<string, string> = { ...process.env as Record<string, string>, ...(this.opts.env ?? {}) };
    for (const key of SCRUB) delete env[key];
    env.PYTHONNOUSERSITE = '1';

    const child = spawn(
      this.opts.pythonExe,
      ['-I', '-X', 'utf8', '-u', '-m', 'geny_app.sidecar', '--serve'],
      { cwd: this.opts.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-8192);
      this.opts.log?.(d.trimEnd());
    });

    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this.onLine(line));

    child.on('close', (code) => {
      this.child = null;
      this.reader?.close();
      this.reader = null;
      this.readyPromise = null;
      this.opts.onExit?.(code, this.stderrTail);
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const timeoutMs = this.opts.readyTimeoutMs ?? 90_000;
      const timer = setTimeout(() => {
        reject(new Error(`sidecar did not report ready in ${timeoutMs}ms\n${this.tail()}`));
        this.stop();
      }, timeoutMs);
      this.readyResolve = (ev) => {
        clearTimeout(timer);
        if (ev.protocol !== SIDECAR_PROTOCOL) {
          reject(new Error(`protocol mismatch: app ${SIDECAR_PROTOCOL}, engine ${ev.protocol}`));
          this.stop();
          return;
        }
        resolve(ev);
      };
      this.readyReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
    return this.readyPromise;
  }

  private readyResolve: ((e: SidecarEvent & { type: 'ready' }) => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  private onLine(line: string): void {
    let ev: SidecarEvent;
    try {
      ev = JSON.parse(line) as SidecarEvent;
    } catch {
      // Protocol stdout is claimed by the sidecar and stdout is redirected to
      // stderr, so this should be unreachable — surface it loudly if not.
      this.opts.log?.(`[protocol] non-JSON line: ${line.slice(0, 200)}`);
      return;
    }
    if (ev.type === 'ready') this.readyResolve?.(ev);
    this.opts.onEvent(ev);
  }

  send(cmd: SidecarCommand): void {
    const child = this.child;
    if (!child || child.exitCode !== null) throw new Error('sidecar is not running');
    child.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  tail(): string {
    return this.stderrTail.slice(-2000);
  }

  async stop(graceMs = 5000): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      this.send({ id: this.nextId('sd'), op: 'shutdown' });
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        resolve();
      }, graceMs);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    this.child = null;
    this.readyPromise = null;
  }
}
