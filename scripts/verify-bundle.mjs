#!/usr/bin/env node
/**
 * Packaging gate: prove the baked tree is usable BEFORE it becomes an
 * installer. A half-copied or mis-pruned runtime that ships is a support
 * ticket per user; the same failure caught here is a red build.
 *
 * Checks the three things that have actually broken:
 *  1. the interpreter runs and imports the engine (a stripped-wrong or
 *     partially-extracted tree fails here)
 *  2. no pruned dependency crept back in as someone's transitive dep
 *  3. the sidecar speaks protocol v1 — i.e. the app's own layer is present
 *     inside the tree, since `python -I` cannot see PYTHONPATH
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';
const ROOT = join(process.cwd(), 'resources', 'python');
const PY = isWindows ? join(ROOT, 'python.exe') : join(ROOT, 'bin', 'python3');
const die = (m) => { console.error('✗', m); process.exit(1); };

if (!existsSync(PY)) die(`no bundled interpreter at ${PY} — run scripts/bundle-python.mjs`);

const stamp = join(process.cwd(), 'resources', 'RUNTIME_VERSION');
if (existsSync(stamp)) console.log('› stamp:', readFileSync(stamp, 'utf8').replace(/\s+/g, ' ').trim());

// NOTE: importing `geny_app.sidecar` claims fd 1 for the protocol and
// rebinds sys.stdout to stderr (by design — a stray library print must not
// corrupt the stream). So the version probe must NOT import it, or its
// output lands on stderr and reads as empty here.
try {
  const out = execFileSync(
    PY,
    ['-I', '-X', 'utf8', '-c',
      'import geny_executor, ssl, sqlite3, ctypes, anthropic, openai;'
      + 'print(geny_executor.__version__, anthropic.__version__, openai.__version__)'],
    { encoding: 'utf8', timeout: 120_000 },
  ).trim();
  console.log('✓ imports:', out);
  const anthropicVersion = out.split(/\s+/)[1] ?? '';
  if (!anthropicVersion.startsWith('0.')) {
    die(`anthropic ${anthropicVersion} — 1.x removed stream(temperature=), every turn would fail`);
  }
} catch (err) {
  die(`interpreter smoke failed: ${String(err).slice(0, 400)}`);
}

for (const banned of ['numpy', 'psycopg', 'pgvector', 'google.genai']) {
  const probe = execFileSync(PY, ['-I', '-c',
    `try:\n import ${banned}\n print('present')\nexcept Exception:\n print('absent')`],
    { encoding: 'utf8' }).trim();
  if (probe === 'present') die(`pruned dependency '${banned}' shipped — ~90MB of dead weight`);
}
console.log('✓ pruned dependencies absent');

// protocol handshake through the real entrypoint
const child = spawn(PY, ['-I', '-X', 'utf8', '-u', '-m', 'geny_app.sidecar', '--serve'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
const timer = setTimeout(() => die(`sidecar never reported ready\n${stderr}`), 120_000);
child.stdout.once('data', (chunk) => {
  clearTimeout(timer);
  const line = String(chunk).split('\n')[0];
  let msg;
  try { msg = JSON.parse(line); } catch { return die(`non-JSON on protocol stdout: ${line.slice(0, 200)}`); }
  if (msg.type !== 'ready') die(`first message was ${msg.type}, expected ready`);
  if (msg.protocol !== 1) die(`protocol ${msg.protocol}, app speaks 1`);
  console.log(`✓ sidecar ready — engine ${msg.engine}, python ${msg.python}`);
  child.stdin.write(JSON.stringify({ id: 'v', op: 'shutdown' }) + '\n');
  setTimeout(() => { child.kill(); console.log('\nbundle verified'); process.exit(0); }, 3000);
});
