/**
 * Sidecar protocol v1 — the ONLY contract between Electron main and the
 * Python engine daemon (`geny_app.sidecar`). JSON-lines over stdio.
 *
 * Invariants that the Python side also enforces:
 *  · exactly ONE terminal event per turn (`done` | `cancelled` | `error`)
 *  · a turn that observed a cancel closes as `cancelled`, even if the
 *    engine stream ended naturally first (the done/cancel race)
 *  · fd 1 is duplicated and `sys.stdout` redirected to stderr, so a stray
 *    library print() can never corrupt the stream
 */

export const SIDECAR_PROTOCOL = 1;

// ── commands: Electron → Python ────────────────────────────────────
export type SidecarCommand =
  | { id: string; op: 'ping' }
  | { id: string; op: 'shutdown' }
  | { id: string; op: 'turn'; session: string; text: string; config: TurnConfig }
  | { id: string; op: 'cancel'; target: string }
  | { id: string; op: 'prompt_reply'; promptId: string; value: string | null }
  | { id: string; op: 'hitl'; token: string; decision: HitlDecision }
  | { id: string; op: 'refresh'; session: string; config: TurnConfig }
  | { id: string; op: 'evict'; session: string };

export type HitlDecision = 'approve' | 'reject' | 'cancel';

/** Everything the engine needs to build (or refresh) one agent pipeline. */
export interface TurnConfig {
  provider: 'anthropic' | 'openai' | 'claude_code_cli';
  model?: string;
  /** manifest preset — engine ships worker_adaptive | vtuber | default */
  preset?: string;
  apiKey?: string;
  baseUrl?: string;
  /** absolute agent dir: workspace/ memory/ sessions/ live under it */
  agentDir: string;
  /** tool jail — fs tools refuse anything outside these roots */
  allowedPaths?: string[];
  builtInTools?: string[];
  /** 'default' asks for risky ops; the app never ships 'bypass' as default */
  permissionMode?: 'default' | 'plan' | 'auto' | 'acceptEdits' | 'dontAsk' | 'bypass';
  systemPrompt?: string;
  maxTurns?: number;
  extras?: Record<string, unknown>;
}

// ── events: Python → Electron ──────────────────────────────────────
export type SidecarEvent =
  | { type: 'ready'; protocol: number; engine: string; python: string }
  | { id: string; type: 'pong' }
  | { id: string; type: 'started'; session: string }
  /** raw engine event, forwarded verbatim (121 typed kinds) */
  | { id: string; type: 'event'; event: string; data: unknown }
  /** assistant text delta — the fast path the chat UI renders */
  | { id: string; type: 'chunk'; text: string }
  /** tool lifecycle, already normalized for the UI */
  | { id: string; type: 'tool'; phase: 'start' | 'result' | 'error'; name: string; toolUseId?: string; payload?: unknown }
  /** AskUserQuestion → must be answered with `prompt_reply` */
  | { id: string; type: 'prompt'; promptId: string; question: string; options?: string[]; timeoutSeconds?: number }
  /** permission / plan approval → must be answered with `hitl` */
  | { id: string; type: 'hitl_request'; token: string; kind: string; detail: unknown }
  | { id: string; type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { id: string; type: 'meta'; data: Record<string, unknown> }
  | { id: string; type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { id: string; type: 'done'; events: number }
  | { id: string; type: 'cancelled' }
  | { id: string; type: 'error'; error: string; code?: string; trace?: string };

export type TerminalEventType = 'done' | 'cancelled' | 'error';
export const isTerminal = (e: SidecarEvent): boolean =>
  e.type === 'done' || e.type === 'cancelled' || e.type === 'error';
