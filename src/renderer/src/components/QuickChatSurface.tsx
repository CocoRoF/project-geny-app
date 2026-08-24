import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store/app-store';

/**
 * The quick-chat strip: one input, one answer, no chrome.
 *
 * It talks to the same engine and the same agents as the main window — a
 * turn started here shows up there and vice versa, because main forwards
 * events to every surface. Deliberately does NOT reimplement the transcript:
 * anything worth keeping is already in the main window.
 */
export function QuickChatSurface(): JSX.Element {
  const agents = useApp((s) => s.agents);
  const activeId = useApp((s) => s.activeAgentId);
  const selectAgent = useApp((s) => s.selectAgent);
  const entryMap = useApp((s) => s.entries);
  const activeTurn = useApp((s) => s.activeTurn);
  const pushUser = useApp((s) => s.pushUser);
  const beginTurn = useApp((s) => s.beginTurn);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);

  const agent = agents.find((a) => a.id === activeId) ?? agents[0] ?? null;
  const entries = (agent ? entryMap[agent.id] : undefined) ?? [];
  const last = entries[entries.length - 1];

  useEffect(() => {
    input.current?.focus();
    // Esc dismisses. The window also hides on blur, so this is for the case
    // where it still has focus and the user wants it gone.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void window.geny.app.hideQuickChat();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !agent || activeTurn) return;
    setDraft('');
    pushUser(agent.id, text);
    const { turnId } = await window.geny.chat.send({ agentId: agent.id, text });
    beginTurn(agent.id, turnId);
  };

  return (
    <div className="flex h-full flex-col bg-bg/95">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11px]">
        <span className="font-semibold">Geny</span>
        {agents.length > 1 ? (
          <select
            className="rounded bg-black/30 px-1 py-0.5 text-[11px]"
            value={agent?.id ?? ''}
            onChange={(e) => selectAgent(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-dim">{agent?.name ?? '에이전트 없음'}</span>
        )}
        <span className="ml-auto text-dim">Esc 닫기</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[13px] leading-relaxed">
        {!agent && <p className="text-dim">먼저 본 창에서 에이전트를 하나 만드세요.</p>}
        {last?.role === 'assistant' && (
          <>
            {last.tools.length > 0 && (
              <p className="mb-1 text-[11px] text-dim">
                {last.tools.map((t) => t.name).join(' · ')}
              </p>
            )}
            <div className="whitespace-pre-wrap break-words">
              {last.text}
              {last.id === activeTurn && <span className="ml-0.5 animate-pulse">▍</span>}
            </div>
            {last.outcome === 'error' && (
              <p className="mt-1 text-[11px] text-red-300">{last.error}</p>
            )}
          </>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-line p-2">
        <textarea
          ref={input}
          rows={2}
          className="min-h-[38px] flex-1 resize-none rounded border border-line bg-black/30 px-2 py-1.5 text-[13px] outline-none focus:border-accent/60"
          placeholder={activeTurn ? '실행 중…' : '무엇을 시킬까요?'}
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
            className="rounded border border-line px-2 py-1.5 text-xs"
            onClick={() => void window.geny.chat.cancel(activeTurn)}
          >
            중지
          </button>
        ) : (
          <button
            type="button"
            className="rounded border border-accent/60 px-2 py-1.5 text-xs text-accent disabled:opacity-40"
            disabled={!draft.trim() || !agent}
            onClick={() => void send()}
          >
            전송
          </button>
        )}
      </div>
    </div>
  );
}
