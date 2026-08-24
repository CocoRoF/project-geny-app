/** The only bridge. Shapes must match @shared/api-types exactly. */
import { contextBridge, ipcRenderer } from 'electron';
import type { AgentRecord, EngineStatus, GenyApi } from '@shared/api-types';
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
  },
  engine: {
    status: () => ipcRenderer.invoke('engine:status'),
    start: () => ipcRenderer.invoke('engine:start'),
    onStatus: (cb) => subscribe<EngineStatus>('engine:statusEvent', cb),
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
