/**
 * M4 acceptance — three backends, explicit models, CLI detection, and the
 * config surface that changes a live session.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-m4-'));
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
console.log('✓ engine ready');

// CLI detection must find the installed claude even without a login shell PATH
const cli = await win.evaluate(() => window.geny.cli.detect());
console.log(cli.found ? `✓ CLI detected: ${cli.version} via ${cli.via}` : `✗ CLI not found: ${cli.error}`);
if (!cli.found) die('claude CLI should be detectable on this machine');

// every backend gets an explicit, non-empty model — never the engine default
for (const provider of ['anthropic', 'openai', 'claude_code_cli']) {
  const a = await win.evaluate((p) => window.geny.agents.create({ name: `m4-${p}`, provider: p }), provider);
  if (!a.model) die(`${provider}: no default model assigned`);
  console.log(`✓ ${provider.padEnd(16)} → model ${a.model}, posture ${a.posture}`);
}

// config changes persist and reach the store
const agents = await win.evaluate(() => window.geny.agents.list());
const target = agents.find((a) => a.provider === 'claude_code_cli');
const updated = await win.evaluate(
  (id) => window.geny.agents.update(id, { posture: 'careful', model: 'haiku', systemPrompt: 'be terse' }),
  target.id,
);
if (updated.posture !== 'careful' || updated.model !== 'haiku' || updated.systemPrompt !== 'be terse') {
  die(`config not applied: ${JSON.stringify(updated)}`);
}
console.log('✓ config applied:', updated.posture, updated.model, `"${updated.systemPrompt}"`);

// secrets round-trip through the OS-appropriate backend
const backend = await win.evaluate(() => window.geny.secrets.backend());
await win.evaluate(() => window.geny.secrets.setApiKey('anthropic', 'sk-test-not-real'));
const stored = await win.evaluate(() => window.geny.secrets.hasApiKey('anthropic'));
await win.evaluate(() => window.geny.secrets.clearApiKey('anthropic'));
const cleared = await win.evaluate(() => window.geny.secrets.hasApiKey('anthropic'));
if (!stored || cleared) die('secret store round-trip failed');
console.log(`✓ secrets: stored/cleared via ${backend}`);

await app.close();
console.log('\nM4 acceptance: PASS');
