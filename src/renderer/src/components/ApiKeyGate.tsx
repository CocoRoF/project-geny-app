import { useEffect, useState } from 'react';
import type { AgentRecord } from '@shared/api-types';
import type { JSX } from 'react';

const LABEL: Record<AgentRecord['provider'], string> = {
  anthropic: 'Anthropic API 키',
  openai: 'OpenAI API 키',
  claude_code_cli: 'Claude Code CLI',
};

/** First-run onboarding, inline where it is needed rather than a wizard. */
export function ApiKeyGate({ provider }: { provider: AgentRecord['provider'] }): JSX.Element | null {
  const [has, setHas] = useState<boolean | null>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    setHas(null);
    void window.geny.secrets.hasApiKey(provider).then(setHas);
  }, [provider]);

  // the CLI backend authenticates itself (`claude login`), no key to store
  if (provider === 'claude_code_cli' || has !== false) return null;

  const save = async (): Promise<void> => {
    const key = value.trim();
    if (!key) return;
    await window.geny.secrets.setApiKey(provider, key);
    setValue('');
    setHas(true);
  };

  return (
    <div className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2">
      <span className="text-xs">{LABEL[provider]}가 필요합니다.</span>
      <input
        type="password"
        className="min-w-[220px] flex-1 rounded bg-black/30 px-2 py-1 text-xs outline-none"
        placeholder="sk-…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
        }}
      />
      <button
        type="button"
        className="rounded border border-accent/60 px-2 py-1 text-xs text-accent"
        onClick={() => void save()}
      >
        저장
      </button>
    </div>
  );
}
