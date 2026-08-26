/**
 * AvatarController — the avatar as a feature, not just a window.
 *
 * Ties three things together: the models on disk, the overlay window, and
 * the settings that must survive a restart (which model, where it sat, was
 * it showing, was it click-through). The renderer only ever sees the state
 * this class publishes, so the window and the UI cannot disagree.
 */
import { pathToFileURL } from 'node:url';
import type { AvatarModel, AvatarState } from '@shared/api-types';
import { scaffold } from './avatar-scaffold';
import { fetchCubismCore, installBundledRuntime, type RuntimePaths } from './live2d-runtime';
import { avatarsDir, findAvatar, listAvatars } from './avatars';
import { AvatarWindow, type AvatarBounds, type AvatarWindowDeps } from './avatar-window';

const KEYS = {
  model: 'avatar.model',
  visible: 'avatar.visible',
  clickThrough: 'avatar.clickThrough',
  bounds: 'avatar.bounds',
  scale: 'avatar.scale',
} as const;

export interface AvatarSettings {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface AvatarControllerDeps {
  dataRoot: string;
  /** where the app's bundled Live2D (MIT) files live */
  live2d: RuntimePaths;
  settings: AvatarSettings;
  window: Omit<AvatarWindowDeps, 'savedBounds' | 'onBoundsChanged'>;
  /** tell every surface the avatar state changed */
  publish(state: AvatarState): void;
}

const parseBounds = (raw: string | undefined): AvatarBounds | undefined => {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<AvatarBounds>;
    return typeof v.x === 'number' && typeof v.y === 'number' &&
      typeof v.width === 'number' && typeof v.height === 'number'
      ? (v as AvatarBounds)
      : undefined;
  } catch {
    return undefined;
  }
};

export class AvatarController {
  private overlay: AvatarWindow | null = null;

  constructor(private readonly deps: AvatarControllerDeps) {}

  private ensureWindow(): AvatarWindow {
    if (this.overlay) return this.overlay;
    this.overlay = new AvatarWindow({
      ...this.deps.window,
      savedBounds: parseBounds(this.deps.settings.get(KEYS.bounds)),
      onBoundsChanged: (bounds) => this.deps.settings.set(KEYS.bounds, JSON.stringify(bounds)),
    });
    this.overlay.setClickThrough(this.deps.settings.get(KEYS.clickThrough) !== 'false');
    return this.overlay;
  }

  models(): AvatarModel[] {
    return listAvatars(this.deps.dataRoot);
  }

  folder(): string {
    return avatarsDir(this.deps.dataRoot);
  }

  /** The selected model, falling back to the only one installed. Picking for
   *  the user when there is exactly one choice removes a pointless step. */
  selected(): AvatarModel | undefined {
    const id = this.deps.settings.get(KEYS.model);
    const models = this.models();
    if (id) {
      const found = models.find((m) => m.id === id);
      if (found) return found;
    }
    return models.length === 1 ? models[0] : undefined;
  }

  /** Can this model actually be put on screen right now? A Live2D folder
   *  with no page and no runtime is a real model that is not yet showable,
   *  and pretending otherwise makes the overlay open onto nothing. */
  private displayable(model: AvatarModel | undefined): boolean {
    return Boolean(model && model.file);
  }

  /**
   * Write the display page for a Live2D/Spine folder.
   *
   * This is the whole bypass: the app cannot ship those runtimes, but it
   * can write the page that loads them out of the folder — so the format
   * goes from unsupported to "bring the runtime you are licensed for".
   */
  scaffold(modelId: string): { created: boolean; page: string } {
    const model = findAvatar(this.deps.dataRoot, modelId);
    if (!model) throw new Error(`unknown avatar ${modelId}`);
    if (model.kind !== 'live2d' && model.kind !== 'spine') {
      throw new Error(`${model.kind} 은(는) 표시용 페이지가 필요하지 않습니다`);
    }
    const result = scaffold(model.dir, model.kind, (at) =>
      installBundledRuntime(this.deps.live2d, at));
    this.changed();
    return result;
  }

