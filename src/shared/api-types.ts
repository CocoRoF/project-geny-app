/**
 * The typed surface `preload` exposes as `window.geny`. Renderer imports
 * ONLY from here — never from main. Adding a capability means adding it
 * here first, which keeps the IPC surface reviewable in one file.
 */
import type { HitlDecision, SidecarEvent, TurnConfig } from './sidecar-protocol';

export interface AgentRecord {
  id: string;
  name: string;
  provider: TurnConfig['provider'];
  model?: string;
  createdAt: number;
  /** absolute path — <data-root>/agents/<id> */
  dir: string;
}

export interface EngineStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  protocol?: number;
  engine?: string;
  python?: string;
  error?: string;
  /** which runtime candidate is in use */
  runtime?: { source: 'bundle' | 'install' | 'system'; exe: string };
}

export interface AppPaths {
  dataRoot: string;
  portable: boolean;
}

export interface GenyApi {
  app: {
    paths(): Promise<AppPaths>;
    openPath(p: string): Promise<void>;
  };
  engine: {
    status(): Promise<EngineStatus>;
    start(): Promise<EngineStatus>;
    onStatus(cb: (s: EngineStatus) => void): () => void;
  };
  agents: {
    list(): Promise<AgentRecord[]>;
    create(input: { name: string; provider: TurnConfig['provider']; model?: string }): Promise<AgentRecord>;
    remove(id: string): Promise<void>;
  };
  secrets: {
    setApiKey(provider: string, key: string): Promise<void>;
    hasApiKey(provider: string): Promise<boolean>;
  };
  chat: {
    /** start a turn; events arrive via onEvent until a terminal event */
    send(input: { agentId: string; text: string }): Promise<{ turnId: string }>;
    cancel(turnId: string): Promise<void>;
    replyPrompt(promptId: string, value: string | null): Promise<void>;
    decideHitl(token: string, decision: HitlDecision): Promise<void>;
    onEvent(cb: (e: SidecarEvent) => void): () => void;
  };
}

declare global {
  interface Window {
    geny: GenyApi;
  }
}
