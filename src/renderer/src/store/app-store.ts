/**
 * One store, domain-sliced. Turn state is derived from the sidecar event
 * stream — the renderer never guesses what the engine is doing, it renders
 * what it was told, which is why a stuck turn is visible instead of silent.
 */
import { create } from 'zustand';
import type { AgentRecord, EngineStatus, StoredMessage } from '@shared/api-types';
import type { SidecarEvent } from '@shared/sidecar-protocol';

export interface ToolCard {
  toolUseId?: string;
  name: string;
  phase: 'start' | 'result' | 'error';
  payload?: unknown;
}

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  tools: ToolCard[];
  /** set once the turn closed; 'error' keeps the reason visible */
  outcome?: 'done' | 'cancelled' | 'error';
  error?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

export interface PendingPrompt {
  promptId: string;
  question: string;
  options: string[];
}

export interface PendingHitl {
  token: string;
  kind: string;
  detail: unknown;
}

interface AppState {
  engine: EngineStatus;
  agents: AgentRecord[];
  activeAgentId: string | null;
  entries: Record<string, ChatEntry[]>;
  activeTurn: string | null;
  prompt: PendingPrompt | null;
  hitl: PendingHitl | null;
  dataRoot: string;
  portable: boolean;

  setEngine(s: EngineStatus): void;
  setAgents(a: AgentRecord[]): void;
  selectAgent(id: string | null): void;
  setPaths(p: { dataRoot: string; portable: boolean }): void;
  hydrate(agentId: string, messages: StoredMessage[]): void;
  pushUser(agentId: string, text: string): void;
  beginTurn(agentId: string, turnId: string): void;
  applyEvent(e: SidecarEvent): void;
  answerPrompt(): void;
  clearHitl(): void;
}

const emptyEntries: ChatEntry[] = [];

export const useApp = create<AppState>((set, get) => ({
  engine: { state: 'stopped' },
  agents: [],
  activeAgentId: null,
  entries: {},
  activeTurn: null,
  prompt: null,
  hitl: null,
  dataRoot: '',
  portable: false,

  setEngine: (engine) => set({ engine }),
  setAgents: (agents) =>
    set((s) => ({ agents, activeAgentId: s.activeAgentId ?? agents[0]?.id ?? null })),
  selectAgent: (activeAgentId) => set({ activeAgentId }),
  setPaths: ({ dataRoot, portable }) => set({ dataRoot, portable }),

  hydrate: (agentId, messages) =>
    set((s) => {
      // only seed an empty pane — never clobber a live turn
      if ((s.entries[agentId] ?? []).length > 0) return s;
      return {
        entries: {
          ...s.entries,
          [agentId]: messages.map((m, i) => ({
            id: `h-${agentId}-${i}`,
            role: m.role,
            text: m.text,
            tools: [],
            outcome: m.role === 'assistant' ? ('done' as const) : undefined,
          })),
        },
      };
    }),

  pushUser: (agentId, text) =>
    set((s) => ({
      entries: {
        ...s.entries,
        [agentId]: [
          ...(s.entries[agentId] ?? emptyEntries),
          { id: `u-${Date.now()}`, role: 'user', text, tools: [] },
        ],
      },
    })),

  beginTurn: (agentId, turnId) =>
    set((s) => ({
      activeTurn: turnId,
      entries: {
        ...s.entries,
        [agentId]: [
          ...(s.entries[agentId] ?? emptyEntries),
          { id: turnId, role: 'assistant', text: '', tools: [] },
        ],
      },
    })),

  applyEvent: (event) => {
    const agentId = get().activeAgentId;
    if (!agentId) return;
    if (!('id' in event)) {
      if (event.type === 'ready') set({ engine: { ...get().engine, state: 'ready' } });
      return;
    }
    const turnId = event.id;

    const patch = (fn: (entry: ChatEntry) => ChatEntry): void =>
      set((s) => {
        const list = s.entries[agentId] ?? emptyEntries;
        const index = list.findIndex((e) => e.id === turnId);
        if (index < 0) return s;
        const next = [...list];
        next[index] = fn(next[index]!);
        return { entries: { ...s.entries, [agentId]: next } };
      });

    switch (event.type) {
      case 'chunk':
        patch((e) => ({ ...e, text: e.text + event.text }));
        break;
      case 'tool':
        patch((e) => {
          const tools = [...e.tools];
          const at = event.toolUseId
            ? tools.findIndex((t) => t.toolUseId === event.toolUseId)
            : -1;
          const card: ToolCard = {
            toolUseId: event.toolUseId,
            name: event.name,
            phase: event.phase,
            payload: event.payload,
          };
          if (at >= 0) tools[at] = { ...tools[at]!, ...card };
          else tools.push(card);
          return { ...e, tools };
        });
        break;
      case 'usage':
        patch((e) => ({
          ...e,
          usage: {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            costUsd: event.costUsd,
          },
        }));
        break;
      case 'prompt':
        set({ prompt: { promptId: event.promptId, question: event.question, options: event.options ?? [] } });
        break;
      case 'hitl_request':
        set({ hitl: { token: event.token, kind: event.kind, detail: event.detail } });
        break;
      case 'done':
        patch((e) => ({ ...e, outcome: 'done' }));
        set({ activeTurn: null });
        break;
      case 'cancelled':
        patch((e) => ({ ...e, outcome: 'cancelled' }));
        set({ activeTurn: null, prompt: null, hitl: null });
        break;
      case 'error':
        patch((e) => ({ ...e, outcome: 'error', error: event.error }));
        set({ activeTurn: null, prompt: null, hitl: null });
        break;
      default:
        break;
    }
  },

  answerPrompt: () => set({ prompt: null }),
  clearHitl: () => set({ hitl: null }),
}));
