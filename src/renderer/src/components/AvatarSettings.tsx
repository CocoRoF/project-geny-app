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
              {m.missing.length > 0 && (
                <p className="mt-1 pl-6 text-[11px] text-dim">
                  런타임 파일 필요 — <code>runtime/{m.missing.join('</code>, <code>')}</code>.
                  이 포맷의 런타임은 자유롭게 재배포할 수 없어 앱에 들어 있지 않습니다.
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
        MMD 는 앱이 직접 렌더링합니다. Live2D · Spine 은 런타임을 자유롭게 재배포할 수 없어
        동봉하지 않고, 대신 앱이 표시용 페이지를 만들어 사용자가 넣은 런타임으로 띄웁니다.
      </p>
    </section>
  );
}
