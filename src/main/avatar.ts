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

  state(): AvatarState {
    const model = this.selected();
    return {
      available: this.models().length > 0,
      visible: this.overlay?.visible ?? false,
      clickThrough: this.overlay?.isClickThrough() ?? this.deps.settings.get(KEYS.clickThrough) !== 'false',
      modelId: model?.id,
      modelName: model?.name,
      // the renderer loads textures relative to this, so it must be the real
      // file URL rather than a copy the app serves
      modelUrl: model ? pathToFileURL(model.file).href : undefined,
      scale: Number(this.deps.settings.get(KEYS.scale) ?? '1') || 1,
      folder: this.folder(),
    };
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
    if (!this.selected()) throw new Error('아바타 모델이 없습니다 — 폴더에 PMX 모델을 넣어 주세요');
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
    if (!this.selected()) return;
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
