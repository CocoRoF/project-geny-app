/**
 * M0 acceptance: launch the real app, create an agent, send a turn, watch
 * the sidecar events land in the UI. Uses the claude_code_cli backend so it
 * needs no API key — the user's own CLI auth carries it.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-e2e-'));
const provider = process.env.E2E_PROVIDER || 'claude_code_cli';

// ELECTRON_RUN_AS_NODE must be *absent*, not undefined — with it set the
// binary runs as plain Node and `app` is undefined (a real trap: it is set
// in some dev shells).
const childEnv = { ...process.env, GENY_DATA_ROOT: dataRoot };
delete childEnv.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({ args: ['--no-sandbox', '.'], env: childEnv });
const page = await app.firstWindow();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[renderer error]', m.text().slice(0, 200));
});

const step = (msg) => console.log('•', msg);

await page.waitForSelector('text=Geny', { timeout: 30000 });
step('window up');

// engine must reach ready — it spawns the python sidecar
await page.waitForFunction(
  () => document.body.innerText.includes('engine: ready'),
  undefined,
  { timeout: 120000 },
);
const banner = await page.locator('header').innerText();
step(`engine ready → ${banner.replace(/\s+/g, ' ').slice(0, 120)}`);

// create an agent
await page.click('aside button:has-text("+")');
await page.fill('input[placeholder="이름"]', 'E2E');
await page.selectOption('aside select', provider);
await page.click('button:has-text("만들기")');
await page.waitForSelector('h1:has-text("E2E")', { timeout: 15000 });
step(`agent created (${provider})`);

// send a turn
await page.fill('textarea', '정확히 "PONG" 한 단어만 답해.');
await page.keyboard.press('Enter');
step('turn sent');

// wait for a terminal outcome to appear in the transcript
const deadline = Date.now() + 180000;
let outcome = null;
while (Date.now() < deadline && !outcome) {
  const text = await page.locator('section').last().innerText();
  if (/PONG/i.test(text)) outcome = 'streamed text';
  else if (text.includes('취소됨')) outcome = 'cancelled';
  else {
    const err = await page.locator('.text-red-300').first().innerText().catch(() => '');
    if (err && err.length > 3) outcome = `error: ${err.slice(0, 160)}`;
  }
  if (!outcome) await page.waitForTimeout(1500);
}
const finalText = await page.locator('section').last().innerText();
console.log('\n--- transcript tail ---');
console.log(finalText.split('\n').slice(-14).join('\n'));
console.log('-----------------------');
step(`outcome: ${outcome ?? 'TIMEOUT (no terminal event)'}`);

await app.close();
process.exit(outcome && outcome.startsWith('streamed') ? 0 : 1);
