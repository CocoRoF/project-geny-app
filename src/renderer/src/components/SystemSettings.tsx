/**
 * The desktop-app settings: computer use, updates, startup, capture, and a
 * log the user can read without opening a terminal.
 */
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { CaptureSource, ComputerUseStatusInfo, LogLine, UpdateState } from '@shared/api-types';

const box = 'rounded border border-line p-2';

function ComputerUsePanel(): JSX.Element {
  const [status, setStatus] = useState<ComputerUseStatusInfo | null>(null);
  useEffect(() => {
    void window.geny.computer.status().then(setStatus);
  }, []);
  const save = (patch: Partial<ComputerUseStatusInfo>): void => {
    void window.geny.computer.save(patch).then(setStatus);
  };
  if (!status) return <div />;

  return (
    <div className={box} data-testid="computer-use">
      <div className="mb-1 flex items-center gap-2">
        <b>컴퓨터 조작</b>
        {status.backendAvailable ? (
          <span className="text-[11px] text-dim">입력 방식: {status.backend}</span>
        ) : (
          <span className="text-[11px] text-amber-300">{status.backendReason}</span>
        )}
      </div>
      <p className="mb-1 text-[11px] text-dim">
        에이전트가 <b>지금 초점이 있는 창</b>에 실제로 타이핑하고 클릭합니다. 워크스페이스 밖의
        일이라 기본은 꺼져 있고, 켜도 작업마다 물어봅니다.
      </p>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={status.enabled}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        컴퓨터 조작 허용
      </label>
      {status.enabled && (
        <div className="mt-1 flex flex-col gap-1 pl-5">
          {(['input', 'apps', 'clipboard'] as const).map((cap) => (
            <label key={cap} className="flex items-center gap-1">
              <input type="checkbox" checked={status[cap]} onChange={(e) => save({ [cap]: e.target.checked })} />
              {cap === 'input' ? '키보드 · 마우스' : cap === 'apps' ? '앱 · 파일 열기' : '클립보드 쓰기'}
            </label>
          ))}
          <label className="mt-1 flex items-center gap-2">
            <span className="text-dim">확인 방식</span>
            <select
              className="rounded border border-line bg-panel px-2 py-0.5"
              value={status.mode}
              onChange={(e) => save({ mode: e.target.value as 'ask' | 'auto' })}
            >
              <option value="ask">작업마다 물어보기 (권장)</option>
              <option value="auto">묻지 않고 실행</option>
            </select>
          </label>
          {status.mode === 'auto' && (
            <p className="text-[11px] text-amber-300">
              이 설정에서는 에이전트가 확인 없이 키를 입력합니다. 트레이의 [컴퓨터 조작 허용] 을
              끄면 즉시 멈춥니다.
            </p>
          )}
          {status.sessionGrants.length > 0 && (
            <p className="text-[11px] text-dim">
              이번 실행 동안 허용됨: {status.sessionGrants.join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function UpdatePanel(): JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    void window.geny.update.state().then(setState);
    return window.geny.update.onState(setState);
  }, []);
  if (!state) return <div />;
  const label =
    state.status === 'downloading'
      ? `받는 중 ${state.percent ?? 0}%`
      : state.status === 'ready'
        ? `v${state.version} 설치 준비됨`
        : state.status === 'available'
          ? `v${state.version} 있음`
          : state.status === 'checking'
            ? '확인 중…'
            : state.status === 'unsupported'
              ? (state.error ?? '지원되지 않음')
              : state.status === 'error'
                ? (state.error ?? '오류')
                : '최신 버전입니다';

  return (
    <div className={box} data-testid="update-panel">
      <div className="mb-1 flex items-center gap-2">
        <b>업데이트</b>
        <span className={state.status === 'error' ? 'text-red-300' : 'text-dim'}>{label}</span>
      </div>
      {state.channel && <p className="mb-1 text-[11px] text-dim">{state.channel}</p>}
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={state.enabled !== false}
          onChange={(e) => void window.geny.update.setEnabled(e.target.checked).then(setState)}
        />
        자동으로 업데이트 (끄면 새 버전이 있을 때 알림만 받습니다)
      </label>
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          className="rounded border border-line px-2 py-1 hover:bg-white/5"
          onClick={() => void window.geny.update.check().then(setState)}
        >
          지금 확인
        </button>
        {state.status === 'ready' && (
          <button
            type="button"
            className="rounded border border-accent/60 px-2 py-1 text-accent hover:bg-accent/10"
            onClick={() => void window.geny.update.installNow()}
          >
            설치하고 재시작
          </button>
        )}
      </div>
    </div>
  );
}

function StartupPanel(): JSX.Element {
  const [on, setOn] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void window.geny.system.autostart().then(setOn);
  }, []);
  return (
    <div className={box} data-testid="startup-panel">
      <b>시작</b>
      <label className="mt-1 flex items-center gap-1">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) =>
            void window.geny.system.setAutostart(e.target.checked).then((r) => {
              setOn(r.enabled);
              setNote(r.applied ? null : (r.reason ?? '적용하지 못했습니다'));
            })
          }
        />
        로그인 시 자동 시작 (트레이에서 조용히 시작합니다)
      </label>
      {note && <p className="mt-1 text-[11px] text-amber-300">{note}</p>}
    </div>
  );
}

