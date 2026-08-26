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
import { BrowserWindow, screen } from 'electron';

export interface QuickChatDeps {
  preload: string;
  /** dev server URL, or null to load the built file */
  devServerUrl: string | null;
  rendererFile: string;
  onOpen?: () => void;
}

const WIDTH = 620;
/** Opens as a single input row and grows with the answer — a strip that
 *  starts 420px tall is a window, and a window is what this exists to avoid. */
const MIN_HEIGHT = 92;
const MAX_HEIGHT = 620;
/** Kept for the settings default; the binding itself lives in hotkeys.ts,
 *  which can rebind it and report when the OS refuses. */
export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+G';

export class QuickChat {
  private win: BrowserWindow | null = null;

  constructor(private readonly deps: QuickChatDeps) {}

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: WIDTH,
      height: MIN_HEIGHT,
      minHeight: MIN_HEIGHT,
      maxHeight: MAX_HEIGHT,
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

  /**
   * Grow or shrink to fit the content.
   *
   * Called by the renderer as the answer streams in. The top edge stays put
   * so the text the user is reading does not slide up the screen.
   */
  resize(height: number): void {
    const win = this.window();
    if (!win) return;
    const next = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
    const bounds = win.getBounds();
    if (Math.abs(bounds.height - next) < 4) return;
    win.setBounds({ ...bounds, height: next }, false);
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
      // every summon starts as a single input row again, whatever the last
      // answer grew it to
      height: MIN_HEIGHT,
    });
    win.show();
    win.focus();
    this.deps.onOpen?.();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  destroy(): void {
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
