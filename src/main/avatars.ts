/**
 * Avatar models — user-supplied, discovered from a folder.
 *
 * A model is just a folder under `<data-root>/avatars/<name>/`. No import
 * step, no database: copy a folder in and it appears.
 *
 * FIVE KINDS, and the split is a licensing one.
 *
 *  · `mmd`    — a .pmx. Rendered natively: babylon-mmd is MIT and Babylon
 *               is Apache-2.0, so the installer carries the whole runtime.
 *  · `image`  — a png/gif/webp/apng/webm/mp4. Displayed directly. Nothing
 *               to license, nothing to install; the simplest thing that
 *               can possibly be an avatar.
 *  · `web`    — the folder has its own `index.html`. Displayed in a frame.
 *               Whatever runtime it uses is the USER'S, obtained under
 *               whatever licence applies to them.
 *  · `live2d` — a `.model3.json` and no page yet. Live2D's Cubism Core is
 *               proprietary, so the app cannot ship it — but it can write a
 *               display page that loads the Core from the folder, turning
 *               this into `web` the moment the user drops the file in.
 *  · `spine`  — an `.atlas` with a skeleton, same story: the Spine runtime
 *               needs a licence from Esoteric, so the scaffold expects the
 *               user's own `spine-player.js`.
 *
 * The rule that makes this safe and simple: **the installer ships no
 * proprietary bytes, and the app never downloads any.** It only knows how
 * to display what is already in the folder, and says exactly what is
 * missing when something is not.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type AvatarKind = 'mmd' | 'live2d' | 'spine' | 'web' | 'image' | 'unknown';

export interface AvatarModel {
  id: string;
  name: string;
  kind: AvatarKind;
  /** absolute path to the thing the renderer loads — .pmx, index.html, or
   *  the image/video itself. Empty for a kind that is not displayable yet. */
  file: string;
  dir: string;
  bytes: number;
  /** runtime files this kind needs that are not in the folder. Non-empty
   *  means the app can describe the avatar but not yet show it. */
  missing: string[];
  /** what the folder holds that made us guess this kind */
  source?: string;
}

const IMAGE_RE = /\.(gif|apng|png|webp|webm|mp4)$/i;

/** Runtime files each BYO kind needs, by the name the scaffold looks for. */
export const REQUIRED_RUNTIME: Record<'live2d' | 'spine', string[]> = {
  // Cubism Core is Live2D's proprietary file; pixi + pixi-live2d-display are
  // MIT but still the user's download, so the page stays self-contained
  live2d: ['live2dcubismcore.min.js', 'pixi.min.js', 'pixi-live2d-display.min.js'],
  spine: ['spine-player.js', 'spine-player.css'],
};

export function avatarsDir(dataRoot: string): string {
  const dir = join(dataRoot, 'avatars');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Every file in the folder, up to a sane depth, as absolute paths. */
function walkFiles(dir: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (at: string, left: number): void => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        if (left > 0) walk(full, left - 1);
        continue;
      }
      out.push(full);
    }
  };
  walk(dir, depth);
  return out;
}

/** The biggest match wins — costume and variant files ship alongside the
 *  main asset and are always smaller. Same rule the MMD editor's parser uses. */
function biggest(files: string[], pattern: RegExp): { file: string; bytes: number } | null {
  let best: { file: string; bytes: number } | null = null;
  for (const file of files) {
    if (!pattern.test(file)) continue;
    let bytes = 0;
    try {
      bytes = statSync(file).size;
    } catch {
      continue;
    }
    if (!best || bytes > best.bytes) best = { file, bytes };
  }
  return best;
}

const missingRuntime = (dir: string, kind: 'live2d' | 'spine'): string[] =>
  REQUIRED_RUNTIME[kind].filter((name) => !existsSync(join(dir, 'runtime', name)));

/**
 * What is this folder?
 *
 * Order matters: a folder that already has its own `index.html` is `web`
 * whatever else it contains, because the user's page is the authority on
 * how to show it. A `.pmx` beats the rest because it is the one kind the
 * app can render itself.
 */
export function inspectFolder(dir: string): Omit<AvatarModel, 'id' | 'name' | 'dir'> {
  const files = walkFiles(dir);
  const none = { kind: 'unknown' as AvatarKind, file: '', bytes: 0, missing: [] as string[] };

  const page = files.find((f) => /(^|\/)index\.html$/i.test(f));
  const pmx = biggest(files, /\.pmx$/i);
  const model3 = files.find((f) => /\.model3\.json$/i.test(f));
  const atlas = files.find((f) => /\.atlas(\.txt)?$/i.test(f));
  const image = biggest(files, IMAGE_RE);

  if (pmx) return { kind: 'mmd', file: pmx.file, bytes: pmx.bytes, missing: [], source: pmx.file };
  if (page) {
    // a page the user wrote, or one we scaffolded — either way it decides.
    // Report a scaffold's still-missing runtime so the settings panel can
    // say why it will show an explanation instead of a character.
    const kind: AvatarKind = model3 ? 'live2d' : atlas ? 'spine' : 'web';
    const missing = kind === 'live2d' || kind === 'spine' ? missingRuntime(dir, kind) : [];
    return {
      kind: 'web',
      file: page,
      bytes: statSync(page).size,
      missing,
      source: model3 ?? atlas ?? page,
    };
  }
  if (model3) {
    return { kind: 'live2d', file: '', bytes: statSync(model3).size, missing: missingRuntime(dir, 'live2d'), source: model3 };
  }
  if (atlas) {
    return { kind: 'spine', file: '', bytes: statSync(atlas).size, missing: missingRuntime(dir, 'spine'), source: atlas };
  }
  if (image) {
    return { kind: 'image', file: image.file, bytes: image.bytes, missing: [], source: image.file };
  }
  return none;
}

export function listAvatars(dataRoot: string): AvatarModel[] {
  const root = avatarsDir(dataRoot);
  const out: AvatarModel[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    const found = inspectFolder(dir);
    // A folder we cannot identify at all is not listed — but one we can
    // identify and cannot yet SHOW is, so the user learns what is missing
    // instead of watching their model silently fail to appear.
    if (found.kind === 'unknown') continue;
    out.push({ id: entry.name, name: entry.name, dir, ...found });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function findAvatar(dataRoot: string, id: string): AvatarModel | undefined {
  return listAvatars(dataRoot).find((a) => a.id === id);
}

/**
 * A file URL the renderer can load, scoped to the model's own folder.
 *
 * The renderer resolves textures relative to the .pmx, so it needs real file
 * access — but only inside the model directory. Anything that resolves out
 * of it is refused rather than silently served.
 */
export function avatarAssetPath(model: AvatarModel, requested: string): string {
  const full = join(model.dir, requested);
  const rel = relative(model.dir, full);
  if (rel.startsWith('..') || !existsSync(full)) {
    throw new Error(`asset outside the model folder: ${requested}`);
  }
  return full;
}
