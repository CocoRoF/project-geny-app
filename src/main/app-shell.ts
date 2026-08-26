/**
 * App-shell concerns: one instance per data root, launch at login, and a log
 * the user can actually read.
 *
 * These are the things nobody asks for by name and everybody notices when
 * they are missing — a second copy of the app quietly fighting the first
 * over the same database, a companion app that has to be started by hand
 * every morning, and a failure whose only evidence went to a terminal that
 * was never open.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from 'electron';

export interface LogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  text: string;
}

/**
 * A bounded in-memory log.
 *
 * Bounded because a long-running session with a chatty engine would
 * otherwise grow without limit, and in memory because the point is to be
 * readable from inside the app — a file the user has to find is the problem
 * this exists to solve, not the solution.
 */
export class LogRing {
  private readonly entries: LogEntry[] = [];
  private readonly listeners = new Set<(e: LogEntry) => void>();

  constructor(private readonly limit = 2000) {}

  push(source: string, text: string, level: LogEntry['level'] = 'info'): void {
    // one line per entry keeps the viewer scannable; the engine emits
    // multi-line tracebacks in a single write
    for (const line of String(text).split('\n')) {
      const trimmed = line.replace(/\s+$/, '');
      if (!trimmed) continue;
      const entry: LogEntry = { at: Date.now(), level, source, text: trimmed.slice(0, 4000) };
      this.entries.push(entry);
      for (const listener of this.listeners) listener(entry);
    }
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }

  subscribe(listener: (e: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Plain text, for "copy" and for attaching to a bug report. */
  text(): string {
    return this.entries
      .map((e) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.source}: ${e.text}`)
      .join('\n');
  }
}

/**
 * Claim the single-instance lock, scoped to the data root.
 *
 * Electron's lock lives in `userData`, so pointing `userData` at the data
 * root makes the rule "one instance per data root" rather than "one
 * instance per machine". That is the rule that is actually correct: two
 * copies over one SQLite file and one agent workspace is the failure worth
 * preventing, while a dev run and a packaged run on different data roots
 * are not in conflict at all.
 *
 * Must be called before `app.whenReady()`.
 */
export function claimSingleInstance(
  app: Pick<App, 'requestSingleInstanceLock' | 'setPath' | 'quit' | 'on'>,
  dataRootOverride: string | undefined,
  onSecond: () => void,
): boolean {
  if (dataRootOverride) {
    const profile = join(dataRootOverride, 'electron');
    mkdirSync(profile, { recursive: true });
    app.setPath('userData', profile);
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  // launching again is a request to see the app, not to start a second one
  app.on('second-instance', onSecond);
  return true;
}

export interface AutostartResult {
  enabled: boolean;
  /** false when the state could not be written — a toggle that reads "on"
   *  while nothing was applied is a silent lie */
  applied: boolean;
  reason?: string;
}

const LINUX_ENTRY = 'geny-app.desktop';

function linuxAutostartPath(home: string): string {
  return join(home, '.config', 'autostart', LINUX_ENTRY);
}

/**
 * Launch at login.
 *
 * Windows and macOS have a login-item API; on Linux `setLoginItemSettings`
 * is a no-op, so it is a `~/.config/autostart` desktop entry instead.
 */
export function applyAutostart(
  app: Pick<App, 'setLoginItemSettings' | 'getPath'>,
  enabled: boolean,
  platform: NodeJS.Platform = process.platform,
): AutostartResult {
  try {
    if (platform !== 'linux') {
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled, args: ['--hidden'] });
      return { enabled, applied: true };
    }
    const path = linuxAutostartPath(app.getPath('home'));
    if (!enabled) {
      if (existsSync(path)) unlinkSync(path);
      return { enabled: false, applied: true };
    }
    // An AppImage's real path is $APPIMAGE; process.execPath points inside
    // the mount. With --appimage-extract-and-run there is no APPIMAGE at
    // all and execPath is in a /tmp directory that will not exist at the
    // next boot — an entry pointing there is dead on arrival, so refuse
    // rather than write something that silently never runs.
    const exec = process.env.APPIMAGE ?? process.execPath;
    if (/^\/tmp\/(\.mount_|appimage_extracted)/.test(exec)) {
      return {
        enabled: false,
        applied: false,
        reason: 'AppImage 를 임시 경로에서 실행 중이라 자동 시작을 등록할 수 없습니다',
      };
    }
    mkdirSync(join(app.getPath('home'), '.config', 'autostart'), { recursive: true });
    // Desktop Entry field codes: a literal % must be doubled
    const escaped = exec.replace(/%/g, '%%');
    writeFileSync(
      path,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Geny',
        `Exec="${escaped}" --hidden`,
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n'),
      'utf8',
    );
    return { enabled: true, applied: true };
  } catch (err) {
    return {
      enabled: false,
      applied: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function autostartActive(app: Pick<App, 'getLoginItemSettings' | 'getPath'>, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform === 'linux') return existsSync(linuxAutostartPath(app.getPath('home')));
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

/** Was this launch the autostart one? Then start quiet, in the tray. */
export const launchedHidden = (argv: string[] = process.argv): boolean => argv.includes('--hidden');

/**
 * Relaunch after an update on Linux packages.
 *
 * `app.relaunch()` goes through Electron's `--type=relauncher` helper, which
 * passes NoNewPrivs down to the new process. The SUID chrome-sandbox then
 * cannot elevate and the app aborts with SIGTRAP on a userns-restricted
 * kernel (Ubuntu 24.04). Spawning the launcher ourselves keeps NNP at 0.
 */
export function respawnDetached(execPath: string, delaySeconds = 3): void {
  const shim = execPath.replace(/\.bin$/, '');
  spawn('/bin/sh', ['-c', `sleep ${delaySeconds}; exec "$0"`, shim], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}
