/**
 * Does the SHIPPED artifact work?
 *
 * Launches the AppImage itself (not the dev tree) against a clean data root.
 * Packaging is where things break that no dev run can catch, so this checks
 * the specific things asar and a second renderer entry put at risk:
 *
 *  · the bundled Python engine comes up with no interpreter on the machine
 *  · the avatar overlay is a SEPARATE renderer entry (avatar.html) — it
 *    must resolve inside the asar
 *  · babylon-mmd's physics is a .wasm ASSET fetched at runtime; inside an
 *    asar over file:// that is exactly the kind of thing that silently fails
 *  · the overlay's looser CSP travels with it (wasm-unsafe-eval, file:)
 *  · voice settings persist through the packaged SQLite
 *
 * Usage: node test/packaged-app.mjs <path-to-AppImage> [path-to-pmx-folder]
 */
import { _electron as electron } from 'playwright-core';
import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const artifact = process.argv[2];
const sample = process.argv[3] ?? '/home/workspace/project_geny_workspace/model-sample/Chisa - Peach Parfait';
if (!artifact) {
  console.error('usage: node test/packaged-app.mjs <AppImage> [pmx-folder]');
  process.exit(2);
}

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-appimage-'));
const haveModel = existsSync(sample);
if (haveModel) {
  mkdirSync(join(dataRoot, 'avatars'), { recursive: true });
  cpSync(sample, join(dataRoot, 'avatars', 'sample'), { recursive: true });
}

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({
  executablePath: artifact,
  args: [
    '--no-sandbox',
    '--appimage-extract-and-run',
    // no GPU in CI or a headless box; the overlay still has to render
    '--enable-unsafe-swiftshader',
    '--use-gl=swiftshader',
  ],
  env: { ...process.env, GENY_DATA_ROOT: dataRoot, ELECTRON_RUN_AS_NODE: undefined },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
check('packaged app window opens', true, await win.title());

// ── the bundled engine ─────────────────────────────────────────────────
const deadline = Date.now() + 180_000;
let s = await win.evaluate(() => window.geny.engine.status());
while (s.state !== 'ready' && s.state !== 'failed' && Date.now() < deadline) {
  await win.waitForTimeout(600);
  s = await win.evaluate(() => window.geny.engine.status());
}
check(
  'bundled engine starts with no interpreter installed',
  s.state === 'ready',
  s.state === 'ready' ? `executor ${s.engine} · py ${s.python} · runtime ${s.runtime?.source}` : (s.error ?? ''),
);
check('the engine came from the bundle, not the machine', s.runtime?.source !== 'system', s.runtime?.source ?? '');

const paths = await win.evaluate(() => window.geny.app.paths());
console.log('  data root:', paths.dataRoot, paths.portable ? '(portable)' : '');

// ── the tray icon travels as an extraResource ──────────────────────────
// dev reads build/tray.png; packaged reads process.resourcesPath — a
// different path that only a packaged run can prove
const tray = await app.evaluate(() => globalThis.__genyTray ?? null);
check(
  'the tray icon resolves from the packaged resources',
  Boolean(tray) && tray.empty === false,
  tray ? `${tray.size?.width}x${tray.size?.height} — ${tray.path}` : 'no tray',
);

// ── voice settings survive the packaged store ──────────────────────────
await win.evaluate(async () => {
  const c = await window.geny.voice.config();
  await window.geny.voice.save({
    ...c,
    tts: { ...c.tts, provider: 'omnivoice', baseUrl: 'http://packaged.example:9881' },
  });
});
const voice = await win.evaluate(() => window.geny.voice.config());
check(
  'voice settings persist through the packaged SQLite',
  voice.tts.baseUrl === 'http://packaged.example:9881',
  voice.tts.provider,
);

// ── the avatar overlay: a second renderer entry inside the asar ────────
if (!haveModel) {
  console.log('· no sample model on this machine — skipping the overlay checks');
} else {
  const listed = await win.evaluate(() => window.geny.avatar.list());
  check('a model folder in the data root is discovered', listed.models.length === 1, listed.models[0]?.kind);

  await win.evaluate(() => window.geny.avatar.show());
  await win.waitForTimeout(2000);
  const overlay = app.windows().find((w) => w.url().includes('avatar.html'));
  check('the overlay entry resolves inside the asar', Boolean(overlay), overlay?.url().split('/').pop() ?? 'not found');

  if (overlay) {
    await overlay.waitForLoadState('domcontentloaded');
    const surface = overlay.locator('[data-testid="avatar-surface"]');
    await surface.waitFor({ timeout: 10_000 });

    let ready = null;
    let error = '';
    for (let i = 0; i < 150; i += 1) {
      const [isReady, err, morphs, physics] = await Promise.all([
        surface.getAttribute('data-ready'),
        surface.getAttribute('data-error'),
        surface.getAttribute('data-morphs'),
        surface.getAttribute('data-physics'),
      ]);
      if (err) { error = err; break; }
      if (isReady === 'true') { ready = { morphs: Number(morphs), physics: physics === 'true' }; break; }
      await overlay.waitForTimeout(400);
    }
    check('the PMX renders from the packaged bundle', ready !== null, error || `${ready?.morphs ?? 0} morphs`);
    // the one that asar really threatens: a .wasm asset fetched at runtime
    check('the physics .wasm loads out of the asar', ready?.physics === true, error);
  }
}

await app.close();
const ok = results.every(Boolean);
console.log(`\npackaged app: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
