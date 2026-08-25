/** The only bridge. Shapes must match @shared/api-types exactly. */
import { contextBridge, ipcRenderer } from 'electron';
import type { AgentRecord, AvatarState, EngineStatus, GenyApi } from '@shared/api-types';
import type { SpokenAudio } from '@shared/voice';
import type { SidecarEvent } from '@shared/sidecar-protocol';

const subscribe = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const handler = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const api: GenyApi = {
  app: {
    paths: () => ipcRenderer.invoke('app:paths'),
    openPath: (p) => ipcRenderer.invoke('app:openPath', p),
    quickChat: () => ipcRenderer.invoke('app:quickChat'),
    hideQuickChat: () => ipcRenderer.invoke('app:hideQuickChat'),
  },
  engine: {
    status: () => ipcRenderer.invoke('engine:status'),
    start: () => ipcRenderer.invoke('engine:start'),
    onStatus: (cb) => subscribe<EngineStatus>('engine:statusEvent', cb),
  },
  knowledge: {
    stats: () => ipcRenderer.invoke('knowledge:stats'),
    reindex: () => ipcRenderer.invoke('knowledge:reindex'),
    search: (query) => ipcRenderer.invoke('knowledge:search', query),
    openFolder: () => ipcRenderer.invoke('knowledge:openFolder'),
  },
  memory: {
    overview: (agentId) => ipcRenderer.invoke('memory:overview', agentId),
    note: (agentId, path) => ipcRenderer.invoke('memory:note', agentId, path),
    transcript: (agentId) => ipcRenderer.invoke('memory:transcript', agentId),
    openFolder: (agentId) => ipcRenderer.invoke('memory:openFolder', agentId),
  },
  voice: {
    config: () => ipcRenderer.invoke('voice:config'),
    save: (config) => ipcRenderer.invoke('voice:save', config),
    setKey: (which, key) => ipcRenderer.invoke('voice:setKey', which, key),
    health: () => ipcRenderer.invoke('voice:health'),
    voices: (force) => ipcRenderer.invoke('voice:voices', force),
    transcribe: (input) => ipcRenderer.invoke('voice:transcribe', input),
    speak: (text) => ipcRenderer.invoke('voice:speak', text),
    onAudio: (cb) => subscribe<SpokenAudio>('voice:audio', cb),
  },
  avatar: {
    list: () => ipcRenderer.invoke('avatar:list'),
    state: () => ipcRenderer.invoke('avatar:state'),
    select: (modelId) => ipcRenderer.invoke('avatar:select', modelId),
    show: () => ipcRenderer.invoke('avatar:show'),
    hide: () => ipcRenderer.invoke('avatar:hide'),
    toggle: () => ipcRenderer.invoke('avatar:toggle'),
    setClickThrough: (enabled) => ipcRenderer.invoke('avatar:setClickThrough', enabled),
    setScale: (scale) => ipcRenderer.invoke('avatar:setScale', scale),
    scaffold: (modelId) => ipcRenderer.invoke('avatar:scaffold', modelId),
    openFolder: () => ipcRenderer.invoke('avatar:openFolder'),
    onState: (cb) => subscribe<AvatarState>('avatar:stateEvent', cb),
  },
  personas: {
    list: () => ipcRenderer.invoke('personas:list'),
    save: (input) => ipcRenderer.invoke('personas:save', input),
    applyTo: (agentId, personaId) => ipcRenderer.invoke('personas:applyTo', agentId, personaId),
    openFolder: () => ipcRenderer.invoke('personas:openFolder'),
  },
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    create: (input) => ipcRenderer.invoke('agents:create', input) as Promise<AgentRecord>,
    update: (id, patch) => ipcRenderer.invoke('agents:update', id, patch) as Promise<AgentRecord>,
    remove: (id) => ipcRenderer.invoke('agents:remove', id),
  },
  secrets: {
    setApiKey: (provider, key) => ipcRenderer.invoke('secrets:setApiKey', provider, key),
    hasApiKey: (provider) => ipcRenderer.invoke('secrets:hasApiKey', provider),
    clearApiKey: (provider) => ipcRenderer.invoke('secrets:clearApiKey', provider),
    backend: () => ipcRenderer.invoke('secrets:backend'),
  },
  cli: {
    detect: () => ipcRenderer.invoke('cli:detect'),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (input) => ipcRenderer.invoke('mcp:add', input),
    remove: (id) => ipcRenderer.invoke('mcp:remove', id),
    setEnabled: (id, enabled) => ipcRenderer.invoke('mcp:setEnabled', id, enabled),
    forAgent: (agentId) => ipcRenderer.invoke('mcp:forAgent', agentId),
    setForAgent: (agentId, ids) => ipcRenderer.invoke('mcp:setForAgent', agentId, ids),
  },
  capabilities: {
    inspect: (agentId) => ipcRenderer.invoke('capabilities:inspect', agentId),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    state: () => ipcRenderer.invoke('update:state'),
  },
  onboarding: {
    done: () => ipcRenderer.invoke('onboarding:done'),
    complete: () => ipcRenderer.invoke('onboarding:complete'),
  },
  files: {
    list: (agentId, path) => ipcRenderer.invoke('files:list', agentId, path),
    preview: (agentId, path) => ipcRenderer.invoke('files:preview', agentId, path),
    reveal: (path) => ipcRenderer.invoke('files:reveal', path),
  },
  chat: {
    history: (agentId) => ipcRenderer.invoke('chat:history', agentId),
    send: (input) => ipcRenderer.invoke('chat:send', input),
    cancel: (turnId) => ipcRenderer.invoke('chat:cancel', turnId),
    replyPrompt: (promptId, value) => ipcRenderer.invoke('chat:replyPrompt', promptId, value),
    decideHitl: (token, decision) => ipcRenderer.invoke('chat:decideHitl', token, decision),
    onEvent: (cb) => subscribe<SidecarEvent>('chat:event', cb),
  },
};

contextBridge.exposeInMainWorld('geny', api);
