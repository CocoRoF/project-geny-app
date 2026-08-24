/**
 * Per-agent tool selection must reach the engine.
 *
 * A settings screen that stores a preference the runtime ignores is worse
 * than no screen: the user believes the agent cannot touch the shell when it
 * still can. Turns Bash off and asserts the engine's own tool list drops it.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { ...process.env, GENY_DATA_ROOT: mkdtempSync(join(tmpdir(), 'geny-tools-')) };
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

const runTurn = (id) =>
  win.evaluate(async (agentId) => {
    const { turnId } = await window.geny.chat.send({ agentId, text: 'say OK' });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 180_000);
      const off = window.geny.chat.onEvent((e) => {
        if (e.id === turnId && ['done', 'error', 'cancelled'].includes(e.type)) {
          clearTimeout(timer); off(); resolve();
        }
      });
    });
  }, id);

const agent = await win.evaluate(() =>
  window.geny.agents.create({ name: 'sel', provider: 'claude_code_cli' }),
);

await runTurn(agent.id);
const before = await win.evaluate((id) => window.geny.capabilities.inspect(id), agent.id);
const hadBash = (before.tools ?? []).includes('Bash');
const hadClip = (before.tools ?? []).includes('Clipboard');
console.log(`default — Bash:${hadBash ? '✓' : '✗'} Clipboard:${hadClip ? '✓' : '✗'} (${before.tools.length} tools)`);

// keep only reading tools: no shell, no desktop
await win.evaluate(
  (id) => window.geny.agents.update(id, { tools: ['Read', 'Glob', 'Grep', 'TodoWrite'] }),
  agent.id,
);
await runTurn(agent.id);
const after = await win.evaluate((id) => window.geny.capabilities.inspect(id), agent.id);
const tools = after.tools ?? [];
console.log(`restricted — ${tools.length} tools: ${tools.slice().sort().join(' ')}`);

const ok =
  hadBash && hadClip &&
  !tools.includes('Bash') &&
  !tools.includes('Clipboard') &&
  tools.includes('Read');
console.log(ok ? '✓ selection reaches the engine' : '✗ the engine ignored the selection');

await app.close();
process.exit(ok ? 0 : 1);
