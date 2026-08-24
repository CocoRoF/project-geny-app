/**
 * The CI gate: launch the app and prove the whole vertical works.
 *
 * Deliberately does NOT need an API key or the claude CLI — CI has neither.
 * It asserts the parts that must hold for the app to be usable at all:
 * window, preload surface, engine handshake, agent creation with its own
 * folders, file browsing inside the jail (and refusal outside it), MCP
 * registry, and the onboarding gate.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-ci-'));
const die = (m) => { console.error('✗', m); process.exit(1); };

const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  env: { ...process.env, GENY_DATA_ROOT: dataRoot, ELECTRON_RUN_AS_NODE: undefined },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
console.log('✓ window:', await win.title());

for (const surface of ['app', 'engine', 'agents', 'secrets', 'cli', 'mcp', 'capabilities', 'files', 'update', 'onboarding', 'chat']) {
  const ok = await win.evaluate((s) => typeof window.geny?.[s] === 'object', surface);
  if (!ok) die(`preload surface missing: ${surface}`);
}
console.log('✓ preload surface complete');

// onboarding gates the shell on first run
if (await win.evaluate(() => window.geny.onboarding.done())) die('a fresh profile should not be onboarded');
await win.evaluate(() => window.geny.onboarding.complete());
if (!(await win.evaluate(() => window.geny.onboarding.done()))) die('onboarding flag did not persist');
console.log('✓ onboarding gate');

const deadline = Date.now() + 180_000;
let s = await win.evaluate(() => window.geny.engine.status());
while (s.state !== 'ready' && s.state !== 'failed' && Date.now() < deadline) {
  await win.waitForTimeout(500);
  s = await win.evaluate(() => window.geny.engine.status());
}
if (s.state !== 'ready') die(`engine ${s.state}: ${s.error ?? ''}`);
console.log(`✓ engine ready — executor ${s.engine} · python ${s.python} · runtime ${s.runtime?.source}`);

const agent = await win.evaluate(() => window.geny.agents.create({ name: 'ci', provider: 'anthropic' }));
if (!agent.model || !agent.posture) die('agent created without a model or posture');
console.log(`✓ agent: model ${agent.model}, posture ${agent.posture}`);

// file browsing is jailed to the agent's own folders
const listing = await win.evaluate((id) => window.geny.files.list(id), agent.id);
if (!Array.isArray(listing)) die('files.list did not return a listing');
const escaped = await win
  .evaluate(({ id, path }) => window.geny.files.list(id, path).then(() => 'allowed').catch(() => 'refused'),
    { id: agent.id, path: '/etc' });
if (escaped !== 'refused') die('files.list allowed a path outside the agent folders');
console.log('✓ file browsing jailed (escape attempt refused)');

const server = await win.evaluate(() =>
  window.geny.mcp.add({ name: 'ci-server', command: 'echo', args: ['hi'] }));
await win.evaluate(({ a, s }) => window.geny.mcp.setForAgent(a, [s]), { a: agent.id, s: server.id });
const enabled = await win.evaluate((id) => window.geny.mcp.forAgent(id), agent.id);
if (enabled.length !== 1) die('MCP enable did not stick');
console.log('✓ MCP registry');

const capabilities = await win.evaluate((id) => window.geny.capabilities.inspect(id), agent.id);
if (!Array.isArray(capabilities.tools)) die('capabilities.inspect returned nothing usable');
console.log('✓ capabilities inspect reachable');

await app.close();
console.log('\napp launch gate: PASS');
