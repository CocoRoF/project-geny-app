/**
 * IPC registration — `domain:verbNoun`, one place, mirrors api-types.ts.
 * If a channel is not listed here it does not exist; the renderer cannot
 * reach main any other way (preload exposes only these).
 */
import { randomUUID } from 'node:crypto';
import type { BrowserWindow, IpcMain, Shell } from 'electron';
import type { AgentRecord, AppPaths } from '@shared/api-types';
import { defaultModel } from '@shared/models';
import { detectCli } from './cli-detect';
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
  agentsUpdate: 'agents:update',
  agentsRemove: 'agents:remove',
  secretsSet: 'secrets:setApiKey',
  secretsHas: 'secrets:hasApiKey',
  secretsClear: 'secrets:clearApiKey',
  secretsBackend: 'secrets:backend',
  cliDetect: 'cli:detect',
  mcpList: 'mcp:list',
  mcpAdd: 'mcp:add',
  mcpRemove: 'mcp:remove',
  mcpSetEnabled: 'mcp:setEnabled',
  mcpForAgent: 'mcp:forAgent',
  mcpSetForAgent: 'mcp:setForAgent',
  capabilitiesInspect: 'capabilities:inspect',
  chatHistory: 'chat:history',
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
    (
      _e,
      input: {
        name: string;
        provider: AgentRecord['provider'];
        model?: string;
        posture?: AgentRecord['posture'];
      },
    ) => {
      const id = randomUUID();
      const record: AgentRecord = {
        id,
        name: input.name.trim() || 'Agent',
        provider: input.provider,
        // never inherit the engine's default: its CLI model id does not
        // exist in the installed CLI, which hangs instead of erroring
        model: input.model?.trim() || defaultModel(input.provider),
        posture: input.posture ?? 'standard',
        dir: deps.agentDir(id),
        createdAt: Date.now(),
      };
      deps.store.agents.insert(record);
      return record;
    },
  );
  ipcMain.handle(
    CHANNELS.agentsUpdate,
    (_e, id: string, patch: Partial<Pick<AgentRecord, 'name' | 'model' | 'posture' | 'systemPrompt'>>) => {
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
    deps.secrets.set(`apiKey:${provider}`, '');
  });
  ipcMain.handle(CHANNELS.secretsBackend, () => deps.secrets.backend);
  // cached: the login-shell probe spawns a shell, which is slow enough to
  // notice if every render asked
  let cliCache: Promise<unknown> | null = null;
  ipcMain.handle(CHANNELS.cliDetect, () => {
    cliCache ??= detectCli('claude');
    return cliCache;
  });

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
