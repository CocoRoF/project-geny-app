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

await app.close();
const ok = registered && sharesAgent && compact;
console.log(`\nquick chat: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
