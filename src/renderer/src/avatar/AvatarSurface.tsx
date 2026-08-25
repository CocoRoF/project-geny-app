/**
 * The avatar overlay's renderer. One canvas, one model, and a reaction to
 * whatever the agent is doing.
 *
 * The window is transparent and click-through, so everything here is drawn
 * on nothing: no background, no chrome, and a control strip that only exists
 * while the pointer is over the window (hover events still arrive in
 * click-through mode because the window forwards them).
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AvatarState } from '@shared/api-types';
import type { SidecarEvent } from '@shared/sidecar-protocol';
import { attachVoicePlayback, voicePlayer } from '../voice/player';
import { createMmdStage, type StageHandle } from './mmd-stage';

type Mood = 'idle' | 'thinking' | 'speaking' | 'waiting' | 'error';

const MOOD_LABEL: Record<Mood, string> = {
  idle: '',
  thinking: '생각 중',
  speaking: '말하는 중',
  waiting: '승인 대기',
  error: '오류',
};

/** Expression morphs, tried in order — a model without them just stays neutral. */
const MOOD_MORPHS: Record<Mood, string[]> = {
  idle: [],
  thinking: ['困る', 'なごみ'],
  speaking: ['笑い', '笑顔', 'にこり'],
  waiting: ['びっくり', '驚き'],
  error: ['困る', '怒り'],
};

function moodFrom(event: SidecarEvent, previous: Mood): Mood {
  switch (event.type) {
    case 'chunk':
      return 'speaking';
    case 'started':
      return 'thinking';
    case 'tool':
      // a tool RESULT is not the end of the turn — the model still has to
      // say something about it, so the avatar stays busy either way
      return 'thinking';
    case 'agent':
      return 'thinking';
    case 'prompt':
    case 'hitl_request':
      return 'waiting';
    case 'error':
      return 'error';
    case 'done':
    case 'cancelled':
      return 'idle';
    default:
      return previous;
  }
}

