import { useApp } from '../store/app-store';
import type { JSX } from 'react';

/** The engine's real state, always visible. A desktop app that hides why the
 *  agent is not answering is the thing this banner exists to prevent. */
export function EngineBanner(): JSX.Element {
  const engine = useApp((s) => s.engine);
  const dataRoot = useApp((s) => s.dataRoot);
  const portable = useApp((s) => s.portable);

  const tone =
    engine.state === 'ready'
      ? 'text-emerald-300'
      : engine.state === 'failed'
        ? 'text-red-300'
        : 'text-dim';

  return (
    <header className="flex items-center gap-3 border-b border-line bg-panel px-3 py-1.5 text-[11px]">
      <span className="font-semibold tracking-wide">Geny</span>
      <span className={tone}>
        engine: {engine.state}
        {engine.engine ? ` · executor ${engine.engine}` : ''}
        {engine.python ? ` · py ${engine.python}` : ''}
        {engine.runtime ? ` · ${engine.runtime.source}` : ''}
      </span>
      {engine.error && <span className="truncate text-red-300">{engine.error}</span>}
      {engine.state === 'failed' && (
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 hover:bg-white/5"
          onClick={() => void window.geny.engine.start()}
        >
          다시 시작
        </button>
      )}
      <span className="ml-auto flex items-center gap-2 text-dim">
        <button
          type="button"
          className="underline decoration-dotted hover:text-fg"
          title={dataRoot}
          onClick={() => void window.geny.app.openPath(dataRoot)}
        >
          {portable ? '포터블 데이터' : '데이터 폴더'}
        </button>
      </span>
    </header>
  );
}