  /**
   * Download Cubism Core into a model's folder, from Live2D's own CDN.
   *
   * Deliberately a separate, explicit action rather than part of scaffolding:
   * it reaches the network and it brings in proprietary code under Live2D's
   * terms, and both of those are the user's decision to make.
   */
  async fetchCore(modelId: string): Promise<{ path: string; bytes: number; cached: boolean }> {
    const model = findAvatar(this.deps.dataRoot, modelId);
    if (!model) throw new Error(`unknown avatar ${modelId}`);
    // A scaffolded Live2D folder reads as `web` (its own page decides how it
    // is shown), so the kind alone cannot answer this — `source` is the file
    // that identified the folder, and for Live2D that is the .model3.json.
    // Re-fetching a folder that already has Core is allowed on purpose: it
    // is how a truncated or corrupted download gets repaired.
    const isLive2d = model.kind === 'live2d' || /\.model3\.json$/i.test(model.source ?? '');
    if (!isLive2d) {
      throw new Error('Cubism Core 는 Live2D 모델에만 필요합니다');
    }
    const result = await fetchCubismCore(model.dir);
    this.changed();
    return result;
  }

  state(): AvatarState {
    const model = this.selected();
    return {
      // only counts models that can actually be shown — a folder waiting on
      // a runtime is listed, but it cannot make the overlay openable
      available: this.models().some((m) => this.displayable(m)),
      visible: this.overlay?.visible ?? false,
      clickThrough: this.overlay?.isClickThrough() ?? this.deps.settings.get(KEYS.clickThrough) !== 'false',
      modelId: model?.id,
      modelName: model?.name,
      kind: model?.kind,
      missing: model?.missing ?? [],
      // the renderer loads textures relative to this, so it must be the real
      // file URL rather than a copy the app serves
      modelUrl: this.displayable(model) ? pathToFileURL(model!.file).href : undefined,
      scale: Number(this.deps.settings.get(KEYS.scale) ?? '1') || 1,
      folder: this.folder(),
    };
  }

  /** Re-inspect the folders and tell every surface. The folders are the
   *  source of truth and they change behind the app's back — a file dropped
   *  into `runtime/` is exactly that. */
  refresh(): AvatarState {
    return this.changed();
  }

  private changed(): AvatarState {
    const state = this.state();
    this.deps.publish(state);
    return state;
  }

  select(modelId: string | null): AvatarState {
    if (modelId && !findAvatar(this.deps.dataRoot, modelId)) {
      throw new Error(`unknown avatar ${modelId}`);
    }
    this.deps.settings.set(KEYS.model, modelId ?? '');
    return this.changed();
  }

  setScale(scale: number): AvatarState {
    this.deps.settings.set(KEYS.scale, String(Math.min(3, Math.max(0.3, scale))));
    return this.changed();
  }

  show(): AvatarState {
    const model = this.selected();
    if (!model) {
      throw new Error('아바타 모델이 없습니다 — 폴더에 모델을 넣어 주세요');
    }
    if (!this.displayable(model)) {
      const need = model.missing.length
        ? ` — ${model.missing.join(', ')} 이(가) 필요합니다`
        : ' — 표시용 페이지를 먼저 만들어 주세요';
      throw new Error(`'${model.name}' 은(는) 아직 표시할 수 없습니다${need}`);
    }
    this.ensureWindow().show();
    this.deps.settings.set(KEYS.visible, 'true');
    return this.changed();
  }

  hide(): AvatarState {
    this.overlay?.hide();
    this.deps.settings.set(KEYS.visible, 'false');
    return this.changed();
  }

  toggle(): AvatarState {
    return this.overlay?.visible ? this.hide() : this.show();
  }

  setClickThrough(enabled: boolean): AvatarState {
    this.ensureWindow().setClickThrough(enabled);
    this.deps.settings.set(KEYS.clickThrough, String(enabled));
    return this.changed();
  }

  /** Restore the overlay if it was showing when the app last closed. */
  restore(): void {
    if (this.deps.settings.get(KEYS.visible) !== 'true') return;
    if (!this.displayable(this.selected())) return;
    this.ensureWindow().show();
  }

  window(): ReturnType<AvatarWindow['window']> {
    return this.overlay?.window() ?? null;
  }

  destroy(): void {
    this.overlay?.destroy();
    this.overlay = null;
  }
}
