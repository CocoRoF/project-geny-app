import { useEffect } from 'react';
import { AgentSidebar } from './components/AgentSidebar';
import { ChatPane } from './components/ChatPane';
import { EngineBanner } from './components/EngineBanner';
import { useApp } from './store/app-store';
import type { JSX } from 'react';

export function App(): JSX.Element {
  const setEngine = useApp((s) => s.setEngine);
  const setAgents = useApp((s) => s.setAgents);
  const setPaths = useApp((s) => s.setPaths);
  const applyEvent = useApp((s) => s.applyEvent);

  useEffect(() => {
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

  return (
    <div className="flex h-full w-full flex-col">
      <EngineBanner />
      <div className="flex min-h-0 flex-1">
        {/* activity rail — Agents only in M0; Memory/Library/Help land in M7/M10 */}
        <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2">
          <div
            className="flex h-9 w-9 items-center justify-center rounded bg-accent/20 text-accent"
            title="Agents"
          >
            ◆
          </div>
        </nav>
        <AgentSidebar />
        <ChatPane />
      </div>
    </div>
  );
}
