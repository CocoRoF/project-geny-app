/**
 * A persona must actually configure the agent.
 *
 * Personas are files the user can read and edit, so the test does what the
 * user would: write one, create an agent from it, and check the agent came
 * out with that prompt, posture and tool set — then apply a different one to
 * an existing agent and check it changed.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-persona-'));
mkdirSync(join(dataRoot, 'personas'), { recursive: true });
writeFileSync(
  join(dataRoot, 'personas', '테스터.md'),
  `---
name: 테스터
description: 테스트 전용
posture: careful
tools: [Read, Grep]
---
너는 테스트용 페르소나다. 짧게 답한다.
`,
  'utf8',
);

const env = { ...process.env, GENY_DATA_ROOT: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', '--no-sandbox'], env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');

const personas = await win.evaluate(() => window.geny.personas.list());
const names = personas.map((p) => p.name);
console.log(`✓ personas loaded (${personas.length}): ${names.join(', ')}`);
if (!names.includes('테스터')) { console.error('✗ hand-written persona not picked up'); process.exit(1); }
const starters = names.filter((n) => n !== '테스터');
console.log(starters.length > 0 ? `✓ starters written on first run: ${starters.join(', ')}` : '✗ no starters');

const agent = await win.evaluate(() =>
  window.geny.agents.create({ name: '', provider: 'claude_code_cli', personaId: '테스터' }),
);
const seeded =
  agent.name === '테스터' &&
  agent.posture === 'careful' &&
  agent.systemPrompt?.includes('테스트용 페르소나') &&
  JSON.stringify(agent.tools) === JSON.stringify(['Read', 'Grep']);
console.log(seeded ? '✓ agent created from persona (name, posture, prompt, tools)' : '✗ persona did not seed the agent');
console.log(`   name=${agent.name} posture=${agent.posture} tools=${JSON.stringify(agent.tools)}`);

// applying a different persona to a live agent
const other = personas.find((p) => p.name !== '테스터');
const applied = other
  ? await win.evaluate(
      ({ id, pid }) => window.geny.personas.applyTo(id, pid),
      { id: agent.id, pid: other.id },
    )
  : null;
const changed = applied ? applied.systemPrompt !== agent.systemPrompt : false;
console.log(changed ? `✓ applied "${other.name}" to the existing agent` : '✗ applying a persona did nothing');

// files are the source of truth: what the app wrote must be readable
const files = readdirSync(join(dataRoot, 'personas')).filter((f) => f.endsWith('.md'));
console.log(`✓ on disk as markdown: ${files.join(', ')}`);

await app.close();
const ok = seeded && changed && starters.length > 0;
console.log(`\npersonas: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
