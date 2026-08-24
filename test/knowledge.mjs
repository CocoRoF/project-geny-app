/**
 * The knowledge index must find the user's documents — including the Korean
 * short-query case.
 *
 * Measured, not assumed: FTS5's trigram tokenizer only matches queries of
 * three characters or more, and two-syllable Korean words are the common
 * case ("가격", "결정", "배포"). unicode61 is worse — it splits on spaces, so
 * "가격은" never matches "가격". This asserts both paths work, because a
 * search that quietly returns nothing looks identical to "no such document".
 */
import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-know-'));
const docs = join(dataRoot, 'knowledge');
mkdirSync(join(docs, '회의'), { recursive: true });

writeFileSync(
  join(docs, '회의', '2026-가격정책.md'),
  `# 2026 가격 정책\n\n논의 끝에 월 구독료는 9900원으로 결정했다.\n연간 결제 시 2개월 무료.\n`,
  'utf8',
);
writeFileSync(
  join(docs, 'deploy.md'),
  `# Deployment\n\nWe deploy with docker compose on the staging box.\nRollback is a single command.\n`,
  'utf8',
);
writeFileSync(join(docs, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const env = { ...process.env, GENY_DATA_ROOT: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', '--no-sandbox'], env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');

const report = await win.evaluate(() => window.geny.knowledge.reindex());
console.log(`✓ indexed ${report.documents} documents / ${report.chunks} chunks in ${report.took}ms`);
console.log(`  skipped: ${report.skipped.map((s) => `${s.path} (${s.reason})`).join(', ') || 'none'}`);

const cases = [
  { q: '가격', why: 'Korean 2 chars — trigram cannot see this' },
  { q: '결정', why: 'Korean 2 chars inside an inflected word (결정했다)' },
  { q: '9900', why: 'numeric inside 9900원' },
  { q: 'docker', why: 'plain ascii' },
  { q: '가격 정책', why: 'multi-term' },
];
let ok = true;
for (const { q, why } of cases) {
  const hits = await win.evaluate((query) => window.geny.knowledge.search(query), q);
  const found = hits.length > 0;
  if (!found) ok = false;
  console.log(`${found ? '✓' : '✗'} "${q}" → ${hits.length} hit(s)  [${why}]`);
  if (found) console.log(`    ${hits[0].path}: ${hits[0].snippet.replace(/\s+/g, ' ').slice(0, 70)}`);
}

// a binary file must be reported as skipped, not indexed as mojibake
const skippedBinary = report.skipped.some((s) => s.path.endsWith('.png'));
console.log(skippedBinary ? '✓ binary reported as skipped' : '✗ binary was not reported');

await app.close();
const pass = ok && skippedBinary && report.documents === 2;
console.log(`\nknowledge: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
