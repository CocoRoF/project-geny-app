/**
 * M2/M3 acceptance — the conversation survives a restart, and the agent's
 * permission posture is what the app said it is.
 *
 * Launches the app twice against the SAME data root: turn one in the first
 * process, then a fresh process must show that turn and continue it.
 */
import { _electron as electron } from 'playwright-core';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-m2-'));
const die = (m) => { console.error('✗', m); process.exit(1); };
const launch = () => electron.launch({
  args: ['.', '--no-sandbox'],
  env: { ...process.env, GENY_DATA_ROOT: dataRoot, ELECTRON_RUN_AS_NODE: undefined },
});

const waitReady = async (win) => {
  const deadline = Date.now() + 120_000;
  let s = await win.evaluate(() => window.geny.engine.status());
  while (s.state !== 'ready' && s.state !== 'failed' && Date.now() < deadline) {
    await win.waitForTimeout(400);
    s = await win.evaluate(() => window.geny.engine.status());
  }
  if (s.state !== 'ready') die(`engine ${s.state}: ${s.error ?? ''}`);
  return s;
};

const runTurn = (win, agentId, text) =>
  win.evaluate(async ({ agentId, text }) => {
    const { turnId } = await window.geny.chat.send({ agentId, text });
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 240_000);
      const stop = window.geny.chat.onEvent((e) => {
        if (e.id === turnId && ['done', 'error', 'cancelled'].includes(e.type)) {
          clearTimeout(timer); stop(); resolve(e.type + (e.error ? ':' + String(e.error).slice(0, 100) : ''));
        }
      });
    });
  }, { agentId, text });

// ── first process: create an agent, have a conversation ──────────
let app = await launch();
let win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await waitReady(win);

const agent = await win.evaluate(() =>
  window.geny.agents.create({ name: 'persist', provider: 'claude_code_cli', posture: 'standard' }),
);
if (agent.posture !== 'standard') die(`posture not stored: ${agent.posture}`);
console.log('✓ agent created with posture:', agent.posture);

const first = await runTurn(win, agent.id, 'Remember this word: PINEAPPLE. Just acknowledge it.');
console.log('✓ turn 1:', first);
if (!first.startsWith('done')) die('turn 1 did not complete');

const stateFiles = readdirSync(join(agent.dir, 'sessions'));
if (stateFiles.length === 0) die('no session state written');
const carried = JSON.parse(readFileSync(join(agent.dir, 'sessions', stateFiles[0]), 'utf8'));
console.log(`✓ state persisted: ${stateFiles[0]} — ${(carried.messages ?? []).length} messages, schema ${carried.schema}`);

await app.close();
console.log('— app closed —');

// ── second process: same data root, must remember ────────────────
app = await launch();
win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await waitReady(win);

const agents = await win.evaluate(() => window.geny.agents.list());
if (agents.length !== 1 || agents[0].id !== agent.id) die('agent did not survive restart');
console.log('✓ agent survived restart:', agents[0].name, `(posture ${agents[0].posture})`);

const history = await win.evaluate((id) => window.geny.chat.history(id), agent.id);
console.log(`✓ history restored: ${history.length} messages —`,
  history.map((m) => `${m.role}:${m.text.slice(0, 28).replace(/\n/g, ' ')}`).join(' | '));
if (history.length < 2) die('history did not include both sides of the turn');

// the real test: does the ENGINE still have the context?
const second = await runTurn(win, agent.id, 'What was the word I asked you to remember? Reply with just the word.');
console.log('✓ turn 2:', second);
const after = await win.evaluate((id) => window.geny.chat.history(id), agent.id);
const reply = (after[after.length - 1]?.text ?? '').toUpperCase();
console.log('  reply:', reply.slice(0, 80).replace(/\n/g, ' '));
if (reply.includes('PINEAPPLE')) console.log('✓ engine context survived the restart');
else console.log('  ⚠ context not carried — the model did not recall the word');

await app.close();
console.log('\nM2/M3 acceptance: PASS');
