/**
 * Which Python runs the engine — a self-heal ladder, not a single path.
 *
 * "Download and run" means the interpreter must be in the installer, but a
 * read-only/quarantined app dir, a half-finished copy (Windows MAX_PATH),
 * or antivirus quarantine all happen in the field. So: candidates in
 * priority order, each judged by an *import smoke test* rather than file
 * existence — the lesson xgen-connector paid for twice.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RuntimeSource = 'install' | 'bundle' | 'dev';

export interface RuntimeCandidate {
  source: RuntimeSource;
  /** the tree root that contains python/ */
  root: string;
  exe: string;
  exists: boolean;
  healthy?: boolean;
  error?: string;
}

export function pythonExe(root: string): string {
  return process.platform === 'win32'
    ? join(root, 'python', 'python.exe')
    : join(root, 'python', 'bin', 'python3');
}

/** Smoke = can this interpreter import the engine AND our host layer. */
export async function smoke(exe: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync(exe, ['-I', '-X', 'utf8', '-c', 'import geny_executor, geny_app.sidecar'], {
      cwd,
      timeout: 60_000,
      windowsHide: true,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 400) : String(err) };
  }
}

const cache = new Map<string, { mtimeMs: number; ok: boolean; error?: string }>();

async function cachedSmoke(exe: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(exe).mtimeMs;
  } catch {
    return { ok: false, error: 'missing' };
  }
  const hit = cache.get(exe);
  if (hit && hit.mtimeMs === mtimeMs) return { ok: hit.ok, error: hit.error };
  const result = await smoke(exe, cwd);
  cache.set(exe, { mtimeMs, ok: result.ok, error: result.error });
  return result;
}

export interface LocateInput {
  /** <data-root>/runtime — writable copy, repaired in place */
  installRoot: string;
  /** <resources> in a packaged app — the shipped tree */
  bundleRoot: string | null;
  /** dev tree: engine/.venv */
  devVenvExe: string | null;
  /** cwd for the smoke (dev needs the repo root so geny_app resolves) */
  cwd: string;
}

export interface Located {
  active: RuntimeCandidate | null;
  candidates: RuntimeCandidate[];
}

/** Stops at the first healthy candidate; the rest stay unverified. */
export async function locateRuntime(input: LocateInput): Promise<Located> {
  const candidates: RuntimeCandidate[] = [];
  if (input.devVenvExe) {
    candidates.push({
      source: 'dev',
      root: input.devVenvExe,
      exe: input.devVenvExe,
      exists: existsSync(input.devVenvExe),
    });
  }
  candidates.push({
    source: 'install',
    root: input.installRoot,
    exe: pythonExe(input.installRoot),
    exists: existsSync(pythonExe(input.installRoot)),
  });
  if (input.bundleRoot) {
    candidates.push({
      source: 'bundle',
      root: input.bundleRoot,
      exe: pythonExe(input.bundleRoot),
      exists: existsSync(pythonExe(input.bundleRoot)),
    });
  }

  for (const candidate of candidates) {
    if (!candidate.exists) continue;
    const result = await cachedSmoke(candidate.exe, input.cwd);
    candidate.healthy = result.ok;
    candidate.error = result.error;
    if (result.ok) return { active: candidate, candidates };
  }
  return { active: null, candidates };
}
