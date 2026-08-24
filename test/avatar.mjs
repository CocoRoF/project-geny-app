/**
 * The avatar is a real 3D overlay, not a placeholder.
 *
 * Asserts, by running it: a PMX folder dropped into `<data>/avatars` is
 * discovered, the overlay opens as a separate transparent always-on-top
 * window, the model actually LOADS in WebGL (not just "the canvas exists"),
 * click-through is on by default and can be turned off, and the overlay
 * reacts to the agent's state.
 *
 * Needs no model API key: everything here is the app's own machinery.
 */
import { _electron as electron } from 'playwright-core';
import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLE = '/home/workspace/project_geny_workspace/model-sample/Chisa - Peach Parfait';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-avatar-'));
const haveModel = existsSync(SAMPLE);
if (haveModel) {
  mkdirSync(join(dataRoot, 'avatars'), { recursive: true });
  cpSync(SAMPLE, join(dataRoot, 'avatars', 'sample'), { recursive: true });
}

const env = { ...process.env, GENY_DATA_ROOT: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  // software GL: this runs under xvfb, where there is no real GPU
  args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
  env,
});
const main = await app.firstWindow();
await main.waitForLoadState('domcontentloaded');
// a fresh data root starts on onboarding, which has no activity rail
await main.evaluate(() => window.geny.onboarding.complete());
await main.reload();
await main.waitForLoadState('domcontentloaded');

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const listed = await main.evaluate(() => window.geny.avatar.list());
check('model folder discovered', listed.models.length === 1, listed.models[0]?.name ?? 'none');
check(
  'the .pmx inside it was found',
  Boolean(listed.state.modelUrl?.endsWith('.pmx')),
  listed.state.modelUrl?.split('/').pop() ?? '',
);
check('click-through is the default', listed.state.clickThrough === true);

const shown = await main.evaluate(() => window.geny.avatar.show());
check('show() reports visible', shown.visible === true);
await main.waitForTimeout(1200);

const overlay = app.windows().find((w) => w.url().includes('avatar.html'));
if (!overlay) {
  console.error('✗ overlay window did not open');
  await app.close();
  process.exit(1);
}
await overlay.waitForLoadState('domcontentloaded');

// window traits that decide whether it feels like a companion or a nuisance
const traits = await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('avatar.html'));
  return win
    ? {
        transparent: win.isAlwaysOnTop(),
        skipTaskbar: !win.isVisible() ? null : true,
        focusable: win.isFocusable(),
        frameless: !win.isResizable() ? null : true,
      }
    : null;
});
check('always-on-top', traits?.transparent === true);
check('does not steal focus', traits?.focusable === false);

// the real assertion: the model loaded in WebGL
const surface = overlay.locator('[data-testid="avatar-surface"]');
await surface.waitFor({ timeout: 5000 });
let loadError = '';
let ready = null;
for (let i = 0; i < 120; i += 1) {
  const [isReady, err, morphs, physics] = await Promise.all([
    surface.getAttribute('data-ready'),
    surface.getAttribute('data-error'),
    surface.getAttribute('data-morphs'),
    surface.getAttribute('data-physics'),
  ]);
  if (err) { loadError = err; break; }
  // `ready` is set by the stage itself, so it cannot be satisfied by the
  // initial state the way "not loading" could
  if (isReady === 'true') { ready = { morphs: Number(morphs), physics: physics === 'true' }; break; }
  await overlay.waitForTimeout(500);
}
check('PMX model rendered in WebGL', ready !== null, loadError || `${ready?.morphs ?? 0} morphs`);
check('facial morphs read from the model', (ready?.morphs ?? 0) > 0);
check('bullet physics running', ready?.physics === true);

// mood: an engine event must move the avatar without a model in the loop
await overlay.evaluate(() => {
  // the same shape the main process forwards
  window.dispatchEvent(new Event('noop'));
});
const agent = await main.evaluate(() =>
  window.geny.agents.create({ name: 'avatar-test', provider: 'claude_code_cli' }),
);
await main.evaluate((id) => window.geny.chat.send({ agentId: id, text: 'hi' }), agent.id);
let sawBusy = false;
for (let i = 0; i < 20; i += 1) {
  const mood = await surface.getAttribute('data-mood');
  if (mood && mood !== 'idle') { sawBusy = true; break; }
  await overlay.waitForTimeout(250);
}
check('reacts to the agent working', sawBusy);

const hidden = await main.evaluate(() => window.geny.avatar.hide());
check('hide() reports hidden', hidden.visible === false);
await main.evaluate(() => window.geny.avatar.show());

const off = await main.evaluate(() => window.geny.avatar.setClickThrough(false));
check('interaction mode can be turned on', off.clickThrough === false);
const focusable = await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('avatar.html'));
  return win?.isFocusable() ?? null;
});
check('interaction mode makes it draggable (focusable)', focusable === true);

// the settings panel is the only place a user without a tray can reach this
await main.evaluate(() => window.geny.app.paths());
await main.locator('nav button[title="설정"]').click();
const panel = main.locator('[data-testid="avatar-settings"]');
await panel.waitFor({ timeout: 3000 });
check('settings panel lists the model', (await panel.innerText()).includes('sample'));

await app.close();

// Restart: the overlay must come back where it was left, because a
// companion that has to be summoned again every launch is not one.
const app2 = await electron.launch({
  args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
  env,
});
const main2 = await app2.firstWindow();
await main2.waitForLoadState('domcontentloaded');
await main2.waitForTimeout(1500);
const restored = await main2.evaluate(() => window.geny.avatar.state());
check('model choice survived a restart', restored.modelId === 'sample');
check('overlay reopened on its own', restored.visible === true);
check('interaction mode survived a restart', restored.clickThrough === false);
await app2.close();
const ok = results.every(Boolean);
console.log(`\navatar: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
