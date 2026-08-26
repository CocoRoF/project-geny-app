/**
 * Live2D end to end, with a real model and the real Cubism Core.
 *
 * The licensing split under test:
 *   · pixi + pixi-live2d-display are MIT, so the app installs them itself
 *   · Cubism Core is fetched from Live2D's own CDN into the user's folder,
 *     on an explicit action — the app redistributes none of it
 *
 * Needs the network, and a Live2D model at $GENY_LIVE2D_SAMPLE (a folder
 * with a .model3.json). Skips cleanly without one.
 */
import { _electron as electron } from 'playwright-core';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sample = process.env.GENY_LIVE2D_SAMPLE;
if (!sample || !existsSync(sample)) {
  console.log('· no Live2D sample model (set GENY_LIVE2D_SAMPLE) — skipping');
  process.exit(0);
}

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-l2d-'));
const modelDir = join(dataRoot, 'avatars', 'hiyori');
mkdirSync(join(dataRoot, 'avatars'), { recursive: true });
cpSync(sample, modelDir, { recursive: true });

const env = { ...process.env, GENY_DATA_ROOT: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({
  args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
  env,
});
const main = await app.firstWindow();
await main.waitForLoadState('domcontentloaded');

const listed = await main.evaluate(() => window.geny.avatar.list());
check('the model folder is recognised as Live2D', listed.models[0]?.kind === 'live2d', listed.models[0]?.kind);

// scaffold: the app supplies the MIT half
const made = await main.evaluate(() => window.geny.avatar.scaffold('hiyori'));
check('the app installs the MIT renderer', made.installed.length === 2, made.installed.join(', '));
check(
  'Cubism Core is the only thing left',
  made.models[0]?.missing.join(',') === 'live2dcubismcore.min.js',
  made.models[0]?.missing.join(','),
);

// the one click
const core = await main.evaluate(() => window.geny.avatar.fetchCubismCore('hiyori'));
check('Cubism Core downloads from Live2D', core.bytes > 100000 && !core.cached, `${Math.round(core.bytes / 1024)}KB`);
const coreText = readFileSync(join(modelDir, 'runtime', 'live2dcubismcore.min.js'), 'utf8');
check('it really is Cubism Core', coreText.includes('Live2DCubismCore'));
check(
  'and it kept its own licence header, not ours',
  coreText.includes('Redistributable Code') && coreText.includes('live2d-proprietary-software-license'),
);
check(
  'the terms are written next to it',
  readFileSync(join(modelDir, 'runtime', 'live2dcubismcore.LICENSE.txt'), 'utf8').includes('Expandable'),
);
check('nothing is missing any more', core.models[0]?.missing.length === 0);

const again = await main.evaluate(() => window.geny.avatar.fetchCubismCore('hiyori'));
check('a second fetch reuses the file', again.cached === true);

// the real assertion: it renders
await main.evaluate(() => window.geny.avatar.show());
await main.waitForTimeout(2000);
const overlay = app.windows().find((w) => w.url().includes('avatar.html'));
if (!overlay) {
  console.error('✗ overlay did not open');
  await app.close();
  process.exit(1);
}
await overlay.waitForLoadState('domcontentloaded');
await overlay.locator('[data-testid="avatar-surface"]').waitFor({ timeout: 10000 });

const frame = overlay.frameLocator('iframe[title="avatar"]');
await frame.locator('body').waitFor({ timeout: 10000 });

// The page reports its own result: the app cannot read the iframe's WebGL
// canvas (the drawing buffer is cleared after compositing, so readPixels
// always returns zeros — a false negative that cost a debugging round).
const surface = overlay.locator('[data-testid="avatar-surface"]');
let embed = null;
for (let i = 0; i < 80; i += 1) {
  const [loaded, pixels, err] = await Promise.all([
    surface.getAttribute('data-embed-loaded'),
    surface.getAttribute('data-embed-pixels'),
    surface.getAttribute('data-embed-error'),
  ]);
  if (loaded) { embed = { loaded: loaded === 'true', pixels: Number(pixels), error: err }; break; }
  await overlay.waitForTimeout(500);
}
check('the embedded page reports a loaded model', embed?.loaded === true, embed?.error || '');
check(
  'and it actually drew the character, not an empty stage',
  (embed?.pixels ?? 0) > 5000,
  `${embed?.pixels ?? 0} visible px`,
);

const shot = join(dataRoot, 'live2d.png');
await overlay.screenshot({ path: shot, omitBackground: true }).catch(() => {});
console.log('  screenshot:', shot, existsSync(shot) ? `${statSync(shot).size}B` : '(none)');

await app.close();
const ok = results.every(Boolean);
console.log(`\nlive2d: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
