#!/usr/bin/env node
/** Dev-only: create engine/.venv with the app's pruned dependency set.
 *  Production ships a prebaked tree (see scripts/bundle-python.mjs) —
 *  this exists so `npm run dev` works on a fresh clone. */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE = join(process.cwd(), 'engine');
const VENV = join(ENGINE, '.venv');
const PY = process.platform === 'win32' ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python');

// The app's dependency set: geny-executor WITHOUT numpy / psycopg / pgvector /
// google-genai (numpy has zero call sites in the engine; the others are for
// backends this app does not ship). 89 MB instead of 181 MB.
// SDK majors are PINNED, not floated. geny-executor 2.65.4 declares
// `anthropic>=0.52` — which resolves to 1.0.0 today and breaks the engine
// (`AsyncMessages.stream() got an unexpected keyword argument 'temperature'`).
// These are the versions Geny runs in production, i.e. actually verified.
export const ENGINE_DEPS = [
  'geny-executor==2.65.4',
  'anthropic>=0.122,<1',
  'openai>=3.2,<4',
  'mcp>=1.0.0,<3',
  'pydantic>=2.0',
  'jsonschema>=4.0',
  'httpx>=0.27',
  'websockets>=12.0',
  'pyyaml>=6.0',
  'croniter>=2.0',
  'ddgs>=9.11',
];

const uv = process.env.UV_BIN || 'uv';
const run = (args, opts = {}) => execFileSync(uv, args, { stdio: 'inherit', ...opts });

if (!existsSync(PY)) {
  console.log('› creating engine venv (python 3.12)');
  run(['venv', '--python', '3.12', VENV]);
}
console.log('› installing engine deps (no-deps + explicit closure)');
run(['pip', 'install', '--python', PY, '--no-deps', ...ENGINE_DEPS]);
// resolve the transitive closure of the explicit set, still without the pruned ones
run(['pip', 'install', '--python', PY, 'anthropic>=0.122,<1', 'openai>=3.2,<4', 'mcp>=1.0.0,<3',
     'pydantic>=2.0', 'jsonschema>=4.0', 'httpx>=0.27', 'websockets>=12.0', 'pyyaml>=6.0',
     'croniter>=2.0', 'ddgs>=9.11']);
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
