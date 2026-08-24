import type { JSX } from 'react';
import type { AgentRecord } from '@shared/api-types';
import { useEffect, useState } from 'react';
import type { CapabilityReport, McpServerRecord } from '@shared/api-types';
import { useApp } from '../store/app-store';

type Section = 'mcp' | 'capabilities' | 'folders' | 'knowledge' | 'pipeline';

/** Everything that is a registry: MCP servers, and what the engine actually
 *  loaded for the selected agent. The second half matters more than the
 *  first — "I configured it" and "the agent can use it" are different claims,
 *  and only the engine can answer the second. */
export function LibraryView(): JSX.Element {
  const [section, setSection] = useState<Section>('mcp');
  const agents = useApp((s) => s.agents);
  const activeId = useApp((s) => s.activeAgentId);
  const dataRoot = useApp((s) => s.dataRoot);
  const agent = agents.find((a) => a.id === activeId) ?? agents[0] ?? null;

  const sections: Array<{ id: Section; label: string }> = [
    { id: 'mcp', label: 'MCP 서버' },
    { id: 'capabilities', label: '로드된 기능' },
    { id: 'pipeline', label: '파이프라인' },
    { id: 'knowledge', label: '지식' },
    { id: 'folders', label: '스킬 · 명령어' },
  ];

  return (
    <div className="flex min-w-0 flex-1">
      <nav className="w-40 shrink-0 border-r border-line bg-panel py-2">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            className={`block w-full px-3 py-1.5 text-left text-xs ${
              section === s.id ? 'bg-accent/15 text-accent' : 'text-dim hover:text-fg'
            }`}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-4 text-xs">
        {section === 'mcp' && <McpSection agent={agent} />}
        {section === 'capabilities' && <CapabilitiesSection agent={agent} />}
        {section === 'pipeline' && <PipelineSection agent={agent} />}
        {section === 'knowledge' && <KnowledgeSection />}
        {section === 'folders' && <FoldersSection dataRoot={dataRoot} agentDir={agent?.dir} />}
      </div>
    </div>
  );
}

