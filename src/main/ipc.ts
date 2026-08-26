/**
 * IPC registration — `domain:verbNoun`, one place, mirrors api-types.ts.
 * If a channel is not listed here it does not exist; the renderer cannot
 * reach main any other way (preload exposes only these).
 */
import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, Shell } from 'electron';
import type { AgentRecord, AppPaths } from '@shared/api-types';
import { defaultModel } from '@shared/models';
import { join } from 'node:path';
import { detectCli } from './cli-detect';
import { listDir, preview } from './fs-browse';
import type { SidecarEvent } from '@shared/sidecar-protocol';
import type { Store } from './db';
import type { AvatarController } from './avatar';
import type { VoiceService } from './voice/service';
import type { VoiceConfig } from '@shared/voice';
import { knowledgeDir, type KnowledgeStore } from './knowledge';
import { probeMcpServer } from './mcp-probe';
import { readMemory, readMemoryNote, readTranscript } from './memory-browser';
import { listPersonas, personaDir, savePersona } from './personas';
import type { EngineService } from './engine-service';
import type { Updater } from './updater';
import type { Layout } from './data-root';
import type { SecretStore } from './secrets';

export const CHANNELS = {
  appPaths: 'app:paths',
  appOpenPath: 'app:openPath',
  appQuickChat: 'app:quickChat',
  appHideQuickChat: 'app:hideQuickChat',
  appResizeQuickChat: 'app:resizeQuickChat',
  engineStatus: 'engine:status',
  engineStart: 'engine:start',
  engineStatusEvent: 'engine:statusEvent',
  knowledgeStats: 'knowledge:stats',
  knowledgeReindex: 'knowledge:reindex',
  knowledgeSearch: 'knowledge:search',
  knowledgeFolder: 'knowledge:openFolder',
  memoryOverview: 'memory:overview',
  memoryNote: 'memory:note',
  memoryTranscript: 'memory:transcript',
  memoryFolder: 'memory:openFolder',
  voiceConfig: 'voice:config',
  voiceSave: 'voice:save',
  voiceSetKey: 'voice:setKey',
  voiceHealth: 'voice:health',
  voiceVoices: 'voice:voices',
  voiceTranscribe: 'voice:transcribe',
  voiceSpeak: 'voice:speak',
  voiceAudioEvent: 'voice:audio',
  avatarList: 'avatar:list',
  avatarState: 'avatar:state',
  avatarSelect: 'avatar:select',
  avatarShow: 'avatar:show',
  avatarHide: 'avatar:hide',
  avatarToggle: 'avatar:toggle',
  avatarClickThrough: 'avatar:setClickThrough',
  avatarScale: 'avatar:setScale',
  avatarReset: 'avatar:resetPosition',
  avatarScaffold: 'avatar:scaffold',
  avatarFetchCore: 'avatar:fetchCubismCore',
  avatarFolder: 'avatar:openFolder',
  avatarStateEvent: 'avatar:stateEvent',
  personasList: 'personas:list',
  personasSave: 'personas:save',
  personasApply: 'personas:applyTo',
  personasFolder: 'personas:openFolder',
  agentsList: 'agents:list',
  agentsCreate: 'agents:create',
  agentsUpdate: 'agents:update',
  agentsRemove: 'agents:remove',
  secretsSet: 'secrets:setApiKey',
  secretsHas: 'secrets:hasApiKey',
  secretsClear: 'secrets:clearApiKey',
  secretsBackend: 'secrets:backend',
  cliDetect: 'cli:detect',
  mcpList: 'mcp:list',
  mcpTest: 'mcp:test',
  mcpAdd: 'mcp:add',
  mcpRemove: 'mcp:remove',
  mcpSetEnabled: 'mcp:setEnabled',
  mcpForAgent: 'mcp:forAgent',
  mcpSetForAgent: 'mcp:setForAgent',
  capabilitiesInspect: 'capabilities:inspect',
  filesList: 'files:list',
  filesPreview: 'files:preview',
  filesReveal: 'files:reveal',
  updateCheck: 'update:check',
  updateState: 'update:state',
  updateSetEnabled: 'update:setEnabled',
  updateInstallNow: 'update:installNow',
  hotkeysList: 'hotkeys:list',
  hotkeysSet: 'hotkeys:set',
  hotkeysReset: 'hotkeys:reset',
  hotkeysPause: 'hotkeys:pause',
  hotkeysResume: 'hotkeys:resume',
  systemAutostart: 'system:autostart',
  systemSetAutostart: 'system:setAutostart',
  systemLogs: 'system:logs',
  systemLogText: 'system:logText',
  systemClearLogs: 'system:clearLogs',
  systemCaptureSources: 'system:captureSources',
  systemCaptureSource: 'system:captureSource',
  systemSetCaptureSource: 'system:setCaptureSource',
  systemRestart: 'system:restart',
  computerStatus: 'computer:status',
  computerSave: 'computer:save',
  onboardingDone: 'onboarding:done',
  onboardingComplete: 'onboarding:complete',
  chatHistory: 'chat:history',
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatReplyPrompt: 'chat:replyPrompt',
  chatDecideHitl: 'chat:decideHitl',
  chatEvent: 'chat:event',
} as const;

