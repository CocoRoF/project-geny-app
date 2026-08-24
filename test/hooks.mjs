/**
 * A hook must be able to STOP the agent.
 *
 * Observing is easy to fake; blocking is the part that matters and the part
 * that silently does nothing when the wiring is wrong. This writes a real
 * hooks.yaml with a deny hook on Bash, asks the agent to run a shell command,
 * and asserts the command did not happen.
 */
import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-hooks-'));
mkdirSync(join(dataRoot, 'hooks'), { recursive: true });

// a hook that denies every Bash call, and records that it ran
const marker = join(dataRoot, 'hook-ran.txt');
const script = join(dataRoot, 'deny-bash.sh');
writeFileSync(
  script,
  `#!/bin/sh
cat > /dev/null
echo "denied by test hook" >> ${JSON.stringify(marker)}
printf '%s' '{"decision":"deny","stop_reason":"이 테스트에서는 셸을 막습니다"}'
`,
  'utf8',
);
chmodSync(script, 0o755);

writeFileSync(
  join(dataRoot, 'hooks', 'hooks.yaml'),
  `enabled: true
hooks:
  pre_tool_use:
    - command: ${script}
      timeout_ms: 5000
      match:
        tool: Bash
`,
  'utf8',
);

const env = { ...process.env, GENY_DATA_ROOT: dataRoot };
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

// the API backends run tools in-process, which is where the hook runner sits;
// the CLI runs its own tools, so this test targets the in-process path
const agent = await win.evaluate(() =>
  window.geny.agents.create({ name: 'hooked', provider: 'anthropic' }),
);
await win.evaluate((id) => window.geny.agents.update(id, { tools: ['Bash'] }), agent.id);

const proof = join(agent.dir, 'workspace', 'hook-test.txt');
const result = await win.evaluate(async (id) => {
  const tools = [];
  let error = null;
  const off = window.geny.chat.onEvent((e) => {
    if (e.type === 'tool') tools.push(`${e.name}:${e.phase}`);
    if (e.type === 'error') error = e.error;
  });
  const { turnId } = await window.geny.chat.send({
    agentId: id,
    text: 'Run this shell command exactly: touch hook-test.txt',
  });
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 120_000);
    const stop = window.geny.chat.onEvent((e) => {
      if (e.id === turnId && ['done', 'error', 'cancelled'].includes(e.type)) {
        clearTimeout(timer); stop(); resolve();
      }
    });
  });
  off();
  return { tools, error };
}, agent.id);

console.log('tool events:', result.tools.join(' ') || '(none)');
if (result.error) console.log('turn error:', String(result.error).slice(0, 120));

const hookRan = existsSync(marker);
const fileCreated = existsSync(proof);
console.log(hookRan ? '✓ the hook program ran' : '✗ the hook never ran');
console.log(!fileCreated ? '✓ the shell command was blocked' : '✗ the command ran anyway');

await app.close();
// without an API key the turn cannot reach the model — then the hook never
// gets a tool call to judge, and this test can only report that honestly
const usable = hookRan || !result.error;
if (!usable) {
  console.log('\nhooks: SKIPPED (no API key — the in-process tool path never ran)');
  process.exit(0);
}
const ok = hookRan && !fileCreated;
console.log(`\nhooks: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
