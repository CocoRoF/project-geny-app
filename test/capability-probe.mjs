/**
 * Capability probe — asks the RUNNING app what the engine actually loaded.
 *
 * Written because the README and the code disagreed: the engine ships 36
 * built-in tools, the app enables 10, and `capabilities.inspect` reports 0
 * until the first turn builds the pipeline. Reading either side alone gets
 * this wrong, so this asks the app.
 *
 * Needs a model (claude_code_cli auth or an API key).
 * Run: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node test/capability-probe.mjs
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const env = { ...process.env, GENY_DATA_ROOT: mkdtempSync(join(tmpdir(), 'geny-cap-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', '--no-sandbox'], env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
const deadline = Date.now() + 120000;
let st = await win.evaluate(() => window.geny.engine.status());
while (st.state !== 'ready' && st.state !== 'failed' && Date.now() < deadline) {
  await win.waitForTimeout(500); st = await win.evaluate(() => window.geny.engine.status());
}
const agent = await win.evaluate(() => window.geny.agents.create({ name: 'cap', provider: 'claude_code_cli' }));
const before = await win.evaluate((id) => window.geny.capabilities.inspect(id), agent.id);
console.log('BEFORE turn — tools:', (before.tools ?? []).length);
// run one turn so the pipeline is actually built, then ask again
await win.evaluate(async (id) => {
  const { turnId } = await window.geny.chat.send({ agentId: id, text: 'say OK' });
  await new Promise((res) => {
    const t = setTimeout(res, 180000);
    const off = window.geny.chat.onEvent((e) => {
      if (e.id === turnId && ['done','error','cancelled'].includes(e.type)) { clearTimeout(t); off(); res(); }
    });
  });
}, agent.id);
const rep = await win.evaluate((id) => window.geny.capabilities.inspect(id), agent.id);
console.log('TOOLS(' + (rep.tools?.length ?? 0) + '):', (rep.tools ?? []).join(' '));
console.log('MCP:', JSON.stringify(rep.mcpServers ?? []));
console.log('SKILLS:', JSON.stringify(rep.skills ?? []));
console.log('COMMANDS:', JSON.stringify(rep.slashCommands ?? []));
await app.close();
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const env = { ...process.env, GENY_DATA_ROOT: mkdtempSync(join(tmpdir(), 'geny-cap-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', '--no-sandbox'], env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
const deadline = Date.now() + 120000;
let st = await win.evaluate(() => window.geny.engine.status());
while (st.state !== 'ready' && st.state !== 'failed' && Date.now() < deadline) {
  await win.waitForTimeout(500); st = await win.evaluate(() => window.geny.engine.status());
}
const agent = await win.evaluate(() => window.geny.agents.create({ name: 'cap', provider: 'claude_code_cli' }));
const before = await win.evaluate((id) => window.geny.capabilities.inspect(id), agent.id);
console.log('BEFORE turn — tools:', (before.tools ?? []).length);
// run one turn so the pipeline is actually built, then ask again
await win.evaluate(async (id) => {
  const { turnId } = await window.geny.chat.send({ agentId: id, text: 'say OK' });
  await new Promise((res) => {
    const t = setTimeout(res, 180000);
    const off = window.geny.chat.onEvent((e) => {
      if (e.id === turnId && ['done','error','cancelled'].includes(e.type)) { clearTimeout(t); off(); res(); }
    });
  });
}, agent.id);
const rep = await win.evaluate((id) => window.geny.capabilities.inspect(id), agent.id);
console.log('TOOLS(' + (rep.tools?.length ?? 0) + '):', (rep.tools ?? []).join(' '));
console.log('MCP:', JSON.stringify(rep.mcpServers ?? []));
console.log('SKILLS:', JSON.stringify(rep.skills ?? []));
console.log('COMMANDS:', JSON.stringify(rep.slashCommands ?? []));
await app.close();
