#!/usr/bin/env node
/** Dev-only: create engine/.venv with the app's pruned dependency set.
 *  Production ships a prebaked tree (see scripts/bundle-python.mjs) —
 *  this exists so `npm run dev` works on a fresh clone. */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_DEPS } from './engine-deps.mjs';

const ENGINE = join(process.cwd(), 'engine');
const VENV = join(ENGINE, '.venv');
const PY = process.platform === 'win32' ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python');

const uv = process.env.UV_BIN || 'uv';
const run = (args, opts = {}) => execFileSync(uv, args, { stdio: 'inherit', ...opts });

if (!existsSync(PY)) {
  console.log('› creating engine venv (python 3.12)');
  run(['venv', '--python', '3.12', VENV]);
}
// `--no-deps` for geny-executor keeps its numpy/psycopg/pgvector/google-genai
// declarations out; the rest of the list IS the closure we do want, resolved
// normally so their own transitive deps come along.
console.log('› installing engine deps');
run(['pip', 'install', '--python', PY, '--no-deps', 'geny-executor==2.65.4']);
run(['pip', 'install', '--python', PY, ...ENGINE_DEPS.filter((d) => !d.startsWith('geny-executor'))]);
// Make `python -I -m geny_app.sidecar` resolve. `-I` ignores PYTHONPATH by
// design (that isolation is what keeps a user's stray PYTHONPATH from
// hijacking the engine), so dev cannot rely on env vars: drop a .pth into
// site-packages pointing at engine/. Production bakes geny_app INTO the
// bundled tree's site-packages, so both paths resolve identically.
const sitePackages = process.platform === 'win32'
  ? join(VENV, 'Lib', 'site-packages')
  : join(VENV, 'lib', `python3.12`, 'site-packages');
writeFileSync(join(sitePackages, 'geny_app_dev.pth'), ENGINE + '\n');
console.log('› geny_app linked via .pth →', ENGINE);
console.log('✓ engine venv ready:', PY);
