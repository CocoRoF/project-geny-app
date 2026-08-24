import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { CliInfo } from '@shared/api-types';
import { useApp } from '../store/app-store';

/** First run. Three things decide whether the app works at all — the engine,
 *  a way to talk to a model, and somewhere to put agent files — so those are
 *  the three things this shows, with their real state rather than a wizard
 *  that claims success it has not verified. */
export function Onboarding({ onDone }: { onDone: () => void }): JSX.Element {
  const engine = useApp((s) => s.engine);
  const dataRoot = useApp((s) => s.dataRoot);
  const portable = useApp((s) => s.portable);
  const [cli, setCli] = useState<CliInfo | null>(null);
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.geny.cli.detect().then(setCli);
    void window.geny.secrets.hasApiKey('anthropic').then(setHasKey);
  }, []);

  const ready = engine.state === 'ready' && (hasKey || cli?.found === true);

  const finish = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.geny.onboarding.complete();
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const Row = ({ ok, title, children }: { ok: boolean; title: string; children: React.ReactNode }): JSX.Element => (
    <div className="rounded border border-line p-3">
      <div className="mb-1 flex items-center gap-2">
        <span className={ok ? 'text-emerald-300' : 'text-amber-300'}>{ok ? '✓' : '•'}</span>
        <b className="text-xs">{title}</b>
      </div>
      <div className="text-[11px] leading-relaxed text-dim">{children}</div>
    </div>
  );

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <h1 className="mb-1 text-lg font-semibold">Geny 시작하기</h1>
        <p className="mb-4 text-xs text-dim">
          서버도, Docker 도, 파이썬 설치도 필요 없습니다. 아래 세 가지만 확인하면 됩니다.
        </p>

        <div className="flex flex-col gap-2">
          <Row ok={engine.state === 'ready'} title="에이전트 엔진">
            {engine.state === 'ready' ? (
              <>동봉된 엔진이 실행 중입니다 — executor {engine.engine} · python {engine.python}</>
            ) : engine.state === 'failed' ? (
              <span className="text-red-300">{engine.error}</span>
            ) : (
              '시작하는 중…'
            )}
          </Row>

          <Row ok={hasKey || cli?.found === true} title="모델 연결">
            {cli?.found && (
              <p className="mb-1 text-emerald-300">
                Claude Code CLI {cli.version} 감지됨 — 키 없이 바로 쓸 수 있습니다.
              </p>
            )}
            {hasKey ? (
              <p className="text-emerald-300">Anthropic API 키가 저장돼 있습니다.</p>
            ) : (
              <div className="flex gap-2">
                <input
                  type="password"
                  className="min-w-0 flex-1 rounded border border-line bg-black/30 px-2 py-1"
                  placeholder="Anthropic API 키 (선택 — CLI 가 있으면 건너뛰어도 됩니다)"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                <button
                  type="button"
                  className="rounded border border-accent/60 px-2 py-1 text-accent"
                  onClick={() => {
                    const value = key.trim();
                    if (!value) return;
                    void window.geny.secrets.setApiKey('anthropic', value).then(() => {
                      setKey('');
                      setHasKey(true);
                    });
                  }}
                >
                  저장
                </button>
              </div>
            )}
          </Row>

          <Row ok title="에이전트 폴더">
            에이전트마다 <code>workspace/</code>, <code>memory/</code>, <code>artifacts/</code> 가 여기에
            만들어집니다.
            <br />
            <span className="break-all">{dataRoot}</span>
            {portable ? ' (포터블 — 실행 파일 옆)' : ' (사용자 데이터 폴더)'}
          </Row>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            className={`rounded px-3 py-1.5 text-xs ${
              ready ? 'border border-accent/60 text-accent hover:bg-accent/10' : 'border border-line text-dim'
            }`}
            onClick={() => void finish()}
          >
            {ready ? '시작하기' : '일단 둘러보기'}
          </button>
          {!ready && (
            <span className="text-[11px] text-dim">
              모델 연결 없이도 앱은 열리지만, 대화하려면 키나 CLI 가 필요합니다.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
