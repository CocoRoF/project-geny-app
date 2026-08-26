import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { CliInfo } from '@shared/api-types';
import { useApp } from '../store/app-store';
import { AvatarSettings } from './AvatarSettings';
import { HotkeySettings } from './HotkeySettings';
import { SystemSettings } from './SystemSettings';
import { VoiceSettings } from './VoiceSettings';

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic API', hint: 'console.anthropic.com 에서 발급' },
  { id: 'openai', label: 'OpenAI API', hint: 'platform.openai.com 에서 발급' },
] as const;

/** App-level settings: credentials, where data lives, engine health. */
export function SettingsView(): JSX.Element {
  const engine = useApp((s) => s.engine);
  const dataRoot = useApp((s) => s.dataRoot);
  const portable = useApp((s) => s.portable);
  const [has, setHas] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [backend, setBackend] = useState<'keychain' | 'file'>('file');
  const [cli, setCli] = useState<CliInfo | null>(null);

  const refresh = (): void => {
    for (const p of PROVIDERS) {
      void window.geny.secrets.hasApiKey(p.id).then((v) => setHas((s) => ({ ...s, [p.id]: v })));
    }
  };

  useEffect(() => {
    refresh();
    void window.geny.secrets.backend().then(setBackend);
    void window.geny.cli.detect().then(setCli);
  }, []);

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5 text-xs">
      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">API 키</h2>
        <p className="mb-2 text-[11px] text-dim">
          저장 위치:{' '}
          {backend === 'keychain' ? 'OS 키체인 (암호화)' : '데이터 폴더의 파일 (권한 0600)'}
        </p>
        {PROVIDERS.map((p) => (
          <div key={p.id} className="mb-2 flex items-center gap-2">
            <span className="w-28 shrink-0">{p.label}</span>
            {has[p.id] ? (
              <>
                <span className="text-emerald-300">저장됨</span>
                <button
                  type="button"
                  className="rounded border border-line px-2 py-0.5 text-dim hover:text-fg"
                  onClick={() => void window.geny.secrets.clearApiKey(p.id).then(refresh)}
                >
                  지우기
                </button>
              </>
            ) : (
              <>
                <input
                  type="password"
                  className="min-w-[220px] flex-1 rounded border border-line bg-black/30 px-2 py-1"
                  placeholder={p.hint}
                  value={drafts[p.id] ?? ''}
                  onChange={(e) => setDrafts((s) => ({ ...s, [p.id]: e.target.value }))}
                />
                <button
                  type="button"
                  className="rounded border border-accent/60 px-2 py-1 text-accent"
                  onClick={() => {
                    const key = (drafts[p.id] ?? '').trim();
                    if (!key) return;
                    void window.geny.secrets.setApiKey(p.id, key).then(() => {
                      setDrafts((s) => ({ ...s, [p.id]: '' }));
                      refresh();
                    });
                  }}
                >
                  저장
                </button>
              </>
            )}
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">Claude Code CLI</h2>
        {cli === null && <p className="text-dim">확인 중…</p>}
        {cli?.found && (
          <p className="text-emerald-300">
            {cli.version} <span className="text-dim">— {cli.path} ({cli.via})</span>
          </p>
        )}
        {cli && !cli.found && (
          <p className="text-red-300">
            없음 — <span className="text-dim">{cli.error}</span>
            <br />
            <span className="text-dim">
              설치: <code>npm i -g @anthropic-ai/claude-code</code> 후 <code>claude login</code>
            </span>
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">엔진</h2>
        <p>
          상태: <b className={engine.state === 'ready' ? 'text-emerald-300' : 'text-red-300'}>{engine.state}</b>
          {engine.engine && <span className="text-dim"> · executor {engine.engine} · python {engine.python}</span>}
        </p>
        {engine.runtime && <p className="text-dim">런타임: {engine.runtime.source} — {engine.runtime.exe}</p>}
        {engine.error && <p className="text-red-300">{engine.error}</p>}
        <button
          type="button"
          className="mt-1 rounded border border-line px-2 py-1 hover:bg-white/5"
          onClick={() => void window.geny.engine.start()}
        >
          엔진 다시 시작
        </button>
      </section>

      <HotkeySettings />

      <SystemSettings />

      <VoiceSettings />

      <AvatarSettings />

      <section>
        <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">데이터</h2>
        <p className="break-all">{dataRoot}</p>
        <p className="text-dim">
          {portable
            ? '포터블 모드 — 실행 파일 옆에 저장됩니다'
            : '사용자 데이터 폴더 — 실행 파일 옆이 쓰기 불가라 여기에 저장됩니다'}
        </p>
        <button
          type="button"
          className="mt-1 rounded border border-line px-2 py-1 hover:bg-white/5"
          onClick={() => void window.geny.app.openPath(dataRoot)}
        >
          폴더 열기
        </button>
      </section>
    </div>
  );
}
