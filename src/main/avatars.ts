/**
 * Avatar models — user-supplied, discovered from a folder.
 *
 * Format decision, and it is a licensing one: MMD (PMX) is the only format
 * this app can ship support for outright. babylon-mmd is MIT and Babylon is
 * Apache-2.0, while Live2D's Cubism Core is proprietary (an app may not
 * redistribute it freely) and Spine's runtime needs a licence from Esoteric.
 * Those two stay possible — the user can drop the runtime in themselves —
 * but nothing proprietary ships in the installer.
 *
 * A model is just a folder under `<data-root>/avatars/<name>/` containing a
 * .pmx and its textures. No import step, no database: copy a folder in and
 * it appears.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface AvatarModel {
  id: string;
  name: string;
  /** absolute path to the .pmx */
  file: string;
  dir: string;
  bytes: number;
}

export function avatarsDir(dataRoot: string): string {
  const dir = join(dataRoot, 'avatars');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The biggest .pmx in a folder wins — costume variants ship alongside the
 *  main model and are always smaller. Same rule the editor's parser uses. */
function findModelFile(dir: string): { file: string; bytes: number } | null {
  let best: { file: string; bytes: number } | null = null;
  const walk = (at: string, depth: number): void => {
    if (depth > 3) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.pmx$/i.test(entry.name)) continue;
      const bytes = statSync(full).size;
      if (!best || bytes > best.bytes) best = { file: full, bytes };
    }
  };
  walk(dir, 0);
  return best;
}

export function listAvatars(dataRoot: string): AvatarModel[] {
  const root = avatarsDir(dataRoot);
  const out: AvatarModel[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    const found = findModelFile(dir);
    if (!found) continue;
    out.push({
      id: entry.name,
      name: entry.name,
      file: found.file,
      dir,
      bytes: found.bytes,
    });
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
