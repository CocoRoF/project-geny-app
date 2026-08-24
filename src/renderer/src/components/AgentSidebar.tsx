import { useState } from 'react';
import type { AgentRecord } from '@shared/api-types';
import type { AgentPosture } from '@shared/sidecar-protocol';
import { useApp } from '../store/app-store';
import type { JSX } from 'react';

const PROVIDERS: Array<{ id: AgentRecord['provider']; label: string }> = [
  { id: 'anthropic', label: 'Anthropic API' },
  { id: 'openai', label: 'OpenAI API' },
  { id: 'claude_code_cli', label: 'Claude Code CLI' },
];

/** what the agent may do without asking — see engine/geny_app/policy.py */
const POSTURE_LABELS: Array<{ id: AgentPosture; label: string; hint: string }> = [
  { id: 'careful', label: '신중', hint: '파일 변경·셸 실행 모두 승인을 받습니다' },
  { id: 'standard', label: '표준', hint: '워크스페이스 안 편집은 허용, 셸은 승인' },
  { id: 'trusted', label: '신뢰', hint: '전부 허용 (워크스페이스 경계는 유지)' },
];

export function AgentSidebar(): JSX.Element {
  const agents = useApp((s) => s.agents);
  const activeId = useApp((s) => s.activeAgentId);
  const select = useApp((s) => s.selectAgent);
  const setAgents = useApp((s) => s.setAgents);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<AgentRecord['provider']>('anthropic');
  const [posture, setPosture] = useState<AgentPosture>('standard');

  const create = async (): Promise<void> => {
    const record = await window.geny.agents.create({ name, provider, posture });
    setAgents([record, ...agents]);
    select(record.id);
    setCreating(false);
    setName('');
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between px-3 py-2 text-[10px] uppercase tracking-widest text-dim">
        <span>에이전트</span>
        <button
          type="button"
          className="rounded border border-line px-1.5 text-[11px] hover:bg-white/5"
          onClick={() => setCreating((v) => !v)}
        >
          +
        </button>
      </div>

      {creating && (
        <div className="mx-2 mb-2 flex flex-col gap-1 rounded border border-line p-2">
          <input
            autoFocus
            className="rounded bg-black/40 px-2 py-1 text-xs outline-none"
            placeholder="이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
          <select
            className="rounded bg-black/40 px-2 py-1 text-xs"
            value={provider}
            onChange={(e) => setProvider(e.target.value as AgentRecord['provider'])}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            className="rounded bg-black/40 px-2 py-1 text-xs"
            value={posture}
            onChange={(e) => setPosture(e.target.value as AgentPosture)}
            title={POSTURE_LABELS.find((p) => p.id === posture)?.hint}
          >
            {POSTURE_LABELS.map((p) => (
              <option key={p.id} value={p.id}>
                권한: {p.label}
              </option>
            ))}
          </select>
          <p className="text-[10px] leading-snug text-dim">
            {POSTURE_LABELS.find((p) => p.id === posture)?.hint}
          </p>
          <button
            type="button"
            className="rounded border border-accent/60 px-2 py-1 text-xs text-accent hover:bg-accent/10"
            onClick={() => void create()}
          >
            만들기
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {agents.length === 0 && (
          <p className="px-3 py-2 text-[11px] leading-relaxed text-dim">
            에이전트가 없습니다. <b>+</b> 를 눌러 하나 만드세요. 각 에이전트는
            자기만의 워크스페이스 폴더를 갖습니다.
          </p>
        )}
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => select(agent.id)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${
              agent.id === activeId ? 'bg-accent/15 text-fg' : 'text-dim hover:bg-white/5'
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
            <span className="min-w-0 flex-1 truncate">{agent.name}</span>
            <span className="shrink-0 text-[10px] opacity-60">
              {agent.provider === 'claude_code_cli' ? 'cc' : agent.provider.slice(0, 3)}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
