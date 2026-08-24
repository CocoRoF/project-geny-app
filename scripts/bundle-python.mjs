#!/usr/bin/env node
/**
 * Bake the Python engine into `resources/python` so the installer carries a
 * working interpreter and the app never asks the user to install anything.
 *
 * Choices, all measured rather than assumed:
 *  · python-build-standalone `install_only_stripped` — the plain
 *    `install_only` tarball is 329 MB extracted, of which ~250 MB is debug
 *    symbols; stripped is 99 MB. Hand-running `strip` on the unstripped
 *    build produces a BROKEN interpreter ("undefined symbol: , version"), so
 *    the official stripped asset is the only safe route.
 *  · trim test/idlelib/tkinter/tcl/ensurepip afterwards → ~78 MB, still
 *    imports ssl, sqlite3, ctypes, asyncio. pip STAYS: it is the repair rung
 *    and the way optional feature packs install later.
 *  · dependency set is pinned and pruned (see scripts/engine-deps.mjs):
 *    numpy has zero call sites in the engine, psycopg/pgvector serve a
 *    Postgres path this app never takes, google-genai is a backend we do not
 *    ship. 181 MB → ~94 MB.
 *  · `geny_app` is installed INTO the tree, because the sidecar runs with
 *    `python -I`, which ignores PYTHONPATH by design.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ENGINE_DEPS, PY_SERIES } from './engine-deps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'resources', 'python');
const STAMP = join(ROOT, 'resources', 'RUNTIME_VERSION');

// pinned together: a bump to either must be deliberate, and test/bundle.test.ts locks them
const PBS_RELEASE = '20250808';
const PBS_PYTHON = '3.12.11';

const TRIPLES = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

/** Directories that are pure weight for a headless engine. */
const PRUNE = [
  'lib/python3.12/test',
  'lib/python3.12/idlelib',
  'lib/python3.12/tkinter',
  'lib/python3.12/lib2to3',
  'lib/tcl8.6',
  'lib/tk8.6',
  'lib/tcl8',
  'share',
];

const target = process.env.BUNDLE_TARGET || `${process.platform}-${process.arch}`;
const triple = TRIPLES[target];
if (!triple) {
  console.error(`unsupported target ${target} — known: ${Object.keys(TRIPLES).join(', ')}`);
  process.exit(1);
}

const archive = `cpython-${PBS_PYTHON}+${PBS_RELEASE}-${triple}-install_only_stripped.tar.gz`;
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${archive}`;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

async function download(from, to) {
  console.log('› downloading', from);
  const res = await fetch(from);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(to));
}

const pythonExe = (root) =>
  target.startsWith('win32') ? join(root, 'python.exe') : join(root, 'bin', 'python3');

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(dirname(OUT), { recursive: true });

  const tmp = join(ROOT, '.python-bundle.tar.gz');
  await download(url, tmp);
  console.log('› extracting');
  mkdirSync(OUT, { recursive: true });
  // the archive contains a top-level `python/` — strip it so OUT *is* python/
  run('tar', ['-xzf', tmp, '-C', OUT, '--strip-components=1']);
  rmSync(tmp, { force: true });

  for (const rel of PRUNE) {
    rmSync(join(OUT, rel), { recursive: true, force: true });
  }

  const py = pythonExe(OUT);
  // geny-executor's own metadata declares numpy / psycopg / pgvector /
  // google-genai; installing it normally drags all four back in (measured:
  // +97 MB). Install it WITHOUT deps, then resolve the closure we actually
  // want — exactly what scripts/engine-venv.mjs does for dev.
  console.log('› installing engine (no-deps)');
  const executor = ENGINE_DEPS.find((d) => d.startsWith('geny-executor'));
  run(py, ['-I', '-m', 'pip', 'install', '--no-warn-script-location', '--no-compile', '--no-deps', executor]);
  console.log('› installing dependency closure');
  run(py, [
    '-I', '-m', 'pip', 'install', '--no-warn-script-location', '--no-compile',
    ...ENGINE_DEPS.filter((d) => d !== executor),
  ]);

  console.log('› installing geny_app into the tree');
  run(py, ['-I', '-m', 'pip', 'install', '--no-warn-script-location', '--no-compile', '--no-deps', join(ROOT, 'engine')]);

  // precompiling costs seconds at build time and saves them on every cold
  // start; failures here are not fatal (pyc is an optimisation)
  console.log('› precompiling');
  try {
    run(py, ['-I', '-m', 'compileall', '-q', '-j', '0', OUT], { stdio: 'ignore' });
  } catch {
    console.warn('  (compileall reported errors — continuing)');
  }

  // pip resolution can still pull a pruned package in as someone else's
  // transitive dep — fail loudly rather than ship 90 MB of dead weight
  const banned = ['numpy', 'psycopg', 'pgvector', 'google'];
  for (const name of banned) {
    const dir = join(OUT, 'lib', `python${PY_SERIES}`, 'site-packages', name);
    const winDir = join(OUT, 'Lib', 'site-packages', name);
    if (existsSync(dir) || existsSync(winDir)) {
      throw new Error(`pruned dependency '${name}' is present — check the install order`);
    }
  }

  console.log('› smoke test');
  run(py, ['-I', '-X', 'utf8', '-c', 'import geny_executor, geny_app.sidecar, ssl, sqlite3, ctypes; print("ok")']);

  writeFileSync(
    STAMP,
    JSON.stringify({ python: PBS_PYTHON, pbs: PBS_RELEASE, target, builtAt: new Date().toISOString() }, null, 2),
  );
  console.log(`✓ resources/python ready for ${target}`);
}

await main();