export interface SystemDeps {
  hotkeys: {
    list(): { definitions: unknown[]; state: unknown[] };
    set(id: string, accelerator: string): unknown[];
    reset(): unknown[];
    pause(): void;
    resume(): unknown[];
  };
  autostart: {
    get(): boolean;
    set(enabled: boolean): { enabled: boolean; applied: boolean; reason?: string };
  };
  logs: { all(): unknown[]; text(): string; clear(): void };
  capture: {
    sources(): Promise<unknown[]>;
    get(): string | undefined;
    set(id: string | null): void;
  };
  computer: {
    status(): Promise<unknown>;
    save(patch: Record<string, unknown>): Promise<unknown>;
  };
  restart(): void;
}

export interface IpcDeps {
  system: SystemDeps;
  knowledge: KnowledgeStore;
  avatar: AvatarController;
  voice: VoiceService;
  showQuickChat(): void;
  hideQuickChat(): void;
  resizeQuickChat(height: number): void;
  ipcMain: IpcMain;
  shell: Pick<Shell, 'openPath'>;
  window(): BrowserWindow | null;
  store: Store;
  secrets: SecretStore;
  engine: EngineService;
  updater: Updater;
  layout: Layout;
  paths: AppPaths;
  agentDir(agentId: string): string;
}

