/**
 * Testing an MCP server before saving it.
 *
 * The failure this prevents is the quiet one: a mistyped command is stored,
 * handed to the engine, and shows up as a tool the agent simply does not
 * have — with no error anywhere the user would look.
 *
 * Probed against a REAL MCP server (a tiny one written here, speaking the
 * actual stdio JSON-RPC handshake), plus the three ways it goes wrong.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'geny-mcp-'));

// a minimal but honest MCP server: initialize → initialized → tools/list
writeFileSync(
  join(dir, 'server.mjs'),
  `let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: '2024-11-05', capabilities: {},
        serverInfo: { name: 'probe-fixture', version: '9.9.9' } } }) + '\\n');
    } else if (m.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [
        { name: 'alpha', description: 'first' }, { name: 'beta' } ] } }) + '\\n');
    }
  }
});
`,
);
// one that starts, prints a banner, and never speaks MCP
writeFileSync(join(dir, 'mute.mjs'), `console.log('starting up...'); setInterval(() => {}, 1000);\n`);
// one that dies immediately
writeFileSync(join(dir, 'dies.mjs'), `console.error('missing API key'); process.exit(3);\n`);

const env = { ...process.env, GENY_DATA_ROOT: mkdtempSync(join(tmpdir(), 'geny-mcpdata-')) };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ args: ['.', '--no-sandbox'], env });
const main = await app.firstWindow();
await main.waitForLoadState('domcontentloaded');
await main.evaluate(() => window.geny.onboarding.complete());

const test = (command, args) =>
  main.evaluate((input) => window.geny.mcp.test(input), { command, args });

const good = await test(process.execPath, [join(dir, 'server.mjs')]);
check('a working server reports its identity', good.ok && good.server === 'probe-fixture', `${good.server} v${good.version}`);
check('...and the tools it offers', good.tools.map((t) => t.name).join(',') === 'alpha,beta', good.tools.map((t) => t.name).join(','));
check('...and the protocol it speaks', good.protocolVersion === '2024-11-05', good.protocolVersion);

const missing = await test('definitely-not-a-real-command-xyz', []);
check(
  'a command that does not exist says exactly that',
  !missing.ok && /찾을 수 없습니다/.test(missing.error ?? ''),
  missing.error,
);

const dies = await test(process.execPath, [join(dir, 'dies.mjs')]);
check('a server that exits reports the code', !dies.ok && /코드 3/.test(dies.error ?? ''), dies.error);
check("...and hands back the server's own stderr", /missing API key/.test(dies.stderr ?? ''), dies.stderr);

const mute = await test(process.execPath, [join(dir, 'mute.mjs')]);
check(
  'a process that starts but never speaks MCP times out rather than hanging',
  !mute.ok && /핸드셰이크/.test(mute.error ?? ''),
  mute.error,
);

const empty = await test('', []);
check('an empty command is refused without spawning anything', !empty.ok, empty.error);

await app.close();
const ok = results.every(Boolean);
console.log(`\nmcp probe: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
