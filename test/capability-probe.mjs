/**
 * Capability probe — asks the RUNNING app what the engine actually loaded.
 *
 * Written because README and code disagreed: the engine ships 90 built-in
 * tool classes, the app enables a curated subset, and `capabilities.inspect`
 * reports nothing until the first turn builds the pipeline. Reading either
 * side alone gets this wrong, so this asks the app itself.
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

const deadline = Date.now() + 120_000;
let status = await win.evaluate(() => window.geny.engine.status());
while (status.state !== 'ready' && status.state !== 'failed' && Date.now() < deadline) {
  await win.waitForTimeout(500);
  status = await win.evaluate(() => window.geny.engine.status());
}
if (status.state !== 'ready') {
  console.error('✗ engine', status.state, status.error ?? '');
  process.exit(1);
}

const agent = await win.evaluate(() =>
  window.geny.agents.create({ name: 'cap', provider: 'claude_code_cli' }),
);

const before = await win.evaluate((id) => window.geny.capabilities.inspect(id), agent.id);
console.log('before first turn — tools:', (before.tools ?? []).length);

// the pipeline is built lazily, so one turn has to happen first
await win.evaluate(async (id) => {
  const { turnId } = await window.geny.chat.send({ agentId: id, text: 'say OK' });
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 180_000);
    const off = window.geny.chat.onEvent((e) => {
      if (e.id === turnId && ['done', 'error', 'cancelled'].includes(e.type)) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}, agent.id);

const report = await win.evaluate((id) => window.geny.capabilities.inspect(id), agent.id);
const tools = (report.tools ?? []).slice().sort();
console.log(`\nTOOLS (${tools.length}):`);
console.log('  ' + tools.join(' '));

const expectFamilies = {
  files: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  background: ['TaskCreate', 'TaskList'],
  schedule: ['CronCreate', 'CronList'],
  delegation: ['Agent'],
  host: ['ScreenCapture', 'Notify', 'Say', 'Clipboard'],
};
let ok = true;
for (const [family, names] of Object.entries(expectFamilies)) {
  const missing = names.filter((n) => !tools.includes(n));
  console.log(`  ${family.padEnd(11)} ${missing.length === 0 ? '✓' : '✗ missing ' + missing.join(',')}`);
  if (missing.length) ok = false;
}
console.log('MCP:', JSON.stringify(report.mcpServers ?? []));

if (report.stagesError) console.log('  stagesError:', report.stagesError);
const stages = report.stages ?? [];
console.log(`\nSTAGES (${stages.length}):`);
for (const st of stages) {
  const slots = st.strategies.map((s) => `${s.slot}=${s.current}`).join(' ');
  console.log(`  ${String(st.order).padStart(2)} ${st.name.padEnd(14)} ${slots}`);
}
// the null HITL requester was invisible until someone read this
const hitl = stages.find((s) => s.name === 'hitl');
const requester = hitl?.strategies.find((s) => s.slot === 'requester')?.current;
console.log(`\n  hitl requester = ${requester ?? '(none)'}`);
if (stages.length !== 21) { console.log(`  ✗ expected 21 stages`); ok = false; }

await app.close();
console.log(`\ncapability probe: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
