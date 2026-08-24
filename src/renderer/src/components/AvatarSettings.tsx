/**
 * Avatar settings — pick a model, show it, decide whether it catches the
 * mouse. Deliberately honest when the folder is empty: an on/off switch
 * that cannot do anything is worse than an explanation.
 */
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { AvatarModel, AvatarState } from '@shared/api-types';

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

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
          모델이 없습니다. 데이터 폴더의 <code>avatars/</code> 아래에 MMD 모델 폴더
          (<code>.pmx</code> 와 텍스처)를 통째로 넣으면 바로 나타납니다.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {models.map((m) => (
            <label
              key={m.id}
              className="flex cursor-pointer items-center gap-2 rounded border border-line px-2 py-1 hover:bg-white/5"
            >
              <input
                type="radio"
                name="avatar-model"
                checked={state?.modelId === m.id}
                onChange={() => run(() => window.geny.avatar.select(m.id))}
              />
              <span className="flex-1">{m.name}</span>
              <span className="text-dim">{mb(m.bytes)}</span>
            </label>
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
        아바타는 데스크톱 위에 떠서 에이전트가 생각하거나 말하는 동안 반응합니다.
        MMD(PMX) 형식만 지원합니다 — Live2D · Spine 런타임은 자유롭게 배포할 수 없어
        설치 파일에 넣지 않았습니다.
      </p>
    </section>
  );
}
