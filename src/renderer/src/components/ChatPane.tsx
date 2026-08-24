import { useEffect, useRef, useState } from 'react';
import { type ChatEntry, useApp } from '../store/app-store';
import { ApiKeyGate } from './ApiKeyGate';
import { PromptDialog } from './PromptDialog';
import { ToolCardRow } from './ToolCardRow';
import type { JSX } from 'react';

const EMPTY: ChatEntry[] = [];

export function ChatPane(): JSX.Element {
  const agents = useApp((s) => s.agents);
  const activeId = useApp((s) => s.activeAgentId);
  // NOTE: never build a new array inside a zustand selector — `?? []`
  // returns a fresh reference every render and re-renders forever
  // (React #185). Select the stable slice, then fall back outside.
  const entryMap = useApp((s) => s.entries);
  const entries = (activeId ? entryMap[activeId] : undefined) ?? EMPTY;
  const activeTurn = useApp((s) => s.activeTurn);
  const pushUser = useApp((s) => s.pushUser);
  const hydrate = useApp((s) => s.hydrate);
  const beginTurn = useApp((s) => s.beginTurn);
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  const agent = agents.find((a) => a.id === activeId) ?? null;

  // a restarted app must show the conversation, not an empty pane
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void window.geny.chat.history(activeId).then((messages) => {
      if (!cancelled) hydrate(activeId, messages);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, hydrate]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, entries[entries.length - 1]?.text]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !agent || activeTurn) return;
    setDraft('');
    pushUser(agent.id, text);
    const { turnId } = await window.geny.chat.send({ agentId: agent.id, text });
    beginTurn(agent.id, turnId);
  };

  if (!agent) {
    return (
      <section className="flex flex-1 items-center justify-center text-sm text-dim">
        왼쪽에서 에이전트를 선택하거나 새로 만드세요.
      </section>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ApiKeyGate provider={agent.provider} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {entries.map((entry) => (
          <article key={entry.id} className="mb-4">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-dim">
              {entry.role === 'user' ? '나' : 'agent'}
            </div>
            {entry.delegations.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {entry.delegations.map((d, i) => (
                  <span
                    key={`${d.name}-${i}`}
                    className={`rounded border px-1.5 py-0.5 text-[10px] ${
                      d.phase === 'end'
                        ? 'border-emerald-500/30 text-emerald-300'
                        : 'border-amber-500/30 text-amber-300'
                    }`}
                    title="위임된 서브에이전트"
                  >
                    ⑂ {d.name}
                  </span>
                ))}
              </div>
            )}
            {entry.tools.length > 0 && (
              <div className="mb-2 flex flex-col gap-1">
                {entry.tools.map((tool, i) => (
                  <ToolCardRow key={`${tool.toolUseId ?? tool.name}-${i}`} tool={tool} />
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
              {entry.text}
              {entry.id === activeTurn && <span className="ml-0.5 animate-pulse">▍</span>}
            </div>
            {entry.outcome === 'error' && (
              <p className="mt-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                {entry.error}
              </p>
            )}
            {entry.outcome === 'cancelled' && (
              <p className="mt-1 text-[11px] text-dim">취소됨</p>
            )}
            {entry.usage && (
              <p className="mt-1 text-[10px] text-dim">
                in {entry.usage.inputTokens} · out {entry.usage.outputTokens}
                {entry.usage.costUsd ? ` · $${entry.usage.costUsd.toFixed(4)}` : ''}
              </p>
            )}
          </article>
        ))}
        <div ref={bottom} />
      </div>

      <PromptDialog />

      <div className="flex items-end gap-2 border-t border-line p-3">
        <textarea
          className="min-h-[44px] max-h-40 flex-1 resize-y rounded border border-line bg-black/30 px-3 py-2 text-[13px] outline-none focus:border-accent/60"
          placeholder={activeTurn ? '실행 중…' : '무엇을 시킬까요?  (Enter 전송 · Shift+Enter 줄바꿈)'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {activeTurn ? (
          <button
            type="button"
            className="rounded border border-line px-3 py-2 text-xs hover:bg-white/5"
            onClick={() => void window.geny.chat.cancel(activeTurn)}
          >
            중지
          </button>
        ) : (
          <button
            type="button"
            className="rounded border border-accent/60 px-3 py-2 text-xs text-accent hover:bg-accent/10 disabled:opacity-40"
            disabled={!draft.trim()}
            onClick={() => void send()}
          >
            전송
          </button>
        )}
      </div>
    </div>
  );
}
