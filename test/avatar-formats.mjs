/**
 * Formats whose runtime this app may not ship.
 *
 * Live2D's Cubism Core is proprietary and Spine's runtime needs a licence
 * from Esoteric — so neither is in the installer. The bypass under test:
 * the app writes a display PAGE that loads a runtime out of the model's own
 * `runtime/` folder, and the overlay simply shows that page.
 *
 * What must be true, and is asserted by running it:
 *  · folders are identified by what is in them, not by a manual import
 *  · a model that cannot be shown yet is LISTED, with the exact files it
 *    needs — never silently absent, never a broken overlay
 *  · the generated page explains itself when the runtime is missing
 *  · with the runtime present, the page actually loads it and draws
 *  · an image folder needs no runtime at all
 */
import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-fmt-'));
const avatars = join(dataRoot, 'avatars');
const model = (name) => {
  const dir = join(avatars, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// a 1x1 transparent PNG — an avatar that needs no runtime whatsoever
writeFileSync(
  join(model('picture'), 'idle.png'),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const l2d = model('hiyori');
writeFileSync(join(l2d, 'hiyori.model3.json'), JSON.stringify({ Version: 3, FileReferences: {} }));

const spine = model('hero');
writeFileSync(join(spine, 'hero.atlas'), 'hero.png\nsize: 64,64\nformat: RGBA8888\n');
writeFileSync(join(spine, 'hero.json'), JSON.stringify({ skeleton: { spine: '4.1' } }));

const env = { ...process.env, GENY_DATA_ROOT: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
  env,
});
const main = await app.firstWindow();
await main.waitForLoadState('domcontentloaded');

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const list = () => main.evaluate(() => window.geny.avatar.list());

// ── detection ──────────────────────────────────────────────────────────
let { models } = await list();
const by = (id) => models.find((m) => m.id === id);
check('a picture folder is an avatar', by('picture')?.kind === 'image', by('picture')?.kind);
check('a .model3.json folder is Live2D', by('hiyori')?.kind === 'live2d', by('hiyori')?.kind);
check('an .atlas folder is Spine', by('hero')?.kind === 'spine', by('hero')?.kind);
check(
  'a format we cannot ship is listed with what it needs',
  by('hiyori')?.missing.includes('live2dcubismcore.min.js') && by('hiyori')?.file === '',
  by('hiyori')?.missing.join(', '),
);
check(
  'Spine names its own missing runtime',
  by('hero')?.missing.join(',') === 'spine-player.js,spine-player.css',
  by('hero')?.missing.join(','),
);

// ── refusing honestly ──────────────────────────────────────────────────
await main.evaluate(() => window.geny.avatar.select('hiyori'));
const refusal = await main.evaluate(() =>
  window.geny.avatar.show().then(() => null, (e) => String(e)),
);
check(
  'showing a model that is not ready fails with the reason',
  /live2dcubismcore/.test(refusal ?? ''),
  (refusal ?? '').slice(-70),
);

// ── the scaffold ───────────────────────────────────────────────────────
const made = await main.evaluate(() => window.geny.avatar.scaffold('hiyori'));
check('a display page is written', made.created && made.page.endsWith('index.html'));
check('the folder is now displayable', made.models.find((m) => m.id === 'hiyori')?.kind === 'web');
check(
  'the note says where the runtime goes',
  readFileSync(join(l2d, 'runtime', 'README.txt'), 'utf8').includes('live2dcubismcore.min.js'),
);
const page = readFileSync(made.page, 'utf8');
check('the page points at the real model file', page.includes('hiyori.model3.json'));
check('the page loads its runtime from the folder, never the network',
  page.includes("'runtime/'") && !/https?:\/\//.test(page));

await main.evaluate(() => window.geny.avatar.scaffold('hero'));
check('Spine gets a page too', readFileSync(join(spine, 'index.html'), 'utf8').includes('hero.atlas'));

// ── the page explains itself when the runtime is absent ────────────────
await main.evaluate(() => window.geny.avatar.show());
await main.waitForTimeout(1500);
let overlay = app.windows().find((w) => w.url().includes('avatar.html'));
await overlay.waitForLoadState('domcontentloaded');
const surface = overlay.locator('[data-testid="avatar-surface"]');
await surface.waitFor({ timeout: 5000 });
check('the overlay shows the folder\'s own page', (await surface.getAttribute('data-kind')) === 'web');

const frame = overlay.frameLocator('iframe[title="avatar"]');
await frame.locator('body').waitFor({ timeout: 5000 });
let inside = '';
for (let i = 0; i < 20; i += 1) {
  inside = await frame.locator('body').innerText();
  if (inside.trim()) break;
  await overlay.waitForTimeout(250);
}
check(
  'with no runtime the page names the missing files instead of showing nothing',
  inside.includes('live2dcubismcore.min.js'),
  inside.replace(/\s+/g, ' ').slice(0, 80),
);

// ── with the runtime present, it actually loads ────────────────────────
const runtime = join(l2d, 'runtime');
writeFileSync(join(runtime, 'live2dcubismcore.min.js'), 'window.Live2DCubismCore = { version: 4 };');
writeFileSync(
  join(runtime, 'pixi.min.js'),
  `window.PIXI = { Application: function (o) { this.view = o.view; this.stage = { addChild() {} }; } };`,
);
writeFileSync(
  join(runtime, 'pixi-live2d-display.min.js'),
  `window.PIXI.live2d = { Live2DModel: { from: async () => ({
     width: 100, height: 200, x: 0, y: 0, scale: { set() {} },
     internalModel: {}, expression() { window.__mood = true; },
   }) } };`,
);

({ models } = await list());
check('supplying the runtime clears the warning', by('hiyori')?.missing.length === 0);

await main.evaluate(() => window.geny.avatar.hide());
await main.evaluate(() => window.geny.avatar.show());
await main.waitForTimeout(1500);
overlay = app.windows().find((w) => w.url().includes('avatar.html'));
const frame2 = overlay.frameLocator('iframe[title="avatar"]');
let drew = false;
for (let i = 0; i < 24; i += 1) {
  const [note, canvases] = await Promise.all([
    frame2.locator('body').innerText(),
    frame2.locator('canvas').count(),
  ]);
  if (canvases > 0 && !note.includes('필요합니다') && !note.includes('표시할 수 없습니다')) {
    drew = true;
    break;
  }
  await overlay.waitForTimeout(250);
}
check('the page loads the supplied runtime and draws', drew);

// ── an image needs nothing at all ──────────────────────────────────────
await main.evaluate(() => window.geny.avatar.select('picture'));
await main.waitForTimeout(1200);
overlay = app.windows().find((w) => w.url().includes('avatar.html'));
const shot = overlay.locator('[data-testid="avatar-surface"] img');
await shot.waitFor({ timeout: 5000 });
check('an image avatar displays with no runtime', await shot.isVisible());

await app.close();
const ok = results.every(Boolean);
console.log(`\navatar formats: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