function CapturePanel(): JSX.Element {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selected, setSelected] = useState<string>('');
  const load = (): void => {
    void window.geny.system.captureSources().then(setSources);
    void window.geny.system.captureSource().then((v) => setSelected(v ?? ''));
  };
  useEffect(load, []);
  return (
    <div className={box} data-testid="capture-panel">
      <b>화면 캡처</b>
      <p className="mb-1 text-[11px] text-dim">
        에이전트가 화면을 볼 때 무엇을 보여줄지. 창을 고르면 그 창만 보입니다.
      </p>
      <div className="flex items-center gap-2">
        <select
          className="flex-1 rounded border border-line bg-panel px-2 py-1"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            void window.geny.system.setCaptureSource(e.target.value || null);
          }}
        >
          <option value="">기본 (주 화면)</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.kind === 'screen' ? '🖵 ' : '▭ '}
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" className="rounded border border-line px-2 py-1 hover:bg-white/5" onClick={load}>
          다시 찾기
        </button>
      </div>
    </div>
  );
}

function LogPanel(): JSX.Element {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    void window.geny.system.logs().then(setLines);
    // bounded in the main process, but this list is also capped so a long
    // session cannot make the settings pane slow to render
    return window.geny.system.onLog((line) => setLines((prev) => [...prev.slice(-499), line]));
  }, [open]);

  return (
    <div className={box} data-testid="log-panel">
      <div className="flex items-center gap-2">
        <b>로그</b>
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 hover:bg-white/5"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '접기' : '열기'}
        </button>
        {open && (
          <>
            <button
              type="button"
              className="rounded border border-line px-2 py-0.5 hover:bg-white/5"
              onClick={() => void window.geny.system.logText().then((t) => navigator.clipboard.writeText(t))}
            >
              전체 복사
            </button>
            <button
              type="button"
              className="rounded border border-line px-2 py-0.5 hover:bg-white/5"
              onClick={() => void window.geny.system.clearLogs().then(() => setLines([]))}
            >
              비우기
            </button>
          </>
        )}
      </div>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-black/40 p-2 text-[11px] leading-relaxed">
          {lines.length === 0
            ? '아직 기록이 없습니다.'
            : lines
                .map(
                  (l) =>
                    `${new Date(l.at).toLocaleTimeString()} ${l.source.padEnd(8)} ${l.text}`,
                )
                .join('\n')}
        </pre>
      )}
    </div>
  );
}

export function SystemSettings(): JSX.Element {
  return (
    <section className="flex flex-col gap-2" data-testid="system-settings">
      <h2 className="text-[10px] uppercase tracking-widest text-dim">데스크톱</h2>
      <ComputerUsePanel />
      <UpdatePanel />
      <StartupPanel />
      <CapturePanel />
      <LogPanel />
    </section>
  );
}
