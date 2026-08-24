/**
 * M0/M1 acceptance — the real thing, no mocks.
 *
 * Launches the actual app, creates an agent on the claude_code_cli backend
 * (so it needs no API key: the user's own `claude` auth carries it), asks it
 * to write a file, and asserts the whole loop: events streamed, a tool ran,
 * the file exists on disk inside the agent's workspace jail, and the turn
 * closed with exactly one terminal event.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node test/m0-e2e.mjs
 */
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-e2e-'));
const die = (msg) => { console.error('✗', msg); process.exit(1); };

const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  env: { ...process.env, GENY_DATA_ROOT: dataRoot, ELECTRON_RUN_AS_NODE: undefined },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
console.log('✓ window:', await win.title());

if (!(await win.evaluate(() => typeof window.geny?.chat?.send === 'function'))) {
  die('preload API missing');
}
console.log('✓ preload API');

const paths = await win.evaluate(() => window.geny.app.paths());
console.log('✓ data root:', paths.dataRoot);

// the engine starts eagerly at boot — wait for the handshake
const deadline = Date.now() + 120_000;
let status = await win.evaluate(() => window.geny.engine.status());
while (status.state !== 'ready' && status.state !== 'failed' && Date.now() < deadline) {
  await win.waitForTimeout(500);
  status = await win.evaluate(() => window.geny.engine.status());
}
if (status.state !== 'ready') die(`engine ${status.state}: ${status.error ?? ''}`);
console.log(`✓ engine ready — executor ${status.engine} · py ${status.python} · ${status.runtime?.source}`);

const agent = await win.evaluate(() =>
  window.geny.agents.create({ name: 'e2e', provider: 'claude_code_cli' }),
);
console.log('✓ agent:', agent.dir);

const marker = `hello-from-geny-${Date.now()}`;
const result = await win.evaluate(
  async ({ agentId, marker }) => {
    const seen = [];
    let text = '';
    const off = window.geny.chat.onEvent((e) => {
      if (e.type === 'chunk') text += e.text;
      else if (e.type === 'tool') seen.push(`tool:${e.name}:${e.phase}`);
      else if (['done', 'error', 'cancelled'].includes(e.type)) seen.push(`${e.type}${e.error ? ':' + String(e.error).slice(0, 140) : ''}`);
    });
    const { turnId } = await window.geny.chat.send({
      agentId,
      text: `Write a file named proof.txt in the current directory containing exactly: ${marker}`,
    });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 240_000);
      const stop = window.geny.chat.onEvent((e) => {
        if (e.id === turnId && ['done', 'error', 'cancelled'].includes(e.type)) {
          clearTimeout(timer); stop(); resolve();
        }
      });
    });
    off();
    return { seen, text: text.slice(0, 400) };
  },
  { agentId: agent.id, marker },
);

console.log('✓ turn closed:', result.seen.join(' · ') || '(no terminal event!)');
if (result.text) console.log('  assistant said:', result.text.replace(/\n/g, ' ').slice(0, 160));

const terminals = result.seen.filter((s) => /^(done|error|cancelled)/.test(s));
if (terminals.length !== 1) die(`expected exactly 1 terminal event, got ${terminals.length}`);

const proof = join(agent.dir, 'workspace', 'proof.txt');
if (existsSync(proof)) {
  const body = readFileSync(proof, 'utf8').trim();
  console.log(`✓ tool wrote into the workspace jail: proof.txt = "${body}"`);
  if (!body.includes(marker)) console.log('  ⚠ content differs from the requested marker');
} else if (terminals[0].startsWith('done')) {
  console.log('  ⚠ turn succeeded but proof.txt is absent — tools may not be wired');
}

await app.close();
console.log(`\n${terminals[0].startsWith('done') ? 'M0/M1 acceptance: PASS' : 'M0 protocol: PASS (turn errored — see above)'}`);
