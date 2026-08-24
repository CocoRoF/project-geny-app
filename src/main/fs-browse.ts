/**
 * Reading the agent's own folders — workspace, memory, artifacts.
 *
 * Every path is resolved against an allowed root and rejected if it escapes:
 * the renderer is not trusted to send a safe path, and a `..` here would let
 * a compromised page read the whole disk through IPC. Symlinks are resolved
 * before the check for the same reason.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface FilePreview {
  path: string;
  kind: 'text' | 'image' | 'binary';
  /** utf-8 for text, data URI for image, empty for binary */
  content: string;
  size: number;
  truncated: boolean;
}

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sh', '.bash', '.zsh', '.fish',
  '.html', '.css', '.scss', '.sql', '.csv', '.tsv', '.log', '.env', '.gitignore',
  '.rs', '.go', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.rb', '.php', '.swift', '.xml',
]);
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Resolve `target` and prove it stays under one of `roots`. */
export async function withinRoots(target: string, roots: string[]): Promise<string> {
  const wanted = resolve(target);
  // realpath so a symlink cannot point out of the jail; fall back to the
  // lexical path when the file does not exist yet
  let real = wanted;
  try {
    real = await realpath(wanted);
  } catch {
    /* not created yet — the lexical check below still applies */
  }
  for (const root of roots) {
    const base = resolve(root);
    const rel = relative(base, real);
    if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`))) return real;
  }
  throw new Error('path is outside the agent folders');
}

export async function listDir(target: string, roots: string[]): Promise<DirEntry[]> {
  const dir = await withinRoots(target, roots);
  const names = await readdir(dir, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const entry of names) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    try {
      const info = await stat(full);
      out.push({
        name: entry.name,
        path: full,
        isDir: info.isDirectory(),
        size: info.size,
        modified: info.mtimeMs,
      });
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  // folders first, then newest content, which is what an agent's output
  // folder is usually being read for
  out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.modified - a.modified);
  return out;
}

export async function preview(target: string, roots: string[]): Promise<FilePreview> {
  const file = await withinRoots(target, roots);
  const info = await stat(file);
  const ext = extname(file).toLowerCase();

  if (IMAGE_MIME[ext] && info.size <= MAX_IMAGE_BYTES) {
    const buffer = await readFile(file);
    return {
      path: file,
      kind: 'image',
      content: `data:${IMAGE_MIME[ext]};base64,${buffer.toString('base64')}`,
      size: info.size,
      truncated: false,
    };
  }

  if (TEXT_EXT.has(ext) || info.size <= 64 * 1024) {
    const buffer = await readFile(file);
    const slice = buffer.subarray(0, MAX_TEXT_BYTES);
    // a NUL byte in the first block is the cheap, reliable binary tell
    if (slice.includes(0)) {
      return { path: file, kind: 'binary', content: '', size: info.size, truncated: false };
    }
    return {
      path: file,
      kind: 'text',
      content: slice.toString('utf8'),
      size: info.size,
      truncated: info.size > MAX_TEXT_BYTES,
    };
  }
  return { path: file, kind: 'binary', content: '', size: info.size, truncated: false };
}
