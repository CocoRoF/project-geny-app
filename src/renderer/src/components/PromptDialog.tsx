import { useState } from 'react';
import { useApp } from '../store/app-store';
import type { JSX } from 'react';

/** AskUserQuestion + HITL approval. Both round-trip through the sidecar, so
 *  an unanswered prompt visibly blocks the turn instead of timing out silently. */
export function PromptDialog(): JSX.Element | null {
  const prompt = useApp((s) => s.prompt);
  const hitl = useApp((s) => s.hitl);
  const answerPrompt = useApp((s) => s.answerPrompt);
  const clearHitl = useApp((s) => s.clearHitl);
  const [free, setFree] = useState('');

  if (hitl) {
    return (
      <div className="border-t border-amber-500/40 bg-amber-500/10 px-4 py-3">
        <p className="mb-2 text-xs">
          <b>승인 요청</b> — {hitl.kind}
        </p>
        <pre className="mb-2 max-h-32 overflow-auto rounded bg-black/30 p-2 text-[10px]">
          {JSON.stringify(hitl.detail, null, 2)}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border border-emerald-400/50 px-3 py-1 text-xs text-emerald-300"
            onClick={() => {
              void window.geny.chat.decideHitl(hitl.token, 'approve');
              clearHitl();
            }}
          >
            승인
          </button>
          <button
            type="button"
            className="rounded border border-red-400/50 px-3 py-1 text-xs text-red-300"
            onClick={() => {
              void window.geny.chat.decideHitl(hitl.token, 'reject');
              clearHitl();
            }}
          >
            거부
          </button>
        </div>
      </div>
    );
  }

  if (!prompt) return null;

  const reply = (value: string | null): void => {
    void window.geny.chat.replyPrompt(prompt.promptId, value);
    answerPrompt();
    setFree('');
  };

  return (
    <div className="border-t border-accent/40 bg-accent/10 px-4 py-3">
      <p className="mb-2 text-xs">
        <b>에이전트 질문</b> — {prompt.question}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {prompt.options.map((option) => (
          <button
            key={option}
            type="button"
            className="rounded border border-line px-2 py-1 text-xs hover:bg-white/10"
            onClick={() => reply(option)}
          >
            {option}
          </button>
        ))}
        <input
          className="min-w-[180px] flex-1 rounded bg-black/30 px-2 py-1 text-xs outline-none"
          placeholder="직접 답하기"
          value={free}
          onChange={(e) => setFree(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && free.trim()) reply(free.trim());
          }}
        />
        <button
          type="button"
          className="rounded border border-line px-2 py-1 text-xs text-dim hover:bg-white/5"
          onClick={() => reply(null)}
        >
          취소
        </button>
      </div>
    </div>
  );
}
