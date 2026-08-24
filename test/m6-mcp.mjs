/**
 * M6 acceptance — an MCP server added in the app actually reaches the agent.
 *
 * Uses the official filesystem server over npx, so this exercises the real
 * path: definition in SQLite → TurnConfig → engine spawns the child →
 * its tools appear in the session's registry.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-m6-'));
const shared = mkdtempSync(join(tmpdir(), 'geny-m6-shared-'));
writeFileSync(join(shared, 'note.txt'), 'mcp can read this');
const die = (m) => { console.error('✗', m); process.exit(1); };

const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  env: { ...process.env, GENY_DATA_ROOT: dataRoot, ELECTRON_RUN_AS_NODE: undefined },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
const deadline = Date.now() + 120_000;
let s = await win.evaluate(() => window.geny.engine.status());
while (s.state !== 'ready' && s.state !== 'failed' && Date.now() < deadline) {
  await win.waitForTimeout(400);
  s = await win.evaluate(() => window.geny.engine.status());
}
if (s.state !== 'ready') die(`engine ${s.state}`);

// skills/commands folders must exist for the user to drop files into
// MCP connects when the PIPELINE is built, before any API call — so an
// engine-backed agent proves the connection even without a real key.
const agent = await win.evaluate(() =>
  window.geny.agents.create({ name: 'mcp-engine', provider: 'anthropic' }),
);
await win.evaluate(() => window.geny.secrets.setApiKey('anthropic', 'sk-not-real-build-only'));

const server = await win.evaluate((dir) =>
  window.geny.mcp.add({
    name: 'files',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', dir],
  }), shared);
console.log('✓ MCP server registered:', server.name, `${server.command} ${server.args.join(' ')}`);

await win.evaluate(({ agentId, ids }) => window.geny.mcp.setForAgent(agentId, ids),
  { agentId: agent.id, ids: [server.id] });
const mine = await win.evaluate((id) => window.geny.mcp.forAgent(id), agent.id);
if (mine.length !== 1) die('server not enabled for the agent');
console.log('✓ enabled for the agent');

// a turn builds the session, which is when MCP children get spawned
const outcome = await win.evaluate(async (agentId) => {
  const { turnId } = await window.geny.chat.send({ agentId, text: 'Reply with just: ready' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 240_000);
    const stop = window.geny.chat.onEvent((e) => {
      if (e.id === turnId && ['done', 'error', 'cancelled'].includes(e.type)) {
        clearTimeout(timer); stop(); resolve(e.type + (e.error ? ':' + String(e.error).slice(0, 120) : ''));
      }
    });
  });
}, agent.id);
// the turn itself fails on the fake key; what matters is that building the
// session connected the server
console.log('✓ turn (auth failure expected):', outcome.split(':')[0]);

const report = await win.evaluate((id) => window.geny.capabilities.inspect(id), agent.id);
console.log(`✓ engine reports: ${report.tools.length} tools, ${report.mcpServers.length} MCP servers`);
for (const m of report.mcpServers) {
  console.log(`   · ${m.name}: ${m.tools} tools${m.error ? ' — ' + m.error : ''}`);
}
const mcpTools = report.tools.filter((t) => t.startsWith('mcp__'));
if (report.mcpServers.length === 0) die('the configured MCP server never connected');
if (mcpTools.length === 0) die('MCP connected but exposed no tools to the agent');
console.log(`✓ ${mcpTools.length} MCP tools reached the agent (e.g. ${mcpTools.slice(0, 3).join(', ')})`);

// the CLI backend delegates MCP to the CLI itself — the app must SAY so
// rather than report a healthy-looking zero
const cliAgent = await win.evaluate(() =>
  window.geny.agents.create({ name: 'mcp-cli', provider: 'claude_code_cli' }),
);
await win.evaluate(({ agentId, ids }) => window.geny.mcp.setForAgent(agentId, ids),
  { agentId: cliAgent.id, ids: [server.id] });
await win.evaluate(async (agentId) => {
  const { turnId } = await window.geny.chat.send({ agentId, text: 'Reply with just: ok' });
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 180_000);
    const stop = window.geny.chat.onEvent((e) => {
      if (e.id === turnId && ['done', 'error', 'cancelled'].includes(e.type)) {
        clearTimeout(timer); stop(); resolve();
      }
    });
  });
}, cliAgent.id);
const cliReport = await win.evaluate((id) => window.geny.capabilities.inspect(id), cliAgent.id);
const delegated = cliReport.mcpServers.filter((m) => m.state === 'delegated-to-cli');
console.log(`✓ CLI backend: ${cliReport.mcpServers.length} server(s) reported`,
  delegated.length ? '(delegated to the CLI, as designed)' : '');
if (cliReport.mcpServers.length === 0) die('CLI agent reported no MCP servers at all — the app is hiding the handover');

await app.close();
console.log('\nM6 acceptance: PASS');
