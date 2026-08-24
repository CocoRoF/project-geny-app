import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { AgentRecord, CliInfo } from '@shared/api-types';
import { MODELS } from '@shared/models';
import type { AgentPosture } from '@shared/sidecar-protocol';
import { POSTURES } from '@shared/sidecar-protocol';
import { useApp } from '../store/app-store';

const POSTURE_TEXT: Record<AgentPosture, string> = {
  careful: '파일 변경과 셸 실행 모두 승인을 받습니다',
  standard: '워크스페이스 안 편집은 허용, 셸 실행은 승인',
  trusted: '전부 허용 — 워크스페이스 경계는 그대로 유지됩니다',
};

/** Per-agent settings. Changes reach a live session at its next turn
 *  boundary (main calls engine.refresh), not at the next app start. */
export function AgentConfig({ agent }: { agent: AgentRecord }): JSX.Element {
  const patchAgent = useApp((s) => s.patchAgent);
  const [prompt, setPrompt] = useState(agent.systemPrompt ?? '');
  const [saved, setSaved] = useState(false);
  const [cli, setCli] = useState<CliInfo | null>(null);

  useEffect(() => setPrompt(agent.systemPrompt ?? ''), [agent.id, agent.systemPrompt]);
  useEffect(() => {
    if (agent.provider === 'claude_code_cli') void window.geny.cli.detect().then(setCli);
  }, [agent.provider]);

  const apply = async (patch: Parameters<typeof window.geny.agents.update>[1]): Promise<void> => {
    const next = await window.geny.agents.update(agent.id, patch);
    patchAgent(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4 text-xs">
      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">모델</h2>
        <select
          className="w-full max-w-sm rounded border border-line bg-black/30 px-2 py-1.5"
          value={agent.model ?? ''}
          onChange={(e) => void apply({ model: e.target.value })}
        >
          {MODELS[agent.provider].map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.hint ? ` — ${m.hint}` : ''}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-dim">
          백엔드: {agent.provider}
          {agent.provider === 'claude_code_cli' && cli && (
            <>
              {' · '}
              {cli.found ? (
                <span className="text-emerald-300">
                  CLI {cli.version} ({cli.via})
                </span>
              ) : (
                <span className="text-red-300">CLI 없음 — {cli.error}</span>
              )}
            </>
          )}
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">권한</h2>
        <div className="flex flex-col gap-1">
          {POSTURES.map((p) => (
            <label key={p} className="flex items-start gap-2">
              <input
                type="radio"
                className="mt-0.5"
                checked={agent.posture === p}
                onChange={() => void apply({ posture: p })}
              />
              <span>
                <b>{p === 'careful' ? '신중' : p === 'standard' ? '표준' : '신뢰'}</b>
                <span className="ml-2 text-dim">{POSTURE_TEXT[p]}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-dim">
          도구가 실행되는 위치는 백엔드마다 다릅니다. API 백엔드는 엔진 안에서 실행되어
          워크스페이스 경로 감옥이 적용되고, Claude Code CLI 는 자기 프로세스에서 실행되어
          워크스페이스를 작업 폴더로 받습니다.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">시스템 프롬프트</h2>
        <textarea
          className="h-28 w-full resize-y rounded border border-line bg-black/30 px-2 py-1.5 leading-relaxed"
          placeholder="이 에이전트의 역할·규칙을 적으세요 (비워두면 기본값)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button
          type="button"
          className="mt-1 rounded border border-accent/60 px-2 py-1 text-accent hover:bg-accent/10"
          onClick={() => void apply({ systemPrompt: prompt })}
        >
          저장
        </button>
        {saved && <span className="ml-2 text-emerald-300">적용됨</span>}
      </section>

      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">폴더</h2>
        <div className="flex flex-wrap gap-2">
          {(['workspace', 'memory', 'artifacts', 'sessions'] as const).map((sub) => (
            <button
              key={sub}
              type="button"
              className="rounded border border-line px-2 py-1 text-dim hover:text-fg"
              onClick={() => void window.geny.app.openPath(`${agent.dir}/${sub}`)}
            >
              {sub}
            </button>
          ))}
        </div>
        <p className="mt-1 break-all text-[11px] text-dim">{agent.dir}</p>
      </section>
    </div>
  );
}