export function registerIpc(deps: IpcDeps): void {
  const { ipcMain } = deps;
  const agentById = (id: string): AgentRecord => {
    const found = deps.store.agents.list().find((a) => a.id === id);
    if (!found) throw new Error(`unknown agent ${id}`);
    return found;
  };

  ipcMain.handle(CHANNELS.appPaths, () => deps.paths);
  ipcMain.handle(CHANNELS.appOpenPath, async (_e, p: string) => {
    await deps.shell.openPath(p);
  });
  ipcMain.handle(CHANNELS.appQuickChat, () => {
    deps.showQuickChat();
  });
  ipcMain.handle(CHANNELS.appHideQuickChat, () => {
    deps.hideQuickChat();
  });
  ipcMain.on(CHANNELS.appResizeQuickChat, (_e, height: number) => {
    deps.resizeQuickChat(height);
  });

  ipcMain.handle(CHANNELS.voiceConfig, () => deps.voice.config());
  ipcMain.handle(CHANNELS.voiceSave, (_e, config: VoiceConfig) => deps.voice.save(config));
  ipcMain.handle(CHANNELS.voiceSetKey, (_e, which: 'stt' | 'tts', key: string | null) =>
    deps.voice.setKey(which, key));
  ipcMain.handle(CHANNELS.voiceHealth, () => deps.voice.health());
  ipcMain.handle(CHANNELS.voiceVoices, (_e, force?: boolean) => deps.voice.voices(force === true));
  ipcMain.handle(CHANNELS.voiceTranscribe, async (_e, input: { base64: string; mime: string }) => ({
    text: await deps.voice.transcribe({
      audio: Buffer.from(input.base64, 'base64'),
      mime: input.mime,
    }),
  }));
  ipcMain.handle(CHANNELS.voiceSpeak, (_e, text: string) => deps.voice.speak(text));

  // listing re-inspects the folders, so it doubles as the refresh the
  // "다시 찾기" button needs — and it PUBLISHES, so an overlay that is
  // already open learns that a missing runtime has since been supplied
  ipcMain.handle(CHANNELS.avatarList, () => ({
    models: deps.avatar.models(),
    state: deps.avatar.refresh(),
  }));
  ipcMain.handle(CHANNELS.avatarState, () => deps.avatar.state());
  ipcMain.handle(CHANNELS.avatarSelect, (_e, modelId: string | null) => deps.avatar.select(modelId));
  ipcMain.handle(CHANNELS.avatarShow, () => deps.avatar.show());
  ipcMain.handle(CHANNELS.avatarHide, () => deps.avatar.hide());
  ipcMain.handle(CHANNELS.avatarToggle, () => deps.avatar.toggle());
  ipcMain.handle(CHANNELS.avatarClickThrough, (_e, enabled: boolean) =>
    deps.avatar.setClickThrough(enabled));
  ipcMain.handle(CHANNELS.avatarScale, (_e, scale: number) => deps.avatar.setScale(scale));
  ipcMain.handle(CHANNELS.avatarReset, () => deps.avatar.resetPosition());
  ipcMain.handle(CHANNELS.avatarScaffold, (_e, modelId: string) => {
    const result = deps.avatar.scaffold(modelId);
    return { ...result, models: deps.avatar.models(), state: deps.avatar.state() };
  });
  ipcMain.handle(CHANNELS.avatarFetchCore, async (_e, modelId: string) => {
    const result = await deps.avatar.fetchCore(modelId);
    return { ...result, models: deps.avatar.models(), state: deps.avatar.state() };
  });
  ipcMain.handle(CHANNELS.avatarFolder, async () => {
    await deps.shell.openPath(deps.avatar.folder());
  });

  const sys = deps.system;
  ipcMain.handle(CHANNELS.hotkeysList, () => sys.hotkeys.list());
  ipcMain.handle(CHANNELS.hotkeysSet, (_e, id: string, accelerator: string) =>
    sys.hotkeys.set(id, accelerator));
  ipcMain.handle(CHANNELS.hotkeysReset, () => sys.hotkeys.reset());
  ipcMain.handle(CHANNELS.hotkeysPause, () => {
    sys.hotkeys.pause();
  });
  ipcMain.handle(CHANNELS.hotkeysResume, () => sys.hotkeys.resume());

  ipcMain.handle(CHANNELS.systemAutostart, () => sys.autostart.get());
  ipcMain.handle(CHANNELS.systemSetAutostart, (_e, enabled: boolean) => sys.autostart.set(enabled));
  ipcMain.handle(CHANNELS.systemLogs, () => sys.logs.all());
  ipcMain.handle(CHANNELS.systemLogText, () => sys.logs.text());
  ipcMain.handle(CHANNELS.systemClearLogs, () => {
    sys.logs.clear();
  });
  ipcMain.handle(CHANNELS.systemCaptureSources, () => sys.capture.sources());
  ipcMain.handle(CHANNELS.systemCaptureSource, () => sys.capture.get());
  ipcMain.handle(CHANNELS.systemSetCaptureSource, (_e, id: string | null) => {
    sys.capture.set(id);
  });
  ipcMain.handle(CHANNELS.systemRestart, () => {
    sys.restart();
  });

  ipcMain.handle(CHANNELS.computerStatus, () => sys.computer.status());
  ipcMain.handle(CHANNELS.computerSave, (_e, patch: Record<string, unknown>) =>
    sys.computer.save(patch));

  ipcMain.handle(CHANNELS.engineStatus, () => deps.engine.getStatus());
  ipcMain.handle(CHANNELS.engineStart, () => deps.engine.start());

  ipcMain.handle(CHANNELS.knowledgeStats, () => deps.knowledge.stats());
  ipcMain.handle(CHANNELS.knowledgeReindex, () => deps.knowledge.reindex());
  ipcMain.handle(CHANNELS.knowledgeSearch, (_e, query: string) => deps.knowledge.search(query));
  ipcMain.handle(CHANNELS.knowledgeFolder, async () => {
    await deps.shell.openPath(knowledgeDir(deps.paths.dataRoot));
  });

  ipcMain.handle(CHANNELS.memoryOverview, (_e, agentId: string) =>
    readMemory(deps.agentDir(agentId)),
  );
  ipcMain.handle(CHANNELS.memoryNote, (_e, agentId: string, notePath: string) =>
    readMemoryNote(deps.agentDir(agentId), notePath),
  );
  ipcMain.handle(CHANNELS.memoryTranscript, (_e, agentId: string) =>
    readTranscript(deps.agentDir(agentId)),
  );
  ipcMain.handle(CHANNELS.memoryFolder, async (_e, agentId: string) => {
    await deps.shell.openPath(`${deps.agentDir(agentId)}/memory`);
  });

  ipcMain.handle(CHANNELS.personasList, () => listPersonas(deps.paths.dataRoot));
  ipcMain.handle(CHANNELS.personasSave, (_e, input: Parameters<typeof savePersona>[1]) =>
    savePersona(deps.paths.dataRoot, input),
  );
  ipcMain.handle(CHANNELS.personasFolder, async () => {
    await deps.shell.openPath(personaDir(deps.paths.dataRoot));
  });
  ipcMain.handle(CHANNELS.personasApply, (_e, agentId: string, personaId: string) => {
    const persona = listPersonas(deps.paths.dataRoot).find((p) => p.id === personaId);
    if (!persona) throw new Error(`unknown persona ${personaId}`);
    // a persona sets what it declares and leaves the rest alone — applying
    // "조사원" should not silently reset a model the user chose on purpose
    deps.store.agents.update(agentId, {
      systemPrompt: persona.prompt,
      ...(persona.model ? { model: persona.model } : {}),
      ...(persona.posture ? { posture: persona.posture } : {}),
      ...(persona.tools ? { tools: persona.tools } : {}),
    });
    const updated = deps.store.agents.get(agentId);
    if (!updated) throw new Error(`unknown agent ${agentId}`);
    deps.engine.refresh(updated);
    return updated;
  });

  ipcMain.handle(CHANNELS.agentsList, () => deps.store.agents.list());
  ipcMain.handle(
    CHANNELS.agentsCreate,
    (
      _e,
      input: {
        name: string;
        provider: AgentRecord['provider'];
        model?: string;
        posture?: AgentRecord['posture'];
        personaId?: string;
      },
    ) => {
      const id = randomUUID();
      // a persona seeds the agent; anything the caller passed explicitly
      // wins, because the user picking a model in the dialog means it
      const persona = input.personaId
        ? listPersonas(deps.paths.dataRoot).find((p) => p.id === input.personaId)
        : undefined;
      const record: AgentRecord = {
        id,
        name: input.name.trim() || persona?.name || 'Agent',
        provider: input.provider,
        // never inherit the engine's default: its CLI model id does not
        // exist in the installed CLI, which hangs instead of erroring
        model: input.model?.trim() || persona?.model || defaultModel(input.provider),
        posture: input.posture ?? persona?.posture ?? 'standard',
        systemPrompt: persona?.prompt,
        tools: persona?.tools,
        dir: deps.agentDir(id),
        createdAt: Date.now(),
      };
      deps.store.agents.insert(record);
      return record;
    },
  );
  ipcMain.handle(
    CHANNELS.agentsUpdate,
    (_e, id: string, patch: Partial<Pick<AgentRecord, 'name' | 'model' | 'posture' | 'systemPrompt' | 'tools'>>) => {
      deps.store.agents.update(id, patch);
      const updated = deps.store.agents.get(id);
      if (!updated) throw new Error(`unknown agent ${id}`);
      // config changes must reach a live session at the next turn boundary,
      // not the next app start
      deps.engine.refresh(updated);
      return updated;
    },
  );
  ipcMain.handle(CHANNELS.chatHistory, (_e, agentId: string) =>
    deps.store.messages.recent(agentId),
  );
  ipcMain.handle(CHANNELS.agentsRemove, (_e, id: string) => {
    deps.store.agents.remove(id);
  });

  ipcMain.handle(CHANNELS.secretsSet, (_e, provider: string, key: string) => {
    deps.secrets.set(`apiKey:${provider}`, key);
  });
  ipcMain.handle(CHANNELS.secretsHas, (_e, provider: string) =>
    deps.secrets.has(`apiKey:${provider}`),
  );

  ipcMain.handle(CHANNELS.secretsClear, (_e, provider: string) => {
    deps.secrets.remove(`apiKey:${provider}`);
  });
  ipcMain.handle(CHANNELS.secretsBackend, () => deps.secrets.backend);
  // cached: the login-shell probe spawns a shell, which is slow enough to
  // notice if every render asked
  let cliCache: Promise<unknown> | null = null;
  ipcMain.handle(CHANNELS.cliDetect, () => {
    cliCache ??= detectCli('claude');
    return cliCache;
  });

  // Try it before it is stored: a mistyped command otherwise reaches the
  // agent as a tool that is simply, silently, not there.
  ipcMain.handle(
    CHANNELS.mcpTest,
    (_e, input: { command: string; args?: string[]; env?: Record<string, string> }) =>
      probeMcpServer(input),
  );
  ipcMain.handle(CHANNELS.mcpList, () => deps.store.mcp.list());
  ipcMain.handle(
    CHANNELS.mcpAdd,
    (_e, input: { name: string; command: string; args?: string[]; env?: Record<string, string> }) => {
      const record = {
        id: randomUUID(),
        name: input.name.trim(),
        command: input.command.trim(),
        args: input.args ?? [],
        env: input.env ?? {},
        enabled: true,
        createdAt: Date.now(),
      };
      deps.store.mcp.insert(record);
      return record;
    },
  );
  ipcMain.handle(CHANNELS.mcpRemove, (_e, id: string) => {
    deps.store.mcp.remove(id);
  });
  ipcMain.handle(CHANNELS.mcpSetEnabled, (_e, id: string, enabled: boolean) => {
    deps.store.mcp.setEnabled(id, enabled);
  });
  ipcMain.handle(CHANNELS.mcpForAgent, (_e, agentId: string) => deps.store.mcp.forAgent(agentId));
  ipcMain.handle(CHANNELS.mcpSetForAgent, (_e, agentId: string, ids: string[]) => {
    deps.store.mcp.setForAgent(agentId, ids);
    // MCP servers are connected when the pipeline is built, so a change has
    // to evict the session rather than refresh it
    deps.engine.evict(agentId);
  });
  ipcMain.handle(CHANNELS.capabilitiesInspect, (_e, agentId: string) => deps.engine.inspect(agentId));

  // the agent's own folders are the only readable roots — the renderer
  // cannot widen this by sending a crafted path
  const agentRoots = (agentId: string): string[] => {
    const dir = deps.agentDir(agentId);
    return ['workspace', 'memory', 'artifacts', 'sessions'].map((sub) => join(dir, sub));
  };
  ipcMain.handle(CHANNELS.filesList, (_e, agentId: string, path?: string) =>
    listDir(path || join(deps.agentDir(agentId), 'workspace'), agentRoots(agentId)),
  );
  ipcMain.handle(CHANNELS.filesPreview, (_e, agentId: string, path: string) =>
    preview(path, agentRoots(agentId)),
  );
  ipcMain.handle(CHANNELS.filesReveal, async (_e, path: string) => {
    await deps.shell.openPath(path);
  });

  ipcMain.handle(CHANNELS.updateSetEnabled, (_e, enabled: boolean) => deps.updater.setEnabled(enabled));
  ipcMain.handle(CHANNELS.updateInstallNow, () => deps.updater.installNow());
  ipcMain.handle(CHANNELS.updateCheck, () => deps.updater.check());
  ipcMain.handle(CHANNELS.updateState, () => deps.updater.current);
  ipcMain.handle(CHANNELS.onboardingDone, () => deps.store.settings.get('onboarding.done') === '1');
  ipcMain.handle(CHANNELS.onboardingComplete, () => {
    deps.store.settings.set('onboarding.done', '1');
  });

  ipcMain.handle(CHANNELS.chatSend, async (_e, input: { agentId: string; text: string }) => {
    const agent = agentById(input.agentId);
    deps.store.messages.append({ agentId: agent.id, role: 'user', text: input.text });
    return deps.engine.send(agent, input.text);
  });
  ipcMain.handle(CHANNELS.chatCancel, (_e, turnId: string) => {
    deps.engine.cancel(turnId);
  });
  ipcMain.handle(CHANNELS.chatReplyPrompt, (_e, promptId: string, value: string | null) => {
    deps.engine.replyPrompt(promptId, value);
  });
  ipcMain.handle(
    CHANNELS.chatDecideHitl,
    (_e, token: string, decision: 'approve' | 'reject' | 'cancel') => {
      deps.engine.decideHitl(token, decision);
    },
  );
}

/** Push a sidecar event to the renderer (dropped silently when no window). */
/**
 * Push a sidecar event to every live surface.
 *
 * There is more than one window now (main + quick chat), and a turn started
 * in one is still the user's turn: sending only to the window that asked
 * would leave the other showing a conversation frozen mid-answer.
 */
export function forwardEvent(windows: Array<BrowserWindow | null>, event: SidecarEvent): void {
  for (const window of windows) {
    if (!window || window.isDestroyed()) continue;
    window.webContents.send(CHANNELS.chatEvent, event);
  }
}
