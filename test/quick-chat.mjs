/**
 * Quick chat is a real surface, not a second app.
 *
 * Asserts: the global shortcut is actually registered with the OS, the strip
 * opens and renders its compact shell, and it shares state with the main
 * window — an agent created there is selectable here, because both windows
 * talk to the same main process.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { ...process.env, GENY_DATA_ROOT: mkdtempSync(join(tmpdir(), 'geny-quick-')) };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({ args: ['.', '--no-sandbox'], env });
const main = await app.firstWindow();
await main.waitForLoadState('domcontentloaded');

const agent = await main.evaluate(() =>
  window.geny.agents.create({ name: 'quick-test', provider: 'claude_code_cli' }),
);
console.log('✓ agent created in the main window:', agent.name);

const registered = await app.evaluate(({ globalShortcut }) =>
  globalShortcut.isRegistered('CommandOrControl+Shift+G'),
);
console.log(registered ? '✓ global shortcut held by the app' : '✗ shortcut not registered');

await main.evaluate(() => window.geny.app.quickChat());
await main.waitForTimeout(1500);

const windows = app.windows();
const strip = windows.find((w) => w.url().includes('surface=quick'));
if (!strip) {
  console.error('✗ quick chat window did not open');
  await app.close();
  process.exit(1);
}
await strip.waitForLoadState('domcontentloaded');
const body = await strip.locator('body').innerText();
console.log('✓ strip rendered:', body.replace(/\s+/g, ' ').slice(0, 70));

const sharesAgent = body.includes('quick-test');
console.log(sharesAgent ? '✓ shares agents with the main window' : '✗ strip has its own state');

const compact = !body.includes('라이브러리');
console.log(compact ? '✓ compact shell (no activity rail)' : '✗ strip rendered the full app');

// It opens as a strip and grows with the answer — a window that starts tall
// is the thing this surface exists to avoid.
const opened = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('surface=quick'));
  return w ? w.getBounds() : null;
});
const compactHeight = Boolean(opened && opened.height <= 160);
console.log(compactHeight ? `✓ opens as a strip (${opened.height}px tall)` : `✗ opened ${opened?.height}px tall`);

// force content in and check the window followed
await strip.evaluate(() => {
  const pane = document.querySelector('[class*="overflow-y-auto"]');
  if (pane) pane.innerHTML = '<div style="height:300px">tall answer</div>';
});
await strip.waitForTimeout(700);
const grown = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('surface=quick'));
  return w ? w.getBounds().height : 0;
});
const grew = grown > (opened?.height ?? 0);
console.log(grew ? `✓ grows to fit the answer (${opened.height} → ${grown}px)` : `✗ did not grow (${grown}px)`);

await app.close();
const ok = registered && sharesAgent && compact && compactHeight && grew;
console.log(`\nquick chat: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
