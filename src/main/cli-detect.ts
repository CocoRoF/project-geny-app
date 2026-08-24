/**
 * Finding the `claude` CLI.
 *
 * A GUI app does not inherit the user's shell PATH: on macOS a double-clicked
 * .app gets a minimal environment, so a CLI installed by nvm/homebrew/npm is
 * invisible even though it works in the terminal. Rather than tell the user
 * "not installed" when it plainly is, probe the places installers actually
 * use, then fall back to asking their login shell.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

export interface CliInfo {
  found: boolean;
  path?: string;
  version?: string;
  /** how it was found — shown in Settings so a wrong pick is debuggable */
  via?: 'path' | 'known-location' | 'login-shell';
  error?: string;
}

function candidatePaths(binary: string): string[] {
  const home = homedir();
  const exe = isWindows ? `${binary}.cmd` : binary;
  const roots = isWindows
    ? [join(home, 'AppData', 'Roaming', 'npm'), join(home, '.local', 'bin')]
    : [
        join(home, '.local', 'bin'),
        join(home, '.claude', 'local'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        join(home, '.npm-global', 'bin'),
        join(home, '.bun', 'bin'),
      ];
  return roots.map((root) => join(root, exe));
}

async function probe(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(path, ['--version'], {
      timeout: 20_000,
      windowsHide: true,
    });
    return stdout.trim().split('\n')[0] ?? '';
  } catch {
    return null;
  }
}

/** Ask the user's LOGIN shell where the binary is — this is what recovers a
 *  PATH set up by nvm/asdf/homebrew in .zshrc, which the GUI never sees. */
async function askLoginShell(binary: string): Promise<string | null> {
  if (isWindows) return null;
  const shell = process.env.SHELL || '/bin/bash';
  try {
    const { stdout } = await execFileAsync(shell, ['-lic', `command -v ${binary}`], {
      timeout: 20_000,
      windowsHide: true,
    });
    // a login shell may print a banner before the answer
    const line = stdout.trim().split('\n').filter(Boolean).pop();
    return line && existsSync(line) ? line : null;
  } catch {
    return null;
  }
}

export async function detectCli(binary = 'claude'): Promise<CliInfo> {
  const fromEnv = process.env.PATH?.split(delimiter) ?? [];
  const direct = fromEnv.map((dir) => join(dir, isWindows ? `${binary}.cmd` : binary));

  for (const [group, via] of [
    [direct, 'path'],
    [candidatePaths(binary), 'known-location'],
  ] as const) {
    for (const path of group) {
      if (!existsSync(path)) continue;
      const version = await probe(path);
      if (version !== null) return { found: true, path, version, via };
    }
  }

  const shellPath = await askLoginShell(binary);
  if (shellPath) {
    const version = await probe(shellPath);
    if (version !== null) {
      return { found: true, path: shellPath, version, via: 'login-shell' };
    }
  }
  return { found: false, error: `${binary} not found on PATH or in the usual install locations` };
}
