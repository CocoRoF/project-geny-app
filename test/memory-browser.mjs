/**
 * The memory browser must show what the ENGINE actually wrote.
 *
 * Not a mock: run a real turn, then read the tree back through the app's own
 * API. An empty memory view after a conversation would mean the provider is
 * not wired, which is exactly the kind of thing that looks fine until a user
 * asks "do you remember?".
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { ...process.env, GENY_DATA_ROOT: mkdtempSync(join(tmpdir(), 'geny-mem-')) };
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

const agent = await win.evaluate(() =>
  window.geny.agents.create({ name: 'mem', provider: 'claude_code_cli' }),
);

const before = await win.evaluate((id) => window.geny.memory.overview(id), agent.id);
console.log(`before the turn — notes:${before.notes.length} longTerm:${before.longTerm ? 'yes' : 'no'}`);

await win.evaluate(async (id) => {
  const { turnId } = await window.geny.chat.send({
    agentId: id,
    text: '내 이름은 홍길동이고 파란색을 좋아해. 한 문장으로 답해.',
  });
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 180_000);
    const off = window.geny.chat.onEvent((e) => {
      if (e.id === turnId && ['done', 'error', 'cancelled'].includes(e.type)) {
        clearTimeout(timer); off(); resolve();
      }
    });
  });
}, agent.id);

const after = await win.evaluate((id) => window.geny.memory.overview(id), agent.id);
console.log(`after  the turn — notes:${after.notes.length} longTerm:${after.longTerm ? 'yes' : 'no'} turns:${after.transcript?.turns ?? 0}`);
console.log('categories:', after.categories.map((c) => `${c.id}(${c.count})`).join(' ') || '(none)');

const wrote = after.transcript !== undefined || after.notes.length > 0 || after.longTerm !== undefined;
console.log(wrote ? '✓ the engine recorded memory and the app can read it' : '✗ nothing was recorded');

// the transcript is the memory that exists from turn one — it must be
// readable, not merely counted
const turns = await win.evaluate((id) => window.geny.memory.transcript(id), agent.id);
const transcriptOk = turns.length > 0 && turns.some((t) => /홍길동/.test(t.text));
console.log(
  transcriptOk
    ? `✓ transcript readable (${turns.length} turns, conversation content present)`
    : `✗ transcript unreadable (${turns.length} turns)`,
);

// a note must be readable by the path the overview handed out
let readable = true;
if (after.notes[0]) {
  const note = await win.evaluate(
    ({ id, p }) => window.geny.memory.note(id, p),
    { id: agent.id, p: after.notes[0].path },
  );
  readable = typeof note.text === 'string';
  console.log(`✓ note readable: ${after.notes[0].title} (${note.text.length} chars)`);
}

// the jail: a path climbing out must be refused
let jailed = false;
try {
  await win.evaluate((id) => window.geny.memory.note(id, '../../../etc/passwd'), agent.id);
} catch {
  jailed = true;
}
console.log(jailed ? '✓ escape attempt refused' : '✗ memory reader is not jailed');

await app.close();
const ok = wrote && readable && jailed && transcriptOk;
console.log(`\nmemory browser: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
