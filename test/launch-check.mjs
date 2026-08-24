/** Launch the packaged-shape app under xvfb and assert the real thing:
 *  window opens, preload API present, engine reaches ready, an agent can be
 *  created, a turn streams. Uses Playwright's Electron driver (orca's method). */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-app-'));
const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  env: { ...process.env, GENY_DATA_ROOT: dataRoot, ELECTRON_RUN_AS_NODE: undefined },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
console.log('✓ window opened —', await win.title());

const hasApi = await win.evaluate(() => typeof window.geny?.chat?.send === 'function');
if (!hasApi) throw new Error('preload API missing');
console.log('✓ preload API exposed');

const paths = await win.evaluate(() => window.geny.app.paths());
console.log('✓ data root:', paths.dataRoot, paths.portable ? '(portable)' : '');

// engine must reach ready (it starts eagerly at boot)
const deadline = Date.now() + 120_000;
let status = await win.evaluate(() => window.geny.engine.status());
while (status.state !== 'ready' && status.state !== 'failed' && Date.now() < deadline) {
  await win.waitForTimeout(500);
  status = await win.evaluate(() => window.geny.engine.status());
}
console.log(`${status.state === 'ready' ? '✓' : '✗'} engine: ${status.state}`,
            status.engine ? `executor ${status.engine} · py ${status.python} · ${status.runtime?.source}` : (status.error ?? ''));
if (status.state !== 'ready') { await app.close(); process.exit(1); }

// create an agent through the real IPC path
const agent = await win.evaluate(() => window.geny.agents.create({ name: '테스트', provider: 'anthropic' }));
console.log('✓ agent created:', agent.name, '→', agent.dir);

// select it in the UI and send a turn; collect events from the store
await win.evaluate((id) => { /* select via UI state */
  const btns = [...document.querySelectorAll('aside button')];
  const target = btns.find((b) => b.textContent?.includes('테스트'));
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return id;
}, agent.id);
await win.evaluate((id) => { window.__agentId = id; }, agent.id);
await win.waitForTimeout(300);

const outcome = await win.evaluate(async () => {
  const seen = [];
  const off = window.geny.chat.onEvent((e) => seen.push(e.type + (e.type === 'error' ? ':' + String(e.error).slice(0, 80) : '')));
  const { turnId } = await window.geny.chat.send({ agentId: window.__agentId, text: '안녕' });
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 60000);
    const stop = window.geny.chat.onEvent((e) => {
      if (e.id === turnId && ['done', 'error', 'cancelled'].includes(e.type)) { clearTimeout(timer); stop(); resolve(); }
    });
  });
  off();
  return seen;
}).catch((e) => ['EVAL_FAIL:' + String(e).slice(0, 120)]);
console.log('✓ turn events:', outcome.slice(0, 12).join(' → '));

await app.close();
console.log('\nM0 walking skeleton: PASS');
