import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { AgentRecord, MemoryNote, MemoryOverview } from '@shared/api-types';

/**
 * What this agent remembers.
 *
 * Read-only on purpose: memory is the agent's own record, and an app that
 * quietly rewrites it makes the whole transcript untrustworthy. Editing is
 * one click away in the file manager, where it is obviously an edit.
 */
export function MemoryTab({ agent }: { agent: AgentRecord }): JSX.Element {
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [selected, setSelected] = useState<MemoryNote | null>(null);
  const [noteText, setNoteText] = useState<string>('');
  const [category, setCategory] = useState<string>('all');

  const load = (): void => {
    void window.geny.memory.overview(agent.id).then((next) => {
      setOverview(next);
      setSelected(null);
      setNoteText('');
    });
  };
  useEffect(load, [agent.id]);

  useEffect(() => {
    if (!selected) return;
    void window.geny.memory
      .note(agent.id, selected.path)
      .then((n) => setNoteText(n.text))
      .catch((e: Error) => setNoteText(`읽을 수 없습니다: ${e.message}`));
  }, [agent.id, selected]);

  if (!overview) return <div className="p-4 text-xs text-dim">읽는 중…</div>;

  const notes =
    category === 'all' ? overview.notes : overview.notes.filter((n) => n.category === category);
  const empty = !overview.longTerm && overview.notes.length === 0;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line">
        <div className="flex items-center gap-1 border-b border-line px-2 py-1.5 text-[11px]">
          <select
            className="min-w-0 flex-1 rounded bg-black/30 px-1 py-0.5"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="all">전체 ({overview.notes.length})</option>
            {overview.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} ({c.count})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded border border-line px-1.5 py-0.5 text-dim hover:text-fg"
            title="다시 읽기"
            onClick={load}
          >
            ↻
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {overview.longTerm && (
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setNoteText(overview.longTerm?.text ?? '');
              }}
              className={`w-full border-b border-line px-2 py-2 text-left text-xs ${
                selected === null && noteText ? 'bg-accent/15 text-accent' : 'text-fg hover:bg-white/5'
              }`}
            >
              <div className="font-medium">MEMORY.md</div>
              <div className="text-[10px] text-dim">장기 기억 · {overview.longTerm.bytes}B</div>
            </button>
          )}
          {notes.map((note) => (
            <button
              key={note.path}
              type="button"
              onClick={() => setSelected(note)}
              className={`w-full border-b border-line px-2 py-2 text-left text-xs ${
                selected?.path === note.path ? 'bg-accent/15 text-accent' : 'text-fg hover:bg-white/5'
              }`}
            >
              <div className="truncate font-medium">{note.title}</div>
              <div className="truncate text-[10px] text-dim">
                {note.category} · {new Date(note.modified).toLocaleString()}
              </div>
            </button>
          ))}
          {empty && (
            <p className="px-2 py-3 text-[11px] leading-relaxed text-dim">
              아직 기억이 없습니다. 대화를 나누면 에이전트가 요약과 메모를 여기에 남깁니다.
            </p>
          )}
        </div>

        <div className="border-t border-line px-2 py-1.5 text-[10px] text-dim">
          {overview.transcript && (
            <button
              type="button"
              className="mb-1 block w-full rounded border border-line px-1.5 py-1 text-left hover:text-fg"
              onClick={() => {
                setSelected(null);
                void window.geny.memory.transcript(agent.id).then((turns) => {
                  setNoteText(
                    turns
                      .map((t) => `[${t.index}] ${t.role}\n${t.text}`)
                      .join('\n\n') || '(빈 기록)',
                  );
                });
              }}
            >
              대화 기록 {overview.transcript.turns}턴 — 열기
            </button>
          )}
          <button
            type="button"
            className="mt-1 underline decoration-dotted hover:text-fg"
            onClick={() => void window.geny.memory.openFolder(agent.id)}
          >
            폴더 열기
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {noteText ? (
          <>
            {selected && (
              <div className="mb-2 border-b border-line pb-1 text-[11px] text-dim">
                {selected.path}
              </div>
            )}
            <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed">
              {noteText}
            </pre>
          </>
        ) : (
          <p className="text-xs text-dim">왼쪽에서 기억을 선택하세요.</p>
        )}
      </div>
    </div>
  );
}
