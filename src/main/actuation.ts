/**
 * Synthesising keyboard and mouse input, without a native module.
 *
 * The connector does this with nut.js, which is a native addon — an ABI
 * rebuild per Electron version and a prebuild per platform. This app's whole
 * "download and run" property rests on having zero native modules, so
 * instead every platform's own tooling does the work:
 *
 *   · macOS   — `osascript` / System Events. Always present.
 *   · Windows — PowerShell with SendKeys and user32. Always present.
 *   · Linux   — `xdotool` on X11, `ydotool` on Wayland. NOT always present,
 *               so this is the one platform that can report "unavailable",
 *               with the package to install.
 *
 * Every command runs through execFile with an argument array — never a
 * shell string. The text being typed is arbitrary model output, and a shell
 * would treat it as syntax.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type MouseButton = 'left' | 'right' | 'middle';

export interface Backend {
  id: string;
  available: boolean;
  /** why not, and what to do about it */
  reason?: string;
  type(text: string): Promise<void>;
  /** a chord like `ctrl+c`, `cmd+shift+4`, `Return` */
  key(combo: string): Promise<void>;
  click(x: number, y: number, button: MouseButton): Promise<void>;
  move(x: number, y: number): Promise<void>;
  scroll(amount: number): Promise<void>;
  /** screen size in the same pixel space as click coordinates */
  screenSize(): Promise<{ width: number; height: number } | null>;
}

const has = async (command: string): Promise<boolean> => {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', [command]);
    return true;
  } catch {
    return false;
  }
};

const unavailable = (id: string, reason: string): Backend => ({
  id,
  available: false,
  reason,
  type: () => Promise.reject(new Error(reason)),
  key: () => Promise.reject(new Error(reason)),
  click: () => Promise.reject(new Error(reason)),
  move: () => Promise.reject(new Error(reason)),
  scroll: () => Promise.reject(new Error(reason)),
  screenSize: () => Promise.resolve(null),
});

const BUTTON_X11: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };

function xdotoolBackend(): Backend {
  const x = (args: string[]): Promise<unknown> => run('xdotool', args, { timeout: 15_000 });
  return {
    id: 'xdotool',
    available: true,
    async type(text) {
      // --clearmodifiers so a still-held Ctrl from the user's own keypress
      // does not turn the typed text into shortcuts; `--` ends option
      // parsing so text starting with '-' is not read as a flag
      await x(['type', '--clearmodifiers', '--delay', '12', '--', text]);
    },
    async key(combo) {
      await x(['key', '--clearmodifiers', combo]);
    },
    async click(px, py, button) {
      await x(['mousemove', String(Math.round(px)), String(Math.round(py))]);
      await x(['click', BUTTON_X11[button]]);
    },
    async move(px, py) {
      await x(['mousemove', String(Math.round(px)), String(Math.round(py))]);
    },
    async scroll(amount) {
      // X11 has no scroll amount: it is repeated button 4 (up) / 5 (down)
      const button = amount < 0 ? '4' : '5';
      for (let i = 0; i < Math.min(Math.abs(Math.round(amount)), 30); i += 1) {
        await x(['click', button]);
      }
    },
    async screenSize() {
      try {
        const { stdout } = await run('xdotool', ['getdisplaygeometry'], { timeout: 8000 });
        const [w, h] = stdout.trim().split(/\s+/).map(Number);
        return w && h ? { width: w, height: h } : null;
      } catch {
        return null;
      }
    },
  };
}

/** Wayland has no xdotool; ydotool talks to uinput instead. */
function ydotoolBackend(): Backend {
  const y = (args: string[]): Promise<unknown> => run('ydotool', args, { timeout: 15_000 });
  const BUTTON: Record<MouseButton, string> = { left: '0xC0', middle: '0xC2', right: '0xC1' };
  return {
    id: 'ydotool',
    available: true,
    async type(text) {
      await y(['type', '--key-delay', '12', '--', text]);
    },
    async key(combo) {
      await y(['key', combo]);
    },
    async click(px, py, button) {
      await y(['mousemove', '--absolute', '-x', String(Math.round(px)), '-y', String(Math.round(py))]);
      await y(['click', BUTTON[button]]);
    },
    async move(px, py) {
      await y(['mousemove', '--absolute', '-x', String(Math.round(px)), '-y', String(Math.round(py))]);
    },
    async scroll(amount) {
      await y(['mousemove', '--wheel', '-y', String(Math.round(-amount))]);
    },
    screenSize: () => Promise.resolve(null),
  };
}

