import { useState } from 'react';
import type { ToolCard } from '../store/app-store';
import type { JSX } from 'react';

const PHASE = {
  start: { icon: '▶', tone: 'text-amber-300 border-amber-500/30' },
  result: { icon: '✓', tone: 'text-emerald-300 border-emerald-500/30' },
  error: { icon: '✗', tone: 'text-red-300 border-red-500/30' },
} as const;

export function ToolCardRow({ tool }: { tool: ToolCard }): JSX.Element {
  const [open, setOpen] = useState(false);
  const phase = PHASE[tool.phase];
  return (
    <div className={`rounded border bg-black/20 ${phase.tone}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px]"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{phase.icon}</span>
        <span className="font-medium">{tool.name}</span>
        <span className="ml-auto opacity-50">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <pre className="max-h-56 overflow-auto border-t border-current/20 px-2 py-1 text-[10px] leading-relaxed opacity-80">
          {JSON.stringify(tool.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}
