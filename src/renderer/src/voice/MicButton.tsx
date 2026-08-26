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
  const startRef = useRef<() => void>(() => {});
  const finishRef = useRef<() => void>(() => {});
  const stateRef = useRef<'idle' | 'recording' | 'working'>('idle');
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

  // The global hotkey has no key-up event, so it toggles: press to start,
  // press again to send. Registered even when the button is hidden, because
  // the whole point is not having to reach the window.
  useEffect(() => {
    if (!available) return undefined;
    return window.geny.hotkeys.onPushToTalk(() => {
      // read the live state rather than closing over a stale one
      if (stateRef.current === 'recording') finishRef.current();
      else if (stateRef.current === 'idle') startRef.current();
    });
  }, [available]);

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
    // onMouseLeave fires whenever the pointer passes over, so without this
    // the button flickers through 'working' on every hover
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

  // the hotkey handler runs outside React's render, so it needs stable refs
  startRef.current = start;
  finishRef.current = finish;
  stateRef.current = state;

  if (!available) return null;

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
