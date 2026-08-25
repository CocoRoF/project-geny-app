/**
 * Push-to-talk. Hold or click to record, release to transcribe.
 *
 * Deliberately fills the composer instead of sending: speech recognition
 * mishears, and a turn that starts on a misheard sentence costs more than
 * one keystroke to confirm.
 */
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { MicRecorder } from './recorder';

export function MicButton({
  onText,
  disabled,
}: {
  onText(text: string): void;
  disabled?: boolean;
}): JSX.Element | null {
  const recorder = useRef(new MicRecorder());
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<'idle' | 'recording' | 'working'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const check = (): void => {
      void window.geny.voice.config().then((c) => setAvailable(c.stt.provider !== 'none'));
    };
    check();
    // the mic must never keep running if this unmounts mid-recording
    const mic = recorder.current;
    return () => mic.release();
  }, []);

  if (!available) return null;

  const start = (): void => {
    setError(null);
    void recorder.current
      .start()
      .then(() => setState('recording'))
      .catch((err: unknown) => {
        setState('idle');
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const finish = (): void => {
    if (state !== 'recording') return;
    setState('working');
    void recorder.current
      .stop()
      .then(async (clip) => {
        if (!clip || clip.seconds < 0.3) return;
        const { text } = await window.geny.voice.transcribe({
          base64: clip.base64,
          mime: clip.mime,
        });
        if (text) onText(text);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setState('idle'));
  };

  const label = state === 'recording' ? '● 녹음 중' : state === 'working' ? '…' : '🎤';

  return (
    <button
      type="button"
      title={error ?? '누르고 있는 동안 녹음 — 떼면 받아쓰기'}
      disabled={disabled || state === 'working'}
      onMouseDown={start}
      onMouseUp={finish}
      onMouseLeave={finish}
      className={`rounded border px-3 py-2 text-xs disabled:opacity-40 ${
        state === 'recording'
          ? 'border-red-400/70 text-red-300'
          : error
            ? 'border-red-500/50 text-red-300'
            : 'border-line hover:bg-white/5'
      }`}
    >
      {label}
    </button>
  );
}
