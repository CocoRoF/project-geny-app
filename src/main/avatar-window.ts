/**
 * The avatar overlay — a transparent, always-on-top window on the desktop.
 *
 * Behaviour that decides whether it feels like a companion or a nuisance:
 *  · click-through by default. An avatar that eats clicks meant for the
 *    window behind it is worse than no avatar; the user opts into
 *    interaction, and the app says which mode it is in.
 *  · `skipTaskbar` and no focus stealing — it must never take focus from
 *    what the user is typing into.
 *  · placed on the display the pointer is on, bottom-right, and remembered.
 *
 * Transparency has a real caveat on Linux: without a compositor the window
 * shows an opaque background. That is the environment's limitation, not a
 * bug to hide, so the app reports it rather than pretending.
 */
import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';

export interface AvatarBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AvatarWindowDeps {
  preload: string;
  devServerUrl: string | null;
  rendererFile: string;
  /** persisted placement, if the user has moved it before */
  savedBounds?: AvatarBounds;
  onBoundsChanged?: (bounds: AvatarBounds) => void;
}

const DEFAULT_SIZE = { width: 320, height: 460 };
const EDGE_MARGIN = 24;

export class AvatarWindow {
  private win: BrowserWindow | null = null;
  private clickThrough = true;

  constructor(private readonly deps: AvatarWindowDeps) {}

  get visible(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  private defaultBounds(): AvatarBounds {
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    return {
      x: area.x + area.width - DEFAULT_SIZE.width - EDGE_MARGIN,
      y: area.y + area.height - DEFAULT_SIZE.height - EDGE_MARGIN,
      ...DEFAULT_SIZE,
    };
  }

  /**
   * Keep remembered bounds on a display that still exists.
   *
   * Unplug the monitor the avatar was on and the saved position points into
   * nothing: the window opens, reports itself visible, and is nowhere on
   * screen. There is no way back from inside the app, because the app cannot
   * be clicked. So the position is validated every time it is used.
   */
  private clamp(bounds: AvatarBounds): AvatarBounds {
    const displays = screen.getAllDisplays();
    const onScreen = displays.some((d) => {
      const a = d.workArea;
      // a sliver counts: the user can drag it back from a visible corner
      return (
        bounds.x + bounds.width > a.x + 40 &&
        bounds.x < a.x + a.width - 40 &&
        bounds.y + bounds.height > a.y &&
        bounds.y < a.y + a.height - 40
      );
    });
    return onScreen ? bounds : { ...this.defaultBounds(), width: bounds.width, height: bounds.height };
  }

  private create(): BrowserWindow {
    const bounds = this.clamp(this.deps.savedBounds ?? this.defaultBounds());
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // never steal focus from what the user is typing into
      focusable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.deps.preload,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        // the model is loaded from the user's own folder over file://
        webSecurity: false,
      },
    });
    // above full-screen apps too, which is where a companion belongs
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.applyClickThrough(win);

    const remember = (): void => {
      if (!win.isDestroyed()) this.deps.onBoundsChanged?.(win.getBounds());
    };
    win.on('moved', remember);
    win.on('resized', remember);
    win.on('closed', () => {
      this.win = null;
    });

    if (this.deps.devServerUrl) void win.loadURL(`${this.deps.devServerUrl}/avatar.html`);
    else void win.loadFile(this.deps.rendererFile);
    return win;
  }

  private applyClickThrough(win: BrowserWindow): void {
    // `forward: true` keeps hover events flowing so the renderer can still
    // react to the pointer passing over it
    win.setIgnoreMouseEvents(this.clickThrough, { forward: true });
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create();
    else this.win.setBounds(this.clamp(this.win.getBounds()));
    this.win.showInactive();
  }

  /** Put it back where it started — the way out of "I cannot find it". */
  resetPosition(): AvatarBounds {
    const bounds = this.defaultBounds();
    const win = this.window();
    if (win) win.setBounds(bounds);
    this.deps.onBoundsChanged?.(bounds);
    return bounds;
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  setClickThrough(enabled: boolean): boolean {
    this.clickThrough = enabled;
    const win = this.window();
    if (win) {
      // a window that ignores the mouse cannot be dragged, so interaction
      // mode has to make it focusable again
      win.setFocusable(!enabled);
      this.applyClickThrough(win);
    }
    return this.clickThrough;
  }

  isClickThrough(): boolean {
    return this.clickThrough;
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

export function avatarWindowPaths(dirname: string): { preload: string; rendererFile: string } {
  return {
    preload: join(dirname, '../preload/index.mjs'),
    rendererFile: join(dirname, '../renderer/avatar.html'),
  };
}
