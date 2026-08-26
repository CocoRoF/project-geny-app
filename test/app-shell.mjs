/**
 * The app-shell features: one instance, hotkeys that can be rebound, launch
 * at login, an update path with a real setting, and a log the user can read.
 *
 * These are the ones that fail SILENTLY when they fail — a second instance
 * quietly sharing a database, an accelerator another app already holds, an
 * autostart entry that was never written. So each is asserted by observing
 * the effect, not by reading back the setting that was just stored.
 */
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-shell-'));
const env = { ...process.env, GENY_DATA_ROOT: dataRoot, HOME: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ args: ['.', '--no-sandbox'], env });
const main = await app.firstWindow();
await main.waitForLoadState('domcontentloaded');
await main.evaluate(() => window.geny.onboarding.complete());

// ── single instance ────────────────────────────────────────────────────
// A second copy over one SQLite file and one workspace is real corruption,
// and it looks like a haunting: two trays, two avatars, turns in the wrong
// window. The second launch must die rather than build anything.
let secondLived = true;
try {
  const second = await electron.launch({ args: ['.', '--no-sandbox'], env, timeout: 15000 });
  await second.close().catch(() => {});
} catch {
  secondLived = false;
}
check('a second launch on the same data root refuses to start', !secondLived);

// ── hotkeys ────────────────────────────────────────────────────────────
const listed = await main.evaluate(() => window.geny.hotkeys.list());
check(
  'hotkeys are enumerable, not hardcoded',
  listed.definitions.length >= 2 && listed.state.length === listed.definitions.length,
  listed.definitions.map((d) => d.id).join(', '),
);
const quick = listed.state.find((h) => h.id === 'quickChat');
check('the quick-chat accelerator actually bound', quick?.bound === true, quick?.accelerator);

const rebound = await main.evaluate(() =>
  window.geny.hotkeys.set('quickChat', 'CommandOrControl+Alt+J'),
);
const now = rebound.find((h) => h.id === 'quickChat');
check('it can be rebound at runtime', now?.accelerator === 'CommandOrControl+Alt+J' && now?.bound === true);
const heldByOs = await app.evaluate(({ globalShortcut }) =>
  globalShortcut.isRegistered('CommandOrControl+Alt+J'),
);
check('...and the OS really holds the new one', heldByOs === true);
const oldGone = await app.evaluate(({ globalShortcut }) =>
  globalShortcut.isRegistered('CommandOrControl+Shift+G'),
);
check('...and released the old one', oldGone === false);

const clash = await main.evaluate(() =>
  window.geny.hotkeys
    .set('pushToTalk', 'CommandOrControl+Alt+J')
    .then(() => null, (e) => String(e)),
);
check('two actions cannot claim the same chord', clash !== null, (clash ?? '').slice(-40));

// pausing must actually release the keys, or recording a new one fires the old
await main.evaluate(() => window.geny.hotkeys.pause());
const pausedOff = await app.evaluate(({ globalShortcut }) =>
  globalShortcut.isRegistered('CommandOrControl+Alt+J'),
);
check('pausing releases every accelerator for recording', pausedOff === false);
await main.evaluate(() => window.geny.hotkeys.resume());
const backOn = await app.evaluate(({ globalShortcut }) =>
  globalShortcut.isRegistered('CommandOrControl+Alt+J'),
);
check('resuming binds them again', backOn === true);

// ── autostart ──────────────────────────────────────────────────────────
const on = await main.evaluate(() => window.geny.system.setAutostart(true));
const entry = join(dataRoot, '.config', 'autostart', 'geny-app.desktop');
if (on.applied) {
  check('launch-at-login writes a real desktop entry', existsSync(entry));
  const text = existsSync(entry) ? readFileSync(entry, 'utf8') : '';
  check('...that starts hidden, in the tray', text.includes('--hidden'), text.split('\n')[3] ?? '');
  check('...and the app agrees it is on', await main.evaluate(() => window.geny.system.autostart()));
  await main.evaluate(() => window.geny.system.setAutostart(false));
  check('turning it off removes the entry', !existsSync(entry));
} else {
  // refusing is correct on an ephemeral AppImage mount — but it must SAY so
  check('a refusal explains itself instead of lying', Boolean(on.reason), on.reason);
}

// ── update ─────────────────────────────────────────────────────────────
const update = await main.evaluate(() => window.geny.update.state());
check('the updater says what this platform can do', Boolean(update.channel), update.channel);
const off = await main.evaluate(() => window.geny.update.setEnabled(false));
check('auto-update can be turned off', off.enabled === false);
const back = await main.evaluate(() => window.geny.update.setEnabled(true));
check('...and back on', back.enabled === true);

// ── logs ───────────────────────────────────────────────────────────────
const lines = await main.evaluate(() => window.geny.system.logs());
check('the app keeps a log the user can read', Array.isArray(lines) && lines.length > 0, `${lines.length} lines`);
check(
  'engine output is in it',
  lines.some((l) => l.source === 'engine'),
  [...new Set(lines.map((l) => l.source))].join(', '),
);
const text = await main.evaluate(() => window.geny.system.logText());
check('and it can be copied out as text', text.length > 0);

// ── capture sources ────────────────────────────────────────────────────
const sources = await main.evaluate(() => window.geny.system.captureSources());
check('screens and windows can be enumerated for capture', sources.length > 0,
  `${sources.filter((s) => s.kind === 'screen').length} screen(s), ${sources.filter((s) => s.kind === 'window').length} window(s)`);

// ── the settings pane actually exposes all of it ───────────────────────
// A capability with no way to reach it is a capability the user does not
// have, so the panes are asserted to render, not just to exist in the code.
await main.reload();
await main.waitForLoadState('domcontentloaded');
await main.locator('nav button[title="설정"]').click();
for (const [id, label] of [
  ['hotkey-settings', '단축키'],
  ['computer-use', '컴퓨터 조작'],
  ['update-panel', '업데이트'],
  ['startup-panel', '시작'],
  ['capture-panel', '화면 캡처'],
  ['log-panel', '로그'],
]) {
  const pane = main.locator(`[data-testid="${id}"]`);
  const shown = await pane.isVisible().catch(() => false);
  check(`settings shows ${label}`, shown);
}
// and the hotkey rows are real controls, not static text
const key = main.locator('[data-testid="hotkey-quickChat"]');
check('the hotkey is a control the user can press to rebind',
  await key.isVisible(), (await key.innerText().catch(() => '')).trim());

await app.close();
const ok = results.every(Boolean);
console.log(`\napp shell: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
