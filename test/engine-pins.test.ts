/**
 * Contract test: the LLM SDK majors are pinned, not floated.
 *
 * geny-executor 2.65.4 declares `anthropic>=0.52` / `openai>=1.50`. Left to
 * float, pip installs anthropic 1.0.0, whose `AsyncMessages.stream()` no
 * longer accepts `temperature` — every turn then fails with an opaque
 * TypeError. These pins are the versions Geny runs in production.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PY = process.platform === 'win32'
  ? join('engine', '.venv', 'Scripts', 'python.exe')
  : join('engine', '.venv', 'bin', 'python');

const read = (mod: string): string =>
  execFileSync(PY, ['-c', `import ${mod};print(${mod}.__version__)`], { encoding: 'utf8' }).trim();

const major = (v: string): number => Number(v.split('.')[0]);
const minor = (v: string): number => Number(v.split('.')[1]);

describe('engine dependency pins', () => {
  it.skipIf(!existsSync(PY))('anthropic stays on 0.x (>=0.122)', () => {
    const v = read('anthropic');
    expect(major(v), `anthropic ${v} — 1.x removed stream(temperature=)`).toBe(0);
    expect(minor(v)).toBeGreaterThanOrEqual(122);
  });

  it.skipIf(!existsSync(PY))('openai stays on 3.x', () => {
    expect(major(read('openai'))).toBe(3);
  });

  it.skipIf(!existsSync(PY))('pruned deps are absent (numpy has zero call sites upstream)', () => {
    for (const mod of ['numpy', 'psycopg', 'pgvector', 'google.genai']) {
      const probe = execFileSync(PY, ['-c', `
try:
    import ${mod}
    print('present')
except Exception:
    print('absent')`], { encoding: 'utf8' }).trim();
      expect(probe, `${mod} should not ship`).toBe('absent');
    }
  });
});
