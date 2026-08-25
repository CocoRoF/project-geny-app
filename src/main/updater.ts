/**
 * Auto-update. Deliberately conservative: check, tell the user, install on
 * quit — never restart under someone mid-turn.
 *
 * Unsigned builds cannot auto-update on macOS (Squirrel.Mac requires a valid
 * signature), so the app reports the situation instead of failing silently
 * and pointing at a spinner forever.
 */
import type { BrowserWindow } from 'electron';

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'unsupported' | 'error';
  version?: string;
  percent?: number;
  error?: string;
}

export interface UpdaterDeps {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  window(): BrowserWindow | null;
  onState(state: UpdateState): void;
  log?: (line: string) => void;
}

export class Updater {
  private state: UpdateState = { status: 'idle' };

  constructor(private readonly deps: UpdaterDeps) {}

  get current(): UpdateState {
    return this.state;
  }

  private set(next: UpdateState): void {
    this.state = next;
    this.deps.onState(next);
  }

  async check(): Promise<UpdateState> {
    if (!this.deps.isPackaged) {
      this.set({ status: 'unsupported', error: '개발 모드에서는 업데이트를 확인하지 않습니다' });
      return this.state;
    }
    // unsigned macOS builds: electron-updater would download and then fail
    // at the signature check, so say so up front
    if (this.deps.platform === 'darwin' && !process.env.GENY_SIGNED) {
      this.set({
        status: 'unsupported',
        error: '서명되지 않은 macOS 빌드는 자동 업데이트를 지원하지 않습니다 — 릴리스에서 새 dmg 를 받아주세요',
      });
      return this.state;
    }
    // electron-updater can replace an AppImage in place, but it cannot
    // update something dpkg owns — it would download and then fail with an
    // unhelpful error. `APPIMAGE` is set by the AppImage runtime itself, so
    // its absence on Linux means the app came from a package manager.
    if (this.deps.platform === 'linux' && !process.env.APPIMAGE) {
      this.set({
        status: 'unsupported',
        error: '패키지로 설치된 빌드는 자동 업데이트를 지원하지 않습니다 — 릴리스에서 새 .deb 를 받아 설치해 주세요',
      });
      return this.state;
    }

    this.set({ status: 'checking' });
    try {
      const { autoUpdater } = await import('electron-updater');
      autoUpdater.autoDownload = true;
      // installing mid-session would kill a running turn
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.logger = null;

      autoUpdater.on('update-available', (info) => this.set({ status: 'available', version: info.version }));
      autoUpdater.on('update-not-available', () => this.set({ status: 'idle' }));
      autoUpdater.on('download-progress', (p) =>
        this.set({ status: 'downloading', percent: Math.round(p.percent) }),
      );
      autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
      autoUpdater.on('error', (err) =>
        this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) }),
      );

      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
    return this.state;
  }
}
