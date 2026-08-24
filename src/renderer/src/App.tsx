import { useEffect, useState } from 'react';
import { AgentSidebar } from './components/AgentSidebar';
import { AgentWorkspace } from './components/AgentWorkspace';
import { EngineBanner } from './components/EngineBanner';
import { LibraryView } from './components/LibraryView';
import { Onboarding } from './components/Onboarding';
import { QuickChatSurface } from './components/QuickChatSurface';
import { SettingsView } from './components/SettingsView';
import { useApp } from './store/app-store';
import type { JSX } from 'react';

function ActivityRail(): JSX.Element {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const items = [
    { id: 'agents' as const, glyph: '◆', label: '에이전트' },
    { id: 'library' as const, glyph: '⌘', label: '라이브러리 — MCP · 스킬 · 도구' },
    { id: 'settings' as const, glyph: '⚙', label: '설정' },
  ];
  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          title={item.label}
          onClick={() => setView(item.id)}
          className={`flex h-9 w-9 items-center justify-center rounded text-base ${
            view === item.id ? 'bg-accent/20 text-accent' : 'text-dim hover:bg-white/5'
          }`}
        >
          {item.glyph}
        </button>
      ))}
    </nav>
  );
}

export function App(): JSX.Element {
  // One bundle, two windows: the quick-chat strip is the same code with a
  // different shell, so the chat surface cannot drift between them.
  const isQuick = new URLSearchParams(window.location.search).get('surface') === 'quick';

  const view = useApp((s) => s.view);
  // null = still asking; the shell must not flash before we know
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const setEngine = useApp((s) => s.setEngine);
  const setAgents = useApp((s) => s.setAgents);
  const setPaths = useApp((s) => s.setPaths);
  const applyEvent = useApp((s) => s.applyEvent);

  useEffect(() => {
    void window.geny.onboarding.done().then(setOnboarded);
    void window.geny.engine.status().then(setEngine);
    void window.geny.agents.list().then(setAgents);
    void window.geny.app.paths().then(setPaths);
    const offStatus = window.geny.engine.onStatus(setEngine);
    const offEvent = window.geny.chat.onEvent(applyEvent);
    return () => {
      offStatus();
      offEvent();
    };
  }, [setEngine, setAgents, setPaths, applyEvent]);

  if (onboarded === null) return <div className="h-full w-full bg-bg" />;
  // the strip never runs onboarding — it borrows whatever the main window
  // already set up, and has no room to ask for a key
  if (isQuick) return <QuickChatSurface />;
  if (!onboarded) {
    return (
      <div className="flex h-full w-full flex-col">
        <EngineBanner />
        <Onboarding onDone={() => setOnboarded(true)} />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <EngineBanner />
      <div className="flex min-h-0 flex-1">
        <ActivityRail />
        {view === 'agents' && (
          <>
            <AgentSidebar />
            <AgentWorkspace />
          </>
        )}
        {view === 'library' && (
          <>
            <AgentSidebar />
            <LibraryView />
          </>
        )}
        {view === 'settings' && <SettingsView />}
      </div>
    </div>
  );
}
