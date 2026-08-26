/**
 * Global hotkeys.
 *
 * Two properties that a hardcoded accelerator cannot have:
 *
 *  · **Rebindable.** `CommandOrControl+Shift+G` is already taken on plenty
 *    of desktops. When registration fails, Electron returns false rather
 *    than throwing, so a hardcoded binding fails SILENTLY — the user presses
 *    the key forever and nothing happens. Every binding here reports whether
 *    it actually bound.
 *  · **Pausable.** Capturing a new accelerator means letting the user press
 *    the very keys that are currently registered; without a pause the app
 *    fires the old action instead of recording the new chord.
 *
 * `globalShortcut` has no race-free per-accelerator rebind, so the whole set
 * is unregistered and re-registered together.
 */
import type { GlobalShortcut } from 'electron';

export type HotkeyId = 'quickChat' | 'pushToTalk' | 'toggleAvatar';

export interface HotkeyDefinition {
  id: HotkeyId;
  label: string;
  /** shown when the accelerator is unbound */
  hint: string;
  default: string;
}

export const HOTKEYS: HotkeyDefinition[] = [
  {
    id: 'quickChat',
    label: '퀵챗 열기',
    hint: '다른 앱 위에 떠서 바로 묻습니다',
    default: 'CommandOrControl+Shift+G',
  },
  {
    id: 'pushToTalk',
    label: '말하기 (누르면 녹음)',
    hint: '누를 때마다 마이크가 켜지고 꺼집니다',
    // globalShortcut has no key-up event, so this is a toggle rather than a
    // true push-to-talk — named for what it does, not what we wish it did
    default: 'CommandOrControl+Shift+Space',
  },
  {
    id: 'toggleAvatar',
    label: '아바타 보이기/숨기기',
    hint: '',
    default: '',
  },
];

export const DEFAULT_HOTKEYS: Record<HotkeyId, string> = Object.fromEntries(
  HOTKEYS.map((h) => [h.id, h.default]),
) as Record<HotkeyId, string>;

export interface HotkeyState {
  id: HotkeyId;
  accelerator: string;
  /** false = the OS refused it, almost always because another app holds it */
  bound: boolean;
}

export interface HotkeyDeps {
  shortcut: Pick<GlobalShortcut, 'register' | 'unregisterAll' | 'isRegistered'>;
  /** persisted accelerators, id → accelerator ('' disables) */
  read(): Partial<Record<HotkeyId, string>>;
  write(map: Record<HotkeyId, string>): void;
  fire(id: HotkeyId): void;
}

export class Hotkeys {
  private states: HotkeyState[] = [];
  private paused = false;

  constructor(private readonly deps: HotkeyDeps) {}

  current(): Record<HotkeyId, string> {
    const stored = this.deps.read();
    const out = {} as Record<HotkeyId, string>;
    for (const def of HOTKEYS) {
      const value = stored[def.id];
      // an explicitly-stored '' means the user turned it off, which is
      // different from never having chosen — so only undefined falls back
      out[def.id] = value === undefined ? def.default : value;
    }
    return out;
  }

  /** (Re)bind everything from the current configuration. */
  apply(): HotkeyState[] {
    this.deps.shortcut.unregisterAll();
    this.states = [];
    if (this.paused) return this.states;
    for (const [id, accelerator] of Object.entries(this.current()) as Array<[HotkeyId, string]>) {
      if (!accelerator) {
        this.states.push({ id, accelerator: '', bound: false });
        continue;
      }
      let bound = false;
      try {
        bound = this.deps.shortcut.register(accelerator, () => this.deps.fire(id));
      } catch {
        // an accelerator string Electron cannot parse throws rather than
        // returning false
        bound = false;
      }
      this.states.push({ id, accelerator, bound });
    }
    return this.states;
  }

  state(): HotkeyState[] {
    return this.states.length ? this.states : this.apply();
  }

  set(id: HotkeyId, accelerator: string): HotkeyState[] {
    const next = { ...this.current(), [id]: accelerator.trim() };
    // the same chord on two actions binds whichever registers first and
    // leaves the other mysteriously dead — refuse instead
    for (const [other, value] of Object.entries(next) as Array<[HotkeyId, string]>) {
      if (other !== id && value && value === accelerator.trim()) {
        throw new Error(`이미 '${HOTKEYS.find((h) => h.id === other)?.label}' 에 쓰이는 단축키입니다`);
      }
    }
    this.deps.write(next);
    return this.apply();
  }

  reset(): HotkeyState[] {
    this.deps.write({ ...DEFAULT_HOTKEYS });
    return this.apply();
  }

  /** Release every accelerator so the user can press one to record it. */
  pause(): void {
    this.paused = true;
    this.deps.shortcut.unregisterAll();
  }

  resume(): HotkeyState[] {
    this.paused = false;
    return this.apply();
  }

  dispose(): void {
    this.deps.shortcut.unregisterAll();
  }
}
