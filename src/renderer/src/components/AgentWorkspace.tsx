import type { JSX } from 'react';
import { AgentConfig } from './AgentConfig';
import { ChatPane } from './ChatPane';
import { FilesTab } from './FilesTab';
import { useApp } from '../store/app-store';

/** The per-agent tabbed pane. Tabs are keep-alive by construction: Chat's
 *  transcript lives in the store, so switching to Config and back does not
 *  lose a running turn. */
export function AgentWorkspace(): JSX.Element {
  const agents = useApp((s) => s.agents);
  const activeId = useApp((s) => s.activeAgentId);
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const agent = agents.find((a) => a.id === activeId) ?? null;

  if (!agent) {
    return (
      <section className="flex flex-1 items-center justify-center text-sm text-dim">
        왼쪽에서 에이전트를 선택하거나 새로 만드세요.
      </section>
    );
  }

  const tabs = [
    { id: 'chat' as const, label: '대화' },
    { id: 'files' as const, label: '파일' },
    { id: 'config' as const, label: '설정' },
  ];

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-3">
        <span className="mr-2 text-sm font-medium">{agent.name}</span>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`border-b-2 px-2 py-2 text-xs ${
              tab === t.id
                ? 'border-accent text-accent'
                : 'border-transparent text-dim hover:text-fg'
            }`}
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-dim">
          {agent.provider}
          {agent.model ? ` · ${agent.model}` : ''}
        </span>
      </div>
      {tab === 'chat' && <ChatPane />}
      {tab === 'files' && <FilesTab agent={agent} />}
      {tab === 'config' && <AgentConfig agent={agent} />}
    </section>
  );
}
