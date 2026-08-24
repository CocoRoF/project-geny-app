/**
 * Quick chat — a small always-available window on a global shortcut.
 *
 * The connector's most-used surface: you are in another app, you want to ask
 * the agent something, and opening the full window to do it breaks the
 * thought. Ctrl/Cmd+Shift+G summons a strip, you type, the answer streams in
 * place, Esc dismisses it.
 *
 * It is the SAME renderer bundle with `?surface=quick`, so the chat code has
 * one implementation and the two windows cannot drift apart.
 */
import { join } from 'node:path';
import { BrowserWindow, globalShortcut, screen } from 'electron';

export interface QuickChatDeps {
  preload: string;
  /** dev server URL, or null to load the built file */
  devServerUrl: string | null;
  rendererFile: string;
  onOpen?: () => void;
}

const WIDTH = 620;
const HEIGHT = 420;
export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+G';

export class QuickChat {
  private win: BrowserWindow | null = null;
  private registered: string | null = null;

  constructor(private readonly deps: QuickChatDeps) {}

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: '#0b0d10',
      webPreferences: {
        preload: this.deps.preload,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // dismissing on blur is what makes it feel like a launcher rather than a
    // window you have to clean up after
    win.on('blur', () => this.hide());
    win.on('closed', () => {
      this.win = null;
    });

    if (this.deps.devServerUrl) void win.loadURL(`${this.deps.devServerUrl}?surface=quick`);
    else void win.loadFile(this.deps.rendererFile, { query: { surface: 'quick' } });
    return win;
  }

  toggle(): void {
    if (this.win && this.win.isVisible()) {
      this.hide();
      return;
    }
    this.show();
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create();
    const win = this.win;
    // follow the display the pointer is on — with several monitors, a window
    // pinned to the primary one appears on the wrong screen
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    win.setBounds({
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: Math.round(area.y + area.height * 0.18),
      width: WIDTH,
      height: HEIGHT,
    });
    win.show();
    win.focus();
    this.deps.onOpen?.();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  /** Returns the accelerator actually taken, or null when the OS refused it
   *  (another app owns it) — the caller shows that rather than pretending. */
  registerShortcut(accelerator: string = DEFAULT_SHORTCUT): string | null {
    this.unregisterShortcut();
    try {
      const ok = globalShortcut.register(accelerator, () => this.toggle());
      if (!ok) return null;
      this.registered = accelerator;
      return accelerator;
    } catch {
      return null;
    }
  }

  unregisterShortcut(): void {
    if (!this.registered) return;
    try {
      globalShortcut.unregister(this.registered);
    } catch {
      /* already gone */
    }
    this.registered = null;
  }

  destroy(): void {
    this.unregisterShortcut();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }
}

export function quickChatPaths(dirname: string): { preload: string; rendererFile: string } {
  return {
    preload: join(dirname, '../preload/index.mjs'),
    rendererFile: join(dirname, '../renderer/index.html'),
  };
}
