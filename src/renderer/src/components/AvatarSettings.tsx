/**
 * Avatar settings — pick a model, show it, decide whether it catches the
 * mouse. Deliberately honest when the folder is empty: an on/off switch
 * that cannot do anything is worse than an explanation.
 */
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { AvatarKind, AvatarModel, AvatarState } from '@shared/api-types';

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

const KIND_LABEL: Record<AvatarKind, string> = {
  mmd: 'MMD',
  live2d: 'Live2D',
  spine: 'Spine',
  web: '자체 페이지',
  image: '이미지',
  unknown: '알 수 없음',
};

export function AvatarSettings(): JSX.Element {
  const [models, setModels] = useState<AvatarModel[]>([]);
  const [state, setState] = useState<AvatarState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** which model the Cubism Core terms are being shown for */
  const [coreFor, setCoreFor] = useState<string | null>(null);

  const reload = (): void => {
    void window.geny.avatar.list().then(({ models: m, state: s }) => {
      setModels(m);
      setState(s);
    });
  };

  useEffect(() => {
    reload();
    return window.geny.avatar.onState(setState);
  }, []);

  const run = (action: () => Promise<AvatarState>): void => {
    setError(null);
    void action()
      .then(setState)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <section data-testid="avatar-settings">
      <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">아바타</h2>

      {models.length === 0 ? (
        <p className="text-dim">
          모델이 없습니다. 데이터 폴더의 <code>avatars/</code> 아래에 모델 폴더를 통째로
          넣으면 바로 나타납니다 — MMD(<code>.pmx</code>) · Live2D(<code>.model3.json</code>) ·
          Spine(<code>.atlas</code>) · 이미지/영상(gif · webp · webm) · 자체
          <code>index.html</code>.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {models.map((m) => (
            <div key={m.id} className="rounded border border-line px-2 py-1">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="avatar-model"
                  checked={state?.modelId === m.id}
                  onChange={() => run(() => window.geny.avatar.select(m.id))}
                />
                <span className="flex-1">{m.name}</span>
                <span className="rounded bg-white/5 px-1 text-[10px] text-dim">{KIND_LABEL[m.kind]}</span>
                <span className="text-dim">{mb(m.bytes)}</span>
              </label>
              {/* a format whose runtime cannot ship: say exactly what is
                  missing, and offer the page that will load it */}
              {!m.file && (m.kind === 'live2d' || m.kind === 'spine') && (
                <div className="mt-1 flex flex-wrap items-center gap-2 pl-6 text-[11px]">
                  <span className="text-amber-300">표시용 페이지가 없습니다</span>
                  <button
                    type="button"
                    className="rounded border border-line px-1.5 py-0.5 hover:bg-white/5"
                    onClick={() => {
                      setError(null);
                      void window.geny.avatar
                        .scaffold(m.id)
                        .then((r) => {
                          setModels(r.models);
                          setState(r.state);
                        })
                        .catch((err: unknown) =>
                          setError(err instanceof Error ? err.message : String(err)));
                    }}
                  >
                    표시용 페이지 만들기
                  </button>
                </div>
              )}
              {/* Live2D: everything but Cubism Core ships with the app, and
                  Core is one click — but it comes under Live2D's terms, not
                  ours, so the user sees them before it is fetched. */}
              {m.missing.includes('live2dcubismcore.min.js') && (
                <div className="mt-1 pl-6 text-[11px]">
                  {coreFor === m.id ? (
                    <div className="rounded border border-amber-400/40 bg-amber-400/5 p-2">
                      <p className="mb-1">
                        <b>Cubism Core</b> 를 Live2D 공식 배포처에서 이 모델 폴더로 내려받습니다.
                      </p>
                      <ul className="mb-1 ml-4 list-disc text-dim">
                        <li>
                          이 파일은 이 앱의 Apache-2.0 이 아니라{' '}
                          <a
                            className="text-accent underline"
                            href="https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Live2D 독점 소프트웨어 사용권 계약
                          </a>
                          을 따릅니다.
                        </li>
                        <li>
                          이 앱처럼 모델을 무제한으로 받는 <b>아바타 시스템</b>은 Live2D 가
                          &ldquo;Expandable Application&rdquo; 으로 분류해 개인·소규모 면제에서
                          제외합니다. 만든 것을 <b>배포</b>할 계획이라면{' '}
                          <a
                            className="text-accent underline"
                            href="https://help.live2d.com/en/sdk/sdk_001/"
                            target="_blank"
                            rel="noreferrer"
                          >
                            별도 계약
                          </a>
                          이 필요합니다. 혼자 쓰는 것은 해당하지 않습니다.
                        </li>
                      </ul>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy === m.id}
                          className="rounded border border-accent/60 px-2 py-0.5 text-accent hover:bg-accent/10 disabled:opacity-40"
                          onClick={() => {
                            setError(null);
                            setBusy(m.id);
                            void window.geny.avatar
                              .fetchCubismCore(m.id)
                              .then((r) => {
                                setModels(r.models);
                                setState(r.state);
                                setCoreFor(null);
                              })
                              .catch((err: unknown) =>
                                setError(err instanceof Error ? err.message : String(err)))
                              .finally(() => setBusy(null));
                          }}
                        >
                          {busy === m.id ? '받는 중…' : '동의하고 받기'}
                        </button>
                        <button
                          type="button"
                          className="rounded border border-line px-2 py-0.5 hover:bg-white/5"
                          onClick={() => setCoreFor(null)}
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-amber-300">Cubism Core 가 필요합니다</span>
                      <button
                        type="button"
                        className="rounded border border-line px-1.5 py-0.5 hover:bg-white/5"
                        onClick={() => setCoreFor(m.id)}
                      >
                        Cubism Core 받기
                      </button>
                    </div>
                  )}
                </div>
              )}
              {m.missing.filter((f) => f !== 'live2dcubismcore.min.js').length > 0 && (
                <p className="mt-1 pl-6 text-[11px] text-dim">
                  런타임 파일 필요 —{' '}
                  <code>
                    runtime/
                    {m.missing.filter((f) => f !== 'live2dcubismcore.min.js').join(', runtime/')}
                  </code>
                  . 이 런타임은 자유롭게 재배포할 수 없어 앱에 들어 있지 않습니다.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={models.length === 0}
          className="rounded border border-line px-2 py-1 hover:bg-white/5 disabled:opacity-40"
          onClick={() =>
            run(() => (state?.visible ? window.geny.avatar.hide() : window.geny.avatar.show()))
          }
        >
          {state?.visible ? '아바타 숨기기' : '아바타 띄우기'}
        </button>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={state ? !state.clickThrough : false}
            onChange={(e) => run(() => window.geny.avatar.setClickThrough(!e.target.checked))}
          />
          조작 모드 (끄면 클릭이 뒤 창으로 통과합니다)
        </label>
        <button
          type="button"
          className="rounded border border-line px-2 py-1 hover:bg-white/5"
          onClick={() => {
            void window.geny.avatar.openFolder();
          }}
        >
          모델 폴더 열기
        </button>
        <button
          type="button"
          className="rounded border border-line px-2 py-1 hover:bg-white/5"
          onClick={reload}
        >
          다시 찾기
        </button>
      </div>

      {error && <p className="mt-1 text-red-300">{error}</p>}
      <p className="mt-1 text-[11px] text-dim">
        아바타는 데스크톱 위에 떠서 에이전트가 생각하거나 말하는 동안 반응하고,
        음성이 재생되는 동안에는 실제 파형에 맞춰 입을 움직입니다.
        MMD 는 앱이 직접 렌더링합니다. Live2D 는 렌더러(MIT)를 앱이 넣어 주고 Cubism Core 만
        Live2D 공식 배포처에서 한 번 받아옵니다. Spine 은 런타임에 Esoteric 라이선스가 필요해
        사용자가 <code>runtime/</code> 에 직접 넣어야 합니다.
      </p>
    </section>
  );
}