function McpSection({ agent }: { agent: { id: string; name: string } | null }): JSX.Element {
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState({ name: '', command: '', args: '' });
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    setServers(await window.geny.mcp.list());
    if (agent) {
      const mine = await window.geny.mcp.forAgent(agent.id);
      setEnabled(new Set(mine.map((s) => s.id)));
    }
  };
  useEffect(() => {
    void refresh();
  }, [agent?.id]);

  const add = async (): Promise<void> => {
    if (!draft.name.trim() || !draft.command.trim()) return;
    setBusy(true);
    try {
      await window.geny.mcp.add({
        name: draft.name,
        command: draft.command,
        args: draft.args.trim() ? draft.args.trim().split(/\s+/) : [],
      });
      setDraft({ name: '', command: '', args: '' });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string): Promise<void> => {
    if (!agent) return;
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setEnabled(next);
    await window.geny.mcp.setForAgent(agent.id, [...next]);
  };

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">서버 추가</h2>
        <div className="flex flex-wrap gap-2">
          <input
            className="w-32 rounded border border-line bg-black/30 px-2 py-1"
            placeholder="이름"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            className="w-40 rounded border border-line bg-black/30 px-2 py-1"
            placeholder="명령 (예: npx)"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          />
          <input
            className="min-w-[220px] flex-1 rounded border border-line bg-black/30 px-2 py-1"
            placeholder="인자 (공백 구분)"
            value={draft.args}
            onChange={(e) => setDraft({ ...draft, args: e.target.value })}
          />
          <button
            type="button"
            disabled={busy}
            className="rounded border border-accent/60 px-2 py-1 text-accent disabled:opacity-40"
            onClick={() => void add()}
          >
            추가
          </button>
        </div>
        <p className="mt-1 text-[11px] text-dim">
          서버는 엔진이 직접 띄웁니다. 에이전트에 켜면 다음 턴에 새로 연결됩니다.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">
          등록된 서버 {agent ? `— ${agent.name} 에 적용` : ''}
        </h2>
        {servers.length === 0 && <p className="text-dim">아직 없습니다.</p>}
        {servers.map((s) => (
          <div key={s.id} className="mb-1 flex items-center gap-2 rounded border border-line px-2 py-1.5">
            <input
              type="checkbox"
              disabled={!agent}
              checked={enabled.has(s.id)}
              onChange={() => void toggle(s.id)}
              title={agent ? '이 에이전트에서 사용' : '에이전트를 먼저 선택하세요'}
            />
            <span className="font-medium">{s.name}</span>
            <code className="truncate text-[11px] text-dim">
              {s.command} {s.args.join(' ')}
            </code>
            <button
              type="button"
              className="ml-auto rounded border border-red-400/40 px-2 py-0.5 text-[11px] text-red-300"
              onClick={() => void window.geny.mcp.remove(s.id).then(refresh)}
            >
              삭제
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

function CapabilitiesSection({ agent }: { agent: { id: string } | null }): JSX.Element {
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    if (!agent) return;
    setLoading(true);
    try {
      setReport(await window.geny.capabilities.inspect(agent.id));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [agent?.id]);

  if (!agent) return <p className="text-dim">에이전트를 먼저 선택하세요.</p>;

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        className="w-fit rounded border border-line px-2 py-1 hover:bg-white/5"
        onClick={() => void load()}
      >
        {loading ? '확인 중…' : '다시 확인'}
      </button>
      <p className="text-[11px] text-dim">
        설정이 아니라 <b>엔진이 실제로 로드한 것</b>입니다. 세션이 아직 만들어지지
        않았다면 비어 있고, 한 번 대화하면 채워집니다.
      </p>
      {report && (
        <>
          <section>
            <h3 className="mb-1 text-[10px] uppercase tracking-widest text-dim">
              도구 {report.tools.length}
            </h3>
            <div className="flex flex-wrap gap-1">
              {report.tools.map((t) => (
                <span key={t} className="rounded border border-line px-1.5 py-0.5 text-[11px]">
                  {t}
                </span>
              ))}
              {report.tools.length === 0 && <span className="text-dim">없음</span>}
            </div>
          </section>
          <section>
            <h3 className="mb-1 text-[10px] uppercase tracking-widest text-dim">MCP</h3>
            {report.mcpServers.length === 0 && <span className="text-dim">연결된 서버 없음</span>}
            {report.mcpServers.map((s) => (
              <p key={s.name} className={s.error ? 'text-red-300' : ''}>
                {s.name} — 도구 {s.tools}개{s.error ? ` · ${s.error}` : ''}
              </p>
            ))}
          </section>
          <section>
            <h3 className="mb-1 text-[10px] uppercase tracking-widest text-dim">스킬 · 슬래시</h3>
            <p className="text-dim">
              스킬 {report.skills.length}개
              {report.skills.length > 0 && `: ${report.skills.map((s) => s.name).join(', ')}`}
            </p>
            <p className="text-dim">
              명령어 {report.slashCommands.length}개
              {report.slashCommands.length > 0 && `: ${report.slashCommands.slice(0, 12).join(', ')}`}
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function FoldersSection({ dataRoot, agentDir }: { dataRoot: string; agentDir?: string }): JSX.Element {
  const rows = [
    { label: '전역 스킬', path: `${dataRoot}/skills`, hint: 'SKILL.md 를 폴더째 넣으면 모든 에이전트가 씁니다' },
    { label: '전역 명령어', path: `${dataRoot}/commands`, hint: '슬래시 명령어 정의' },
    ...(agentDir
      ? [
          { label: '이 에이전트 스킬', path: `${agentDir}/skills`, hint: '같은 이름이면 전역보다 우선합니다' },
          { label: '이 에이전트 명령어', path: `${agentDir}/commands`, hint: '' },
        ]
      : []),
  ];
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.path} className="rounded border border-line p-2">
          <div className="flex items-center gap-2">
            <b>{r.label}</b>
            <button
              type="button"
              className="ml-auto rounded border border-line px-2 py-0.5 text-[11px] hover:bg-white/5"
              onClick={() => void window.geny.app.openPath(r.path)}
            >
              열기
            </button>
          </div>
          <p className="break-all text-[11px] text-dim">{r.path}</p>
          {r.hint && <p className="text-[11px] text-dim">{r.hint}</p>}
        </div>
      ))}
    </div>
  );
}


/**
 * The knowledge folder and its index.
 *
 * The index is derived data — rebuilding is cheap and always safe — so the
 * panel offers it plainly instead of trying to detect staleness. Skipped
 * files are listed: a document the user expected to be searchable and is not
 * is the failure that matters here.
 */
function KnowledgeSection(): JSX.Element {
  const [stats, setStats] = useState<{ documents: number; chunks: number } | null>(null);
  const [report, setReport] = useState<Awaited<ReturnType<typeof window.geny.knowledge.reindex>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Awaited<ReturnType<typeof window.geny.knowledge.search>>>([]);

  useEffect(() => {
    void window.geny.knowledge.stats().then(setStats);
  }, []);

  const reindex = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await window.geny.knowledge.reindex();
      setReport(next);
      setStats({ documents: next.documents, chunks: next.chunks });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 text-xs">
      <p className="leading-relaxed text-dim">
        <b className="text-fg">지식</b> 폴더에 문서를 넣으면 에이전트가
        <code className="mx-1 rounded bg-black/30 px-1">KnowledgeSearch</code>
        로 찾아 읽습니다. 로컬 색인이라 API 호출도, 비용도 없습니다.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-dim">
          {stats ? `문서 ${stats.documents}개 · 조각 ${stats.chunks}개` : '읽는 중…'}
        </span>
        <button
          type="button"
          className="rounded border border-accent/60 px-2 py-1 text-accent hover:bg-accent/10 disabled:opacity-40"
          disabled={busy}
          onClick={() => void reindex()}
        >
          {busy ? '색인 중…' : '다시 색인'}
        </button>
        <button
          type="button"
          className="rounded border border-line px-2 py-1 text-dim hover:text-fg"
          onClick={() => void window.geny.knowledge.openFolder()}
        >
          폴더 열기
        </button>
      </div>

      {report && report.skipped.length > 0 && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2">
          <p className="mb-1">색인하지 못한 파일 {report.skipped.length}개</p>
          <ul className="text-[11px] text-dim">
            {report.skipped.slice(0, 8).map((s) => (
              <li key={s.path}>
                {s.path} — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-line bg-black/30 px-2 py-1 outline-none"
          placeholder="검색해서 확인해 보세요"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void window.geny.knowledge.search(query).then(setHits);
          }}
        />
        <button
          type="button"
          className="rounded border border-line px-2 py-1 text-dim hover:text-fg"
          onClick={() => void window.geny.knowledge.search(query).then(setHits)}
        >
          검색
        </button>
      </div>

      {hits.map((hit) => (
        <div key={hit.path} className="rounded border border-line p-2">
          <div className="font-medium">{hit.title}</div>
          <div className="text-[10px] text-dim">{hit.path}</div>
          <p className="mt-1 leading-relaxed text-dim">{hit.snippet}</p>
        </div>
      ))}
    </div>
  );
}


/**
 * The 21 stages, as the engine actually configured them for this agent.
 *
 * Not decoration: reading this is how a null HITL requester and a dropped
 * guard chain were found — both were invisible until someone looked at what
 * the pipeline really contained rather than what the config said.
 */
function PipelineSection({ agent }: { agent: AgentRecord | null }): JSX.Element {
  const [report, setReport] = useState<Awaited<ReturnType<typeof window.geny.capabilities.inspect>> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    if (!agent) return;
    setBusy(true);
    try {
      setReport(await window.geny.capabilities.inspect(agent.id));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [agent?.id]);

  if (!agent) return <p className="text-xs text-dim">에이전트를 먼저 선택하세요.</p>;
  const stages = report?.stages ?? [];

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-dim">
          {stages.length > 0 ? `${stages.length}개 단계` : '아직 읽지 못했습니다'}
        </span>
        <button
          type="button"
          className="rounded border border-line px-2 py-1 text-dim hover:text-fg"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? '읽는 중…' : '다시 읽기'}
        </button>
      </div>

      {stages.length === 0 && (
        <p className="leading-relaxed text-dim">
          파이프라인은 첫 대화에서 만들어집니다. 한 번 이야기한 뒤 다시 읽어보세요.
        </p>
      )}

      {stages.map((stage) => (
        <div
          key={`${stage.order}-${stage.name}`}
          className={`rounded border p-2 ${stage.active ? 'border-line' : 'border-line/40 opacity-50'}`}
        >
          <div className="flex items-baseline gap-2">
            <span className="w-5 text-right tabular-nums text-dim">{stage.order}</span>
            <span className="font-medium">{stage.name}</span>
            {stage.category && <span className="text-[10px] text-dim">{stage.category}</span>}
            {!stage.active && <span className="text-[10px] text-dim">비활성</span>}
          </div>
          {stage.strategies.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1 pl-7">
              {stage.strategies.map((slot) => (
                <span
                  key={slot.slot}
                  className="rounded border border-line px-1.5 py-0.5 text-[10px]"
                  title={
                    slot.available.length > 1
                      ? `선택 가능: ${slot.available.join(', ')}`
                      : undefined
                  }
                >
                  {slot.slot}: <b className="text-accent">{slot.current ?? '없음'}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
