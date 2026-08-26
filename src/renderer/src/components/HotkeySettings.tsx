/**
 * Rebinding a global hotkey means pressing it — which is exactly the chord
 * the app currently holds. So recording pauses every accelerator first, and
 * resumes when the capture ends however it ends.
 */
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { HotkeyDefinitionInfo, HotkeyStateInfo } from '@shared/api-types';

/** A DOM KeyboardEvent → an Electron accelerator. */
function toAccelerator(e: React.KeyboardEvent): string | null {
  const key = e.key;
  // a modifier alone is not a shortcut; keep listening
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const named: Record<string, string> = {
    ' ': 'Space', Escape: 'Escape', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  };
  const main = named[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  // a bare letter would fire constantly; require at least one modifier
  if (parts.length === 0 && !/^F\d{1,2}$/.test(main)) return null;
  parts.push(main);
  return parts.join('+');
}

const pretty = (accelerator: string): string =>
  accelerator
    .replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
    .replace(/\+/g, ' + ');

export function HotkeySettings(): JSX.Element {
  const [definitions, setDefinitions] = useState<HotkeyDefinitionInfo[]>([]);
  const [state, setState] = useState<HotkeyStateInfo[]>([]);
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recordingRef = useRef<string | null>(null);

  const load = (): void => {
    void window.geny.hotkeys.list().then((r) => {
      setDefinitions(r.definitions);
      setState(r.state);
    });
  };
  useEffect(() => {
    load();
    // a capture left open when this unmounts would leave the app with no
    // hotkeys at all until the next restart
    return () => {
      if (recordingRef.current) void window.geny.hotkeys.resume();
    };
  }, []);

  const startRecording = (id: string): void => {
    setError(null);
    recordingRef.current = id;
    setRecording(id);
    void window.geny.hotkeys.pause();
  };

  const stopRecording = (): void => {
    recordingRef.current = null;
    setRecording(null);
    void window.geny.hotkeys.resume().then(setState);
  };

  const commit = (id: string, accelerator: string): void => {
    recordingRef.current = null;
    setRecording(null);
    void window.geny.hotkeys
      .set(id, accelerator)
      .then(setState)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        void window.geny.hotkeys.resume().then(setState);
      });
  };

  return (
    <section data-testid="hotkey-settings">
      <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">단축키</h2>
      <div className="flex flex-col gap-1">
        {definitions.map((def) => {
          const current = state.find((s) => s.id === def.id);
          const isRecording = recording === def.id;
          return (
            <div key={def.id} className="flex items-center gap-2 rounded border border-line px-2 py-1">
              <span className="flex-1">
                {def.label}
                {def.hint && <span className="ml-1 text-[11px] text-dim">{def.hint}</span>}
              </span>
              {current?.accelerator && !current.bound && (
                <span
                  className="text-[11px] text-amber-300"
                  title="다른 앱이 이 조합을 이미 쓰고 있습니다"
                >
                  다른 앱이 사용 중
                </span>
              )}
              <button
                type="button"
                data-testid={`hotkey-${def.id}`}
                onKeyDown={(e) => {
                  if (!isRecording) return;
                  e.preventDefault();
                  if (e.key === 'Escape') {
                    stopRecording();
                    return;
                  }
                  const accelerator = toAccelerator(e);
                  if (accelerator) commit(def.id, accelerator);
                }}
                onBlur={() => isRecording && stopRecording()}
                onClick={() => (isRecording ? stopRecording() : startRecording(def.id))}
                className={`min-w-[150px] rounded border px-2 py-0.5 font-mono text-[11px] ${
                  isRecording
                    ? 'border-accent bg-accent/10 text-accent'
                    : current?.bound
                      ? 'border-line hover:bg-white/5'
                      : 'border-line text-dim hover:bg-white/5'
                }`}
              >
                {isRecording
                  ? '키를 누르세요… (Esc 취소)'
                  : current?.accelerator
                    ? pretty(current.accelerator)
                    : '없음'}
              </button>
              {current?.accelerator && !isRecording && (
                <button
                  type="button"
                  title="이 단축키 끄기"
                  className="rounded border border-line px-1.5 py-0.5 text-[11px] hover:bg-white/5"
                  onClick={() => commit(def.id, '')}
                >
                  끄기
                </button>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="mt-1 text-[11px] text-red-300">{error}</p>}
      <button
        type="button"
        className="mt-2 rounded border border-line px-2 py-1 hover:bg-white/5"
        onClick={() => void window.geny.hotkeys.reset().then(setState)}
      >
        기본값으로
      </button>
    </section>
  );
}