export function AvatarSurface(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<StageHandle | null>(null);
  const [state, setState] = useState<AvatarState | null>(null);
  const [mood, setMood] = useState<Mood>('idle');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** set only once the stage has a live model — an absence of "loading" is
   *  not evidence of a load, which is exactly the thing a test must not
   *  accept */
  const [ready, setReady] = useState<{ morphs: number; physics: boolean } | null>(null);
  const [hover, setHover] = useState(false);
  /** true while real audio is coming out of the speakers — the mouth
   *  follows the waveform then, not the token stream */
  const [speakingAloud, setSpeakingAloud] = useState(false);

  useEffect(() => {
    void window.geny.avatar.state().then(setState);
    return window.geny.avatar.onState(setState);
  }, []);

  useEffect(() => {
    const off = window.geny.chat.onEvent((event) => {
      setMood((prev) => moodFrom(event, prev));
    });
    return off;
  }, []);

  // The overlay is where synthesized speech plays when it is up (the main
  // process sends it to exactly one window), which is what makes real
  // lip-sync possible instead of a guessed rhythm.
  useEffect(() => {
    const offAudio = attachVoicePlayback();
    const offLevel = voicePlayer.onLevel((level) => {
      const stage = stageRef.current;
      if (!stage) return;
      stage.setMouth(level);
      setSpeakingAloud(level > 0.02);
    });
    return () => {
      offAudio();
      offLevel();
    };
  }, []);

  // idle again a moment after the last token: a model frozen mid-smile
  // reads as broken, and turns end without a tidy "stopped speaking" event
  useEffect(() => {
    if (mood !== 'speaking') return undefined;
    const timer = setTimeout(() => setMood('idle'), 1500);
    return () => clearTimeout(timer);
  }, [mood]);

  const modelUrl = state?.modelUrl;
  const kind = state?.kind;
  // only the MMD path renders into our own WebGL canvas; `web` runs the
  // folder's own page in a frame and `image` is just a picture
  const nativeUrl = kind === 'mmd' ? modelUrl : undefined;

  useEffect(() => {
    let cancelled = false;
    stageRef.current?.dispose();
    stageRef.current = null;
    setError(null);
    setReady(null);
    if (!nativeUrl || !canvasRef.current) return undefined;

    setLoading(true);
    void createMmdStage({
      canvas: canvasRef.current,
      modelUrl: nativeUrl,
      onReady: (info) => setReady({ morphs: info.morphs.length, physics: info.physics }),
    })
      .then((stage) => {
        if (cancelled) {
          stage.dispose();
          return;
        }
        stageRef.current = stage;
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      stageRef.current?.dispose();
      stageRef.current = null;
    };
  }, [nativeUrl]);

  // mouth + expression follow the mood; the stage ignores morphs the model
  // does not have, so this is safe for any PMX
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const names = stage.morphNames();
    stage.setExpression(MOOD_MORPHS[mood].find((n) => names.includes(n)) ?? null);
    // real audio wins: when speech is actually playing, the waveform owns
    // the mouth and this fallback must keep its hands off
    if (mood !== 'speaking' || speakingAloud) {
      if (!speakingAloud) stage.setMouth(0);
      return undefined;
    }
    // text-only reply — approximate a talking rhythm so the model is not
    // silently frozen while words appear
    const timer = setInterval(() => {
      stage.setMouth(0.15 + Math.random() * 0.55);
    }, 110);
    return () => {
      clearInterval(timer);
      stage.setMouth(0);
    };
  }, [mood, speakingAloud]);

  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    // the folder's page is another document; the only thing we tell it is
    // what the agent is doing, and it may ignore that entirely
    frameRef.current?.contentWindow?.postMessage({ genyMood: mood }, '*');
  }, [mood, modelUrl]);

  const interactive = state ? !state.clickThrough : false;

  return (
    <div
      data-testid="avatar-surface"
      data-model={state?.modelId ?? ''}
      data-kind={kind ?? ''}
      data-mood={mood}
      data-loading={loading ? 'true' : 'false'}
      data-ready={ready ? 'true' : 'false'}
      data-morphs={ready?.morphs ?? 0}
      data-physics={ready?.physics ? 'true' : 'false'}
      data-speaking={speakingAloud ? 'true' : 'false'}
      data-error={error ?? ''}
      className="relative h-screen w-screen overflow-hidden"
      style={{ background: 'transparent' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {kind === 'mmd' && (
        <canvas ref={canvasRef} className="h-full w-full" style={{ outline: 'none' }} />
      )}

      {/* The bypass for formats whose runtime cannot ship: the folder's own
          page draws itself, we only give it a transparent rectangle. */}
      {kind === 'web' && modelUrl && (
        <iframe
          // Remount when the folder's runtime situation changes: a page
          // that already rendered "these files are missing" will not
          // discover on its own that they since arrived.
          key={`${modelUrl}|${(state?.missing ?? []).join(',')}`}
          ref={frameRef}
          title="avatar"
          src={modelUrl}
          className="h-full w-full border-0"
          style={{ background: 'transparent', colorScheme: 'normal' }}
          // it is the user's own local page; it gets a frame, not the app
          sandbox="allow-scripts allow-same-origin"
        />
      )}

      {kind === 'image' && modelUrl && (
        /\.(webm|mp4)$/i.test(modelUrl) ? (
          <video
            src={modelUrl}
            className="h-full w-full object-contain"
            autoPlay
            loop
            muted
            playsInline
          />
        ) : (
          <img src={modelUrl} alt="" className="h-full w-full object-contain" />
        )
      )}

      {!modelUrl && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-white/80">
          <span className="rounded bg-black/60 px-3 py-2">
            {state?.missing?.length ? (
              <>
                {state.modelName} 을(를) 표시하려면 런타임이 필요합니다.
                <br />
                <code>{state.missing.join(', ')}</code>
              </>
            ) : (
              <>
                아바타 모델이 없습니다.
                <br />
                데이터 폴더의 <code>avatars/</code> 에 모델 폴더를 넣어 주세요.
              </>
            )}
          </span>
        </div>
      )}

      {error && (
        <div className="absolute inset-x-2 bottom-2 rounded bg-red-950/85 px-2 py-1 text-[11px] text-red-200">
          모델을 불러오지 못했습니다: {error}
        </div>
      )}

      {mood !== 'idle' && MOOD_LABEL[mood] && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white/85">
          {MOOD_LABEL[mood]}
        </div>
      )}

      {/* the strip is the ONLY draggable region — the rest of the window
          stays transparent to the pointer even in interactive mode */}
      {(hover || interactive) && (
        <div
          className="absolute inset-x-0 top-0 flex items-center justify-end gap-1 p-1 opacity-90"
          style={{ WebkitAppRegion: interactive ? 'drag' : 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            title={interactive ? '클릭 통과로 되돌리기' : '조작 모드 — 드래그해서 옮기기'}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/85 hover:bg-black/80"
            onClick={() => void window.geny.avatar.setClickThrough(interactive)}
          >
            {interactive ? '고정' : '조작'}
          </button>
          <button
            type="button"
            title="아바타 숨기기"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/85 hover:bg-black/80"
            onClick={() => void window.geny.avatar.hide()}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
