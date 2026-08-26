/**
 * Auto-update.
 *
 * The shape of this is set by one observation: an update the user has to
 * remember to fetch is an update most people never get. So the default is
 * on and unattended, and every path ends somewhere definite rather than in
 * a spinner.
 *
 *   ON  → check 20s after launch and every 6 hours; download; offer to
 *         restart. Installs on quit if they say later.
 *   OFF → still CHECK, and raise a notification if there is something. The
 *         user asked not to be updated, not to be uninformed.
 *   Manual → one press goes all the way: check, download, install, restart.
 *         The press already carried the decision; asking again just leaves
 *         them on the old version when they miss the second dialog.
 *
 * Platform reality, measured rather than assumed:
 *   · Windows NSIS and Linux AppImage update in place.
 *   · Linux .deb DOES update — electron-updater 6 ships a DebUpdater that
 *     runs `dpkg -i` through a privilege prompt. (An earlier version of this
 *     file claimed deb could not self-update. That was wrong.)
 *   · macOS needs a real signature for Squirrel.Mac, so an unsigned build
 *     opens the releases page instead of pretending.
 */
import type { BrowserWindow } from 'electron';

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'unsupported' | 'error';
  version?: string;
  percent?: number;
  error?: string;
  /** the user's setting, echoed so the UI never has to ask twice */
  enabled?: boolean;
  /** what happens on this platform, in words the settings pane can show */
  channel?: string;
  lastCheckedAt?: number;
}

export interface UpdaterDeps {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  version: string;
  window(): BrowserWindow | null;
  onState(state: UpdateState): void;
  /** persisted opt-out */
  enabled(): boolean;
  setEnabled(value: boolean): void;
  notify(input: { title: string; body: string; onClick?: () => void }): void;
  confirmRestart(version: string): Promise<boolean>;
  /** Linux packages need a hand coming back up — see app-shell.respawnDetached */
  beforeQuitForUpdate?: () => void;
  log?: (line: string) => void;
}

const RELEASES_URL = 'https://github.com/CocoRoF/project-geny-app/releases/latest';
const FIRST_CHECK_MS = 20_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