function macBackend(): Backend {
  const osa = (script: string): Promise<unknown> =>
    run('osascript', ['-e', script], { timeout: 15_000 });
  // AppleScript string literals escape only backslash and double quote
  const lit = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const MODIFIERS: Record<string, string> = {
    cmd: 'command down', command: 'command down', meta: 'command down',
    ctrl: 'control down', control: 'control down',
    alt: 'option down', option: 'option down',
    shift: 'shift down',
  };
  const NAMED: Record<string, number> = {
    return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
    escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
    home: 115, end: 119, pageup: 116, pagedown: 121,
  };
  return {
    id: 'osascript',
    available: true,
    async type(text) {
      await osa(`tell application "System Events" to keystroke ${lit(text)}`);
    },
    async key(combo) {
      const parts = combo.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
      const key = parts.pop() ?? '';
      const mods = parts.map((p) => MODIFIERS[p]).filter(Boolean);
      const using = mods.length ? ` using {${mods.join(', ')}}` : '';
      const code = NAMED[key];
      const action = code !== undefined ? `key code ${code}` : `keystroke ${lit(key)}`;
      await osa(`tell application "System Events" to ${action}${using}`);
    },
    async click(px, py, button) {
      // System Events clicks at a point; a right-click is a control-click
      const at = `at {${Math.round(px)}, ${Math.round(py)}}`;
      const using = button === 'right' ? ' using {control down}' : '';
      await osa(`tell application "System Events" to click ${at}${using}`);
    },
    async move(px, py) {
      // no pointer-move primitive without a helper binary; clicking moves it
      await osa(`tell application "System Events" to click at {${Math.round(px)}, ${Math.round(py)}}`);
    },
    async scroll(amount) {
      const key = amount < 0 ? 126 : 125; // arrow up / down
      for (let i = 0; i < Math.min(Math.abs(Math.round(amount)), 30); i += 1) {
        await osa(`tell application "System Events" to key code ${key}`);
      }
    },
    screenSize: () => Promise.resolve(null),
  };
}

function windowsBackend(): Backend {
  /** Run PowerShell with the script on STDIN — no quoting problems at all. */
  const ps = (script: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '-'],
        { timeout: 20_000 },
        (err) => (err ? reject(err) : resolve()),
      );
      child.stdin?.end(script);
    });
  // SendKeys treats these as syntax; braces around them make them literal
  const escapeSendKeys = (s: string): string => s.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
  const SENDKEYS: Record<string, string> = {
    enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
    space: ' ', backspace: '{BACKSPACE}', delete: '{DELETE}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  };
  const MODS: Record<string, string> = { ctrl: '^', control: '^', alt: '%', shift: '+', win: '^{ESC}' };
  const USER32 = `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, int e);
'@`;
  return {
    id: 'powershell',
    available: true,
    async type(text) {
      // a here-string keeps arbitrary text out of PowerShell's parser
      const literal = escapeSendKeys(text).replace(/\r?\n/g, '{ENTER}');
      await ps(
        `Add-Type -AssemblyName System.Windows.Forms\n` +
        `[System.Windows.Forms.SendKeys]::SendWait(@'\n${literal}\n'@)`,
      );
    },
    async key(combo) {
      const parts = combo.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
      const key = parts.pop() ?? '';
      const prefix = parts.map((p) => MODS[p] ?? '').join('');
      const body = SENDKEYS[key] ?? escapeSendKeys(key);
      await ps(
        `Add-Type -AssemblyName System.Windows.Forms\n` +
        `[System.Windows.Forms.SendKeys]::SendWait(@'\n${prefix}${body}\n'@)`,
      );
    },
    async click(px, py, button) {
      const down = button === 'right' ? '0x0008' : button === 'middle' ? '0x0020' : '0x0002';
      const up = button === 'right' ? '0x0010' : button === 'middle' ? '0x0040' : '0x0004';
      await ps(
        `${USER32}\n[W.U]::SetCursorPos(${Math.round(px)}, ${Math.round(py)})\n` +
        `[W.U]::mouse_event(${down},0,0,0,0)\n[W.U]::mouse_event(${up},0,0,0,0)`,
      );
    },
    async move(px, py) {
      await ps(`${USER32}\n[W.U]::SetCursorPos(${Math.round(px)}, ${Math.round(py)})`);
    },
    async scroll(amount) {
      await ps(`${USER32}\n[W.U]::mouse_event(0x0800,0,0,${Math.round(-amount) * 120},0)`);
    },
    screenSize: () => Promise.resolve(null),
  };
}

/** Pick the backend for this machine, once. */
export async function detectBackend(platform: NodeJS.Platform = process.platform): Promise<Backend> {
  if (platform === 'darwin') return macBackend();
  if (platform === 'win32') return windowsBackend();

  const wayland = Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
  if (wayland) {
    if (await has('ydotool')) return ydotoolBackend();
    // xdotool still works for XWayland clients, so it is worth trying
    if (await has('xdotool')) return xdotoolBackend();
    return unavailable(
      'none',
      'Wayland 에서 입력을 보내려면 ydotool 이 필요합니다 — sudo apt install ydotool (ydotoold 실행 필요)',
    );
  }
  if (await has('xdotool')) return xdotoolBackend();
  return unavailable('none', 'X11 에서 입력을 보내려면 xdotool 이 필요합니다 — sudo apt install xdotool');
}
