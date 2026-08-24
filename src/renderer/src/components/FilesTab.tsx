import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { AgentRecord, DirEntry, FilePreview } from '@shared/api-types';

const ROOTS = ['workspace', 'artifacts', 'memory', 'sessions'] as const;
type Root = (typeof ROOTS)[number];

const HUMAN = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** What the agent produced. Reads the agent's own folders through IPC — the
 *  same jail the tools write into, so this shows exactly what the agent can
 *  reach and nothing else. */
export function FilesTab({ agent }: { agent: AgentRecord }): JSX.Element {
  const [root, setRoot] = useState<Root>('workspace');
  const [dir, setDir] = useState<string>(`${agent.dir}/workspace`);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [selected, setSelected] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (path: string) => {
      setError(null);
      try {
        setEntries(await window.geny.files.list(agent.id, path));
        setDir(path);
      } catch (e) {
        setEntries([]);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [agent.id],
  );

  useEffect(() => {
    setSelected(null);
    void load(`${agent.dir}/${root}`);
  }, [agent.dir, agent.id, root, load]);

  const open = async (entry: DirEntry): Promise<void> => {
    if (entry.isDir) {
      setSelected(null);
      await load(entry.path);
      return;
    }
    try {
      setSelected(await window.geny.files.preview(agent.id, entry.path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const atRoot = dir === `${agent.dir}/${root}`;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="flex gap-1 border-b border-line p-2">
          {ROOTS.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRoot(r)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                root === r ? 'bg-accent/20 text-accent' : 'text-dim hover:text-fg'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 border-b border-line px-2 py-1 text-[11px] text-dim">
          {!atRoot && (
            <button
              type="button"
              className="rounded border border-line px-1.5 hover:text-fg"
              onClick={() => void load(dir.slice(0, dir.lastIndexOf('/')))}
            >
              ↑
            </button>
          )}
          <span className="truncate" title={dir}>
            {dir.replace(agent.dir, '')}
          </span>
          <button
            type="button"
            className="ml-auto shrink-0 hover:text-fg"
            title="파일 관리자로 열기"
            onClick={() => void window.geny.files.reveal(dir)}
          >
            ⧉
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && <p className="px-2 py-2 text-[11px] text-red-300">{error}</p>}
          {!error && entries.length === 0 && (
            <p className="px-2 py-2 text-[11px] text-dim">비어 있습니다.</p>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => void open(entry)}
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-white/5 ${
                selected?.path === entry.path ? 'bg-accent/10 text-accent' : ''
              }`}
            >
              <span className="w-3 shrink-0 text-dim">{entry.isDir ? '▸' : '·'}</span>
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {!entry.isDir && <span className="shrink-0 text-dim">{HUMAN(entry.size)}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-auto p-3">
        {!selected && <p className="text-[11px] text-dim">파일을 선택하면 내용을 보여줍니다.</p>}
        {selected && (
          <>
            <div className="mb-2 flex items-center gap-2 text-[11px] text-dim">
              <span className="truncate">{selected.path.replace(agent.dir, '')}</span>
              <span>· {HUMAN(selected.size)}</span>
              {selected.truncated && <span className="text-amber-300">· 앞부분만 표시</span>}
              <button
                type="button"
                className="ml-auto rounded border border-line px-2 py-0.5 hover:text-fg"
                onClick={() => void window.geny.files.reveal(selected.path)}
              >
                외부에서 열기
              </button>
            </div>
            {selected.kind === 'text' && (
              <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                {selected.content}
              </pre>
            )}
            {selected.kind === 'image' && (
              <img src={selected.content} alt="" className="max-h-full max-w-full object-contain" />
            )}
            {selected.kind === 'binary' && (
              <p className="text-[11px] text-dim">미리보기를 지원하지 않는 형식입니다.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
