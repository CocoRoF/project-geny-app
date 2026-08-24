/**
 * Where the app keeps everything. Portable-first by design.
 *
 * The requirement was "agent workspaces under the app's own directory".
 * That is literally right for a dev tree or a USB copy, and impossible for
 * a signed macOS .app or Program Files. So: use `./geny-data` next to the
 * executable when it is actually writable, else fall back to userData.
 * Either way the resolved root is shown in Settings with a reveal button —
 * the user always knows where their agents live.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ResolvedRoot {
  dataRoot: string;
  portable: boolean;
}

const PORTABLE_DIR = 'geny-data';

function writable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.w-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** `override` wins (Settings), then portable, then userData. */
export function resolveDataRoot(input: {
  execPath: string;
  userData: string;
  override?: string;
  isPackaged: boolean;
}): ResolvedRoot {
  if (input.override && writable(input.override)) {
    return { dataRoot: input.override, portable: false };
  }
  // next to the executable — for .app bundles this is Contents/MacOS, which
  // is inside the signature, so the probe correctly refuses it
  const beside = join(dirname(input.execPath), PORTABLE_DIR);
  if (writable(beside)) return { dataRoot: beside, portable: true };

  const fallback = join(input.userData, PORTABLE_DIR);
  mkdirSync(fallback, { recursive: true });
  return { dataRoot: fallback, portable: false };
}

export interface Layout {
  dataRoot: string;
  db: string;
  secrets: string;
  agents: string;
  runtime: string;
  packs: string;
  logs: string;
}

export function layout(dataRoot: string): Layout {
  const l: Layout = {
    dataRoot,
    db: join(dataRoot, 'app.db'),
    secrets: join(dataRoot, 'secrets'),
    agents: join(dataRoot, 'agents'),
    runtime: join(dataRoot, 'runtime'),
    packs: join(dataRoot, 'packs'),
    logs: join(dataRoot, 'logs'),
  };
  for (const dir of [l.secrets, l.agents, l.runtime, l.packs, l.logs]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return l;
}

export function agentDir(l: Layout, agentId: string): string {
  const dir = join(l.agents, agentId);
  for (const sub of ['workspace', 'memory', 'sessions', 'artifacts']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}
