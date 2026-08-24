/**
 * IPC registration — `domain:verbNoun`, one place, mirrors api-types.ts.
 * If a channel is not listed here it does not exist; the renderer cannot
 * reach main any other way (preload exposes only these).
 */
import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, Shell } from 'electron';
import type { AgentRecord, AppPaths } from '@shared/api-types';
import type { SidecarEvent } from '@shared/sidecar-protocol';
import type { Store } from './db';
import type { EngineService } from './engine-service';
import type { Layout } from './data-root';
import type { SecretStore } from './secrets';

export const CHANNELS = {
  appPaths: 'app:paths',
  appOpenPath: 'app:openPath',
  engineStatus: 'engine:status',
  engineStart: 'engine:start',
  engineStatusEvent: 'engine:statusEvent',
  agentsList: 'agents:list',
  agentsCreate: 'agents:create',
  agentsRemove: 'agents:remove',
  secretsSet: 'secrets:setApiKey',
  secretsHas: 'secrets:hasApiKey',
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  chatReplyPrompt: 'chat:replyPrompt',
  chatDecideHitl: 'chat:decideHitl',
  chatEvent: 'chat:event',
} as const;

export interface IpcDeps {
  ipcMain: IpcMain;
  shell: Pick<Shell, 'openPath'>;
  window(): BrowserWindow | null;
  store: Store;
  secrets: SecretStore;
  engine: EngineService;
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

  ipcMain.handle(CHANNELS.engineStatus, () => deps.engine.getStatus());
  ipcMain.handle(CHANNELS.engineStart, () => deps.engine.start());

  ipcMain.handle(CHANNELS.agentsList, () => deps.store.agents.list());
  ipcMain.handle(
    CHANNELS.agentsCreate,
    (_e, input: { name: string; provider: AgentRecord['provider']; model?: string }) => {
      const id = randomUUID();
      const record: AgentRecord = {
        id,
        name: input.name.trim() || 'Agent',
        provider: input.provider,
        model: input.model,
        dir: deps.agentDir(id),
        createdAt: Date.now(),
      };
      deps.store.agents.insert(record);
      return record;
    },
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
export function forwardEvent(window: BrowserWindow | null, event: SidecarEvent): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(CHANNELS.chatEvent, event);
}
