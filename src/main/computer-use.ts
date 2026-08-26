/**
 * Computer use — letting the agent drive the machine, and the gate in front
 * of it.
 *
 * Typing and clicking is the one capability where a mistake is not confined
 * to a workspace: the agent is acting as the user, in whatever window
 * happens to be focused. So the default is OFF, consent is per capability
 * rather than one master switch, and asking is the default posture.
 *
 * Three grant levels, because "ask every time" makes a 40-step task
 * unusable and "always allow" is not something to hand over by accident:
 *   ask     — a dialog per action (default)
 *   session — allowed until the app quits, granted from that dialog
 *   auto    — allowed until turned off, chosen deliberately in settings
 */
import { screen as electronScreen } from 'electron';
import type { Backend, MouseButton } from './actuation';
import { detectBackend } from './actuation';

export type Capability = 'input' | 'apps' | 'clipboard';
export type ConsentMode = 'ask' | 'auto';

export interface ComputerUseConfig {
  enabled: boolean;
  input: boolean;
  apps: boolean;
  clipboard: boolean;
  mode: ConsentMode;
}

export const DEFAULT_COMPUTER_USE: ComputerUseConfig = {
  // off until asked for: nothing here should start working because the user
  // installed an update
  enabled: false,
  input: true,
  apps: true,
  clipboard: true,
  mode: 'ask',
};

export interface ComputerUseStatus extends ComputerUseConfig {
  /** which input backend this machine has, and why not if it has none */
  backend: string;
  backendAvailable: boolean;
  backendReason?: string;
  /** capabilities granted for the rest of this run */
  sessionGrants: Capability[];
}

export interface ComputerUseDeps {
  read(): Partial<ComputerUseConfig>;
  write(config: ComputerUseConfig): void;
  /** returns 'allow' | 'session' | 'deny' */
  ask(input: { capability: Capability; action: string; detail: string }): Promise<'allow' | 'session' | 'deny'>;
  clipboardWrite(text: string): void;
  openPath(target: string): Promise<void>;
  log?: (line: string) => void;
}

export class ComputerUse {
  private backend: Backend | null = null;
  private readonly sessionGrants = new Set<Capability>();
  /** the screenshot the model is looking at — its pixel space, not the screen's */
  private captureDims: { width: number; height: number } | null = null;

  constructor(private readonly deps: ComputerUseDeps) {}

  config(): ComputerUseConfig {
    return { ...DEFAULT_COMPUTER_USE, ...this.deps.read() };
  }

  save(patch: Partial<ComputerUseConfig>): ComputerUseConfig {
    const next = { ...this.config(), ...patch };
    this.deps.write(next);
    // narrowing the grant must take effect now, not at the next restart
    if (!next.enabled) this.sessionGrants.clear();
    return next;
  }

  private async ensureBackend(): Promise<Backend> {
    this.backend ??= await detectBackend();
    return this.backend;
  }

  async status(): Promise<ComputerUseStatus> {
    const backend = await this.ensureBackend();
    return {
      ...this.config(),
      backend: backend.id,
      backendAvailable: backend.available,
      backendReason: backend.reason,
      sessionGrants: [...this.sessionGrants],
    };
  }

  /** Remember what the model is looking at, so clicks can be mapped. */
  noteCapture(width: number, height: number): void {
    this.captureDims = { width, height };
  }

  /**
   * Screenshot pixels → screen pixels.
   *
   * The model clicks where it saw the thing, and what it saw was a capture
   * that may have been scaled or taken on a HiDPI display. Both spaces cover
   * the same screen, so the ratio is the whole correction — and it is right
   * at any DPI and any capture size.
   */
  private async mapPoint(x: number, y: number): Promise<{ x: number; y: number }> {
    const dims = this.captureDims;
    if (!dims?.width || !dims.height) return { x, y };
    let target: { width: number; height: number } | null = null;
    try {
      target = await (await this.ensureBackend()).screenSize();
    } catch {
      target = null;
    }
    if (!target) {
      // the backend cannot say; the display's own size is the next best
      // reference and is correct whenever the capture covered one display
      try {
        const size = electronScreen.getPrimaryDisplay().size;
        target = { width: size.width, height: size.height };
      } catch {
        return { x, y };
      }
    }
    if (!target.width || !target.height) return { x, y };
    return {
      x: Math.round((x * target.width) / dims.width),
      y: Math.round((y * target.height) / dims.height),
    };
  }

  private async gate(capability: Capability, action: string, detail: string): Promise<void> {
    const config = this.config();
    if (!config.enabled) {
      throw new Error('컴퓨터 조작이 꺼져 있습니다 — [설정 → 컴퓨터 조작] 에서 켜 주세요');
    }
    if (!config[capability]) {
      throw new Error(`'${capability}' 권한이 꺼져 있습니다`);
    }
    if (config.mode === 'auto' || this.sessionGrants.has(capability)) return;
    const answer = await this.deps.ask({ capability, action, detail });
    if (answer === 'deny') throw new Error('사용자가 거부했습니다');
    if (answer === 'session') this.sessionGrants.add(capability);
  }

  private async withBackend<T>(fn: (b: Backend) => Promise<T>): Promise<T> {
    const backend = await this.ensureBackend();
    if (!backend.available) throw new Error(backend.reason ?? '이 환경에서는 입력을 보낼 수 없습니다');
    return fn(backend);
  }

  async type(text: string): Promise<{ typed: number }> {
    // show what will be typed — approving "type something" is not consent
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    await this.gate('input', '키보드 입력', preview);
    await this.withBackend((b) => b.type(text));
    return { typed: text.length };
  }

  async key(combo: string): Promise<{ combo: string }> {
    await this.gate('input', '키 조합', combo);
    await this.withBackend((b) => b.key(combo));
    return { combo };
  }

  async click(x: number, y: number, button: MouseButton = 'left'): Promise<{ x: number; y: number }> {
    const point = await this.mapPoint(x, y);
    await this.gate('input', '클릭', `${button} @ ${point.x}, ${point.y}`);
    await this.withBackend((b) => b.click(point.x, point.y, button));
    return point;
  }

  async move(x: number, y: number): Promise<{ x: number; y: number }> {
    const point = await this.mapPoint(x, y);
    await this.gate('input', '포인터 이동', `${point.x}, ${point.y}`);
    await this.withBackend((b) => b.move(point.x, point.y));
    return point;
  }

  async scroll(amount: number): Promise<{ amount: number }> {
    await this.gate('input', '스크롤', String(amount));
    await this.withBackend((b) => b.scroll(amount));
    return { amount };
  }

  async openApp(target: string): Promise<{ opened: string }> {
    await this.gate('apps', '앱/파일 열기', target);
    await this.deps.openPath(target);
    return { opened: target };
  }

  async writeClipboard(text: string): Promise<{ length: number }> {
    await this.gate('clipboard', '클립보드 쓰기', text.length > 120 ? `${text.slice(0, 120)}…` : text);
    this.deps.clipboardWrite(text);
    return { length: text.length };
  }

  /** Session grants last exactly one run. */
  clearSessionGrants(): void {
    this.sessionGrants.clear();
  }
}
