/**
 * The typed surface `preload` exposes as `window.geny`. Renderer imports
 * ONLY from here — never from main. Adding a capability means adding it
 * here first, which keeps the IPC surface reviewable in one file.
 */
import type { AgentPosture, HitlDecision, SidecarEvent, TurnConfig } from './sidecar-protocol';
import type { SpokenAudio, VoiceConfig, VoiceHealth, VoiceOption } from './voice';

export interface AgentRecord {
  id: string;
  name: string;
  provider: TurnConfig['provider'];
  model?: string;
  posture: AgentPosture;
  systemPrompt?: string;
  /** built-in tools this agent may use; empty/undefined = the app default */
  tools?: string[];
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
export interface StageInfo {
  order: number | null;
  name: string;
  category?: string | null;
  active: boolean;
  strategies: Array<{ slot: string; current: string | null; available: string[] }>;
}

export interface CapabilityReport {
  tools: string[];
  mcpServers: Array<{ name: string; tools: number; error?: string }>;
  skills: Array<{ id: string; name: string }>;
  /** the engine's 21 stages, as actually configured for this session */
  stages: StageInfo[];
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

export interface PersonaRecord {
  id: string;
  name: string;
  description?: string;
  model?: string;
  posture?: AgentPosture;
  tools?: string[];
  prompt: string;
  userDefined: boolean;
}

export interface MemoryNote {
  path: string;
  category: string;
  title: string;
  bytes: number;
  modified: number;
  preview: string;
}

export interface MemoryOverview {
  root: string;
  longTerm?: { path: string; bytes: number; modified: number; text: string };
  notes: MemoryNote[];
  categories: Array<{ id: string; count: number }>;
  transcript?: { path: string; turns: number; bytes: number };
}

/** How a model folder is displayed. See src/main/avatars.ts for why the
 *  split is a licensing one rather than a technical one. */
export type AvatarKind = 'mmd' | 'live2d' | 'spine' | 'web' | 'image' | 'unknown';

/** A model folder the user dropped into `<data-root>/avatars`. */
export interface AvatarModel {
  id: string;
  name: string;
  kind: AvatarKind;
  file: string;
  dir: string;
  bytes: number;
  /** runtime files the format needs that are not in the folder — non-empty
   *  means the app can name the avatar but not yet show it */
  missing: string[];
  source?: string;
}

export interface AvatarState {
  /** false when the avatars folder is empty — the UI says so rather than
   *  offering a toggle that cannot do anything */
  available: boolean;
  visible: boolean;
  clickThrough: boolean;
  modelId?: string;
  modelName?: string;
  kind?: AvatarKind;
  /** file:// URL of the thing to load — .pmx, index.html, or an image.
   *  Relative assets resolve next to it. */
  modelUrl?: string;
  /** runtime files still missing for the selected model */
  missing?: string[];
  scale: number;
  folder: string;
}

export interface GenyApi {
  app: {
    paths(): Promise<AppPaths>;
    openPath(p: string): Promise<void>;
    /** summon the quick-chat strip (same thing the global shortcut does) */
    quickChat(): Promise<void>;
    hideQuickChat(): Promise<void>;
  };
  engine: {
    status(): Promise<EngineStatus>;
    start(): Promise<EngineStatus>;
    onStatus(cb: (s: EngineStatus) => void): () => void;
  };
  knowledge: {
    stats(): Promise<{ documents: number; chunks: number }>;
    reindex(): Promise<{ documents: number; chunks: number; skipped: Array<{ path: string; reason: string }>; took: number }>;
    search(query: string): Promise<Array<{ path: string; title: string; snippet: string; modified: number }>>;
    openFolder(): Promise<void>;
  };
  memory: {
    /** what this agent remembers — long-term note, structured notes, turns */
    overview(agentId: string): Promise<MemoryOverview>;
    note(agentId: string, path: string): Promise<{ path: string; text: string }>;
    /** the short-term turn log — the only memory that exists early on */
    transcript(agentId: string): Promise<Array<{ index: number; role: string; text: string; at?: number }>>;
    openFolder(agentId: string): Promise<void>;
  };
  voice: {
    config(): Promise<VoiceConfig>;
    save(config: VoiceConfig): Promise<VoiceConfig>;
    setKey(which: 'stt' | 'tts', key: string | null): Promise<VoiceConfig>;
    /** actually probe both endpoints — not a guess from the config */
    health(): Promise<{ stt: VoiceHealth; tts: VoiceHealth }>;
    /** what the TTS service offers; omnivoice profiles carry emotions */
    voices(): Promise<VoiceOption[]>;
    /** send captured audio to STT and get text back */
    transcribe(input: { base64: string; mime: string }): Promise<{ text: string }>;
    /** synthesize and play; resolves once the audio has been handed to a surface */
    speak(text: string): Promise<{ played: boolean; local: boolean }>;
    /** audio to play, pushed from the main process */
    onAudio(cb: (a: SpokenAudio) => void): () => void;
  };
  avatar: {
    /** models found on disk plus the current overlay state */
    list(): Promise<{ models: AvatarModel[]; state: AvatarState }>;
    state(): Promise<AvatarState>;
    select(modelId: string | null): Promise<AvatarState>;
    show(): Promise<AvatarState>;
    hide(): Promise<AvatarState>;
    toggle(): Promise<AvatarState>;
    /** click-through off = the overlay accepts the mouse and can be dragged */
    setClickThrough(enabled: boolean): Promise<AvatarState>;
    setScale(scale: number): Promise<AvatarState>;
    /** write a display page for a Live2D/Spine folder so the overlay can
     *  show it once the user supplies the runtime */
    scaffold(modelId: string): Promise<{ created: boolean; page: string; models: AvatarModel[]; state: AvatarState }>;
    openFolder(): Promise<void>;
    onState(cb: (s: AvatarState) => void): () => void;
  };
  personas: {
    list(): Promise<PersonaRecord[]>;
    save(input: Omit<PersonaRecord, 'id' | 'userDefined'> & { id?: string }): Promise<PersonaRecord>;
    /** copy a persona's prompt/model/posture/tools onto an existing agent */
    applyTo(agentId: string, personaId: string): Promise<AgentRecord>;
    openFolder(): Promise<void>;
  };
  agents: {
    list(): Promise<AgentRecord[]>;
    create(input: {
      name: string;
      provider: TurnConfig['provider'];
      model?: string;
      posture?: AgentPosture;
      /** start from a persona: its prompt, model, posture and tools */
      personaId?: string;
    }): Promise<AgentRecord>;
    update(
      id: string,
      patch: Partial<Pick<AgentRecord, 'name' | 'model' | 'posture' | 'systemPrompt' | 'tools'>>,
    ): Promise<AgentRecord>;
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