export class Updater {
  private state: UpdateState = { status: 'idle' };
  private wired = false;
  /** set when the user pressed "지금 업데이트": the download that follows
   *  installs and restarts without asking again */
  private installWhenReady = false;
  /** don't raise the same notification every six hours */
  private notifiedVersion: string | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly deps: UpdaterDeps) {}

  get current(): UpdateState {
    return { ...this.state, enabled: this.deps.enabled(), channel: this.describe() };
  }

  private set(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next };
    this.deps.onState(this.current);
  }

  /** What this platform can actually do, said plainly. */
  private describe(): string {
    if (!this.deps.isPackaged) return '개발 모드 — 확인하지 않습니다';
    if (this.deps.platform === 'darwin' && !process.env.GENY_SIGNED) {
      return '서명되지 않은 macOS 빌드 — 릴리스 페이지를 엽니다';
    }
    if (this.deps.platform === 'linux') {
      return process.env.APPIMAGE
        ? 'AppImage — 제자리에서 교체합니다'
        : '.deb — 설치 시 관리자 권한을 한 번 묻습니다';
    }
    return '설치 후 재시작합니다';
  }

  private canSelfUpdate(): boolean {
    if (!this.deps.isPackaged) return false;
    // Squirrel.Mac validates the signature before swapping the bundle, so an
    // unsigned build downloads and then fails at the last step
    return !(this.deps.platform === 'darwin' && !process.env.GENY_SIGNED);
  }

  /** Start the background schedule. Safe to call once. */
  start(): void {
    if (!this.canSelfUpdate()) {
      this.set({ status: 'unsupported', error: this.describe() });
      return;
    }
    this.timers.push(setTimeout(() => void this.run(false), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => void this.run(false), INTERVAL_MS));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t as NodeJS.Timeout);
    this.timers = [];
  }

  setEnabled(value: boolean): UpdateState {
    this.deps.setEnabled(value);
    // turning it back on should not mean waiting up to six hours to find out
    if (value) void this.run(false);
    else this.set({});
    return this.current;
  }

  private async updater(): Promise<typeof import('electron-updater').autoUpdater> {
    const { autoUpdater } = await import('electron-updater');
    if (!this.wired) {
      this.wired = true;
      // we download on our own terms, per the toggle
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.logger = null;
      autoUpdater.on('download-progress', (p) =>
        this.set({ status: 'downloading', percent: Math.round(p.percent) }));
      autoUpdater.on('update-downloaded', (info) => void this.onDownloaded(info.version));
      autoUpdater.on('error', (err) =>
        this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) }));
    }
    return autoUpdater;
  }

  private async onDownloaded(version: string): Promise<void> {
    this.set({ status: 'ready', version, percent: 100 });
    // A background download interrupts nobody, so it asks. A download the
    // user started by pressing the button does not ask again.
    const go = this.installWhenReady ? true : await this.deps.confirmRestart(version);
    this.installWhenReady = false;
    if (!go) return;
    const { autoUpdater } = await import('electron-updater');
    this.deps.beforeQuitForUpdate?.();
    // Linux packages: install WITHOUT force-run and come back up ourselves.
    // isForceRunAfter goes through Electron's relauncher, which passes
    // NoNewPrivs to the new process; the SUID chrome-sandbox then cannot
    // elevate and the app dies with SIGTRAP on Ubuntu 24.04.
    const linuxPackage = this.deps.platform === 'linux' && !process.env.APPIMAGE;
    autoUpdater.quitAndInstall(!linuxPackage, !linuxPackage);
  }

  /** Manual check: one press, all the way to the new version. */
  async check(): Promise<UpdateState> {
    return this.run(true);
  }

  private async run(manual: boolean): Promise<UpdateState> {
    if (!this.canSelfUpdate()) {
      this.set({ status: 'unsupported', error: this.describe() });
      if (manual && this.deps.platform === 'darwin' && this.deps.isPackaged) {
        const { shell } = await import('electron');
        await shell.openExternal(RELEASES_URL);
      }
      return this.current;
    }

    this.set({ status: 'checking' });
    let latest: string | undefined;
    try {
      const autoUpdater = await this.updater();
      const result = await autoUpdater.checkForUpdates();
      latest = result?.updateInfo?.version;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`[updater] check failed: ${message}`);
      this.set({ status: 'error', error: message, lastCheckedAt: Date.now() });
      return this.current;
    }

    if (!latest || latest === this.deps.version) {
      this.set({ status: 'idle', version: undefined, lastCheckedAt: Date.now() });
      return this.current;
    }

    this.set({ status: 'available', version: latest, lastCheckedAt: Date.now() });

    if (!manual && !this.deps.enabled()) {
      // opted out of being updated, not out of being told
      if (this.notifiedVersion !== latest) {
        this.notifiedVersion = latest;
        this.deps.notify({
          title: '업데이트가 있습니다',
          body: `새 버전 v${latest} — 눌러서 설치하고 재시작합니다`,
          onClick: () => {
            this.installWhenReady = true;
            void this.download();
          },
        });
      }
      return this.current;
    }

    if (manual) this.installWhenReady = true;
    await this.download();
    return this.current;
  }

  private async download(): Promise<void> {
    try {
      this.set({ status: 'downloading', percent: 0 });
      const autoUpdater = await this.updater();
      await autoUpdater.downloadUpdate();
    } catch (err) {
      // silence here is indistinguishable from an update that worked and
      // just did not restart
      this.installWhenReady = false;
      this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Install now, if something is already downloaded. */
  async installNow(): Promise<void> {
    if (this.state.status !== 'ready' || !this.state.version) return;
    this.installWhenReady = true;
    await this.onDownloaded(this.state.version);
  }
}
