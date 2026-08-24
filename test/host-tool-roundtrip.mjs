/**
 * Host tool round-trip — the engine asking the app to do something only
 * Electron can do, and getting an answer back.
 *
 * This is the seam that makes "the app owns everything" true: before it
 * existed, nothing the desktop can do could ever be an agent tool. Asserts
 * on the real clipboard, so it proves the call reached Electron and the
 * result reached the model.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { ...process.env, GENY_DATA_ROOT: mkdtempSync(join(tmpdir(), 'geny-host-')) };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({ args: ['.', '--no-sandbox'], env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');

const deadline = Date.now() + 120_000;
let status = await win.evaluate(() => window.geny.engine.status());
while (status.state !== 'ready' && status.state !== 'failed' && Date.now() < deadline) {
  await win.waitForTimeout(500);
  status = await win.evaluate(() => window.geny.engine.status());
}
if (status.state !== 'ready') { console.error('✗ engine', status.state); process.exit(1); }

// seed the real clipboard from the main process
const marker = `geny-host-${Date.now()}`;
await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), marker);
console.log('✓ clipboard seeded:', marker);

const agent = await win.evaluate(() =>
  window.geny.agents.create({ name: 'host', provider: 'claude_code_cli' }),
);

const result = await win.evaluate(async (id) => {
  const tools = [];
  let text = '';
  const off = window.geny.chat.onEvent((e) => {
    if (e.type === 'tool' && e.phase === 'start') tools.push(e.name);
    if (e.type === 'chunk') text += e.text;
  });
  const { turnId } = await window.geny.chat.send({
    agentId: id,
    text: 'Use the Clipboard tool with mode "read" and reply with ONLY the exact text it returns.',
  });
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 180_000);
    const stop = window.geny.chat.onEvent((e) => {
      if (e.id === turnId && ['done', 'error', 'cancelled'].includes(e.type)) {
        clearTimeout(timer); stop(); resolve();
      }
    });
  });
  off();
  return { tools, text };
}, agent.id);

console.log('tools called:', result.tools.join(', ') || '(none)');
console.log('assistant:', result.text.replace(/\n/g, ' ').slice(0, 160));

// under the CLI backend the same tool arrives MCP-namespaced
const usedHostTool = result.tools.some((n) => n === 'Clipboard' || n.endsWith('__Clipboard'));
const gotValue = result.text.includes(marker);
console.log(usedHostTool ? '✓ engine invoked the app-side tool' : '✗ host tool never called');
console.log(gotValue ? '✓ the app’s answer reached the model' : '✗ result did not reach the model');

await app.close();
process.exit(usedHostTool && gotValue ? 0 : 1);
