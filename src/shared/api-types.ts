/**
 * The typed surface `preload` exposes as `window.geny`. Renderer imports
 * ONLY from here — never from main. Adding a capability means adding it
 * here first, which keeps the IPC surface reviewable in one file.
 */
import type { AgentPosture, HitlDecision, SidecarEvent, TurnConfig } from './sidecar-protocol';

export interface AgentRecord {
  id: string;
  name: string;
  provider: TurnConfig['provider'];
  model?: string;
  posture: AgentPosture;
  systemPrompt?: string;
  createdAt: number;
  /** absolute path — <data-root>/agents/<id> */
  dir: string;
}

export interface McpServerRecord {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  createdAt: number;
}

/** What the engine actually loaded for a session — the honest answer to
 *  "is my MCP server / skill working?" */
export interface CapabilityReport {
  tools: string[];
  mcpServers: Array<{ name: string; tools: number; error?: string }>;
  skills: Array<{ id: string; name: string }>;
  slashCommands: string[];
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface FilePreview {
  path: string;
  kind: 'text' | 'image' | 'binary';
  content: string;
  size: number;
  truncated: boolean;
}

export interface StoredMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
}

export interface CliInfo {
  found: boolean;
  path?: string;
  version?: string;
  via?: 'path' | 'known-location' | 'login-shell';
  error?: string;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'unsupported' | 'error';
  version?: string;
  percent?: number;
  error?: string;
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
    create(input: {
      name: string;
      provider: TurnConfig['provider'];
      model?: string;
      posture?: AgentPosture;
    }): Promise<AgentRecord>;
    update(id: string, patch: Partial<Pick<AgentRecord, 'name' | 'model' | 'posture' | 'systemPrompt'>>): Promise<AgentRecord>;
    remove(id: string): Promise<void>;
  };
  secrets: {
    setApiKey(provider: string, key: string): Promise<void>;
    hasApiKey(provider: string): Promise<boolean>;
    clearApiKey(provider: string): Promise<void>;
    backend(): Promise<'keychain' | 'file'>;
  };
  cli: {
    detect(): Promise<CliInfo>;
  };
  mcp: {
    list(): Promise<McpServerRecord[]>;
    add(input: { name: string; command: string; args?: string[]; env?: Record<string, string> }): Promise<McpServerRecord>;
    remove(id: string): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    forAgent(agentId: string): Promise<McpServerRecord[]>;
    setForAgent(agentId: string, serverIds: string[]): Promise<void>;
  };
  capabilities: {
    /** ask the running engine what a session actually loaded */
    inspect(agentId: string): Promise<CapabilityReport>;
  };
  update: {
    check(): Promise<UpdateState>;
    state(): Promise<UpdateState>;
  };
  onboarding: {
    /** false until the user has finished first-run setup */
    done(): Promise<boolean>;
    complete(): Promise<void>;
  };
  files: {
    /** list a folder inside the agent's own dirs (rejects paths outside) */
    list(agentId: string, path?: string): Promise<DirEntry[]>;
    preview(agentId: string, path: string): Promise<FilePreview>;
    reveal(path: string): Promise<void>;
  };
  chat: {
    /** conversation replayed from the store — survives an app restart */
    history(agentId: string): Promise<StoredMessage[]>;
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
