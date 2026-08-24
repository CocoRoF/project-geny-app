/**
 * The agent browser must actually drive a page.
 *
 * Serves a tiny local page (no network dependency, deterministic), then goes
 * through the real tool path: snapshot → act by ref → read. Asserts on the
 * DOM effect, not on the tool reporting success — a tool that says "ok" and
 * changes nothing is the failure mode worth catching.
 */
import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE = `<!doctype html><meta charset="utf-8"><title>Geny browser test</title>
<h1>Search</h1>
<input id="q" placeholder="query">
<button id="go" onclick="document.getElementById('out').textContent='RESULT:'+document.getElementById('q').value">Go</button>
<p id="out">nothing yet</p>
<p>Some readable body text that extraction should return.</p>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const env = { ...process.env, GENY_DATA_ROOT: mkdtempSync(join(tmpdir(), 'geny-browser-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', '--no-sandbox'], env });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');

// drive the host tools directly through main — this is the same code path
// the engine's host_tool_call reaches, without needing a model in the loop
const agentId = 'browser-test';
const run = (name, args) =>
  app.evaluate(
    async ({ BrowserWindow }, payload) => {
      void BrowserWindow;
      // eslint-disable-next-line no-undef
      return globalThis.__genyHostTool(payload.name, payload.args, payload.agentId);
    },
    { name, args, agentId },
  );

const marker = `geny-${Date.now()}`;
try {
  const opened = await run('BrowserOpen', { url });
  console.log('✓ opened:', opened.title);

  const snap = await run('BrowserSnapshot', {});
  console.log(`✓ snapshot: ${snap.nodes.length} elements — ${snap.nodes.map((n) => n.ref + ':' + n.role).join(' ')}`);
  const input = snap.nodes.find((n) => n.role === 'input');
  const button = snap.nodes.find((n) => n.role === 'button');
  if (!input || !button) throw new Error('expected an input and a button in the snapshot');

  await run('BrowserAct', { ref: input.ref, action: 'type', text: marker });
  await run('BrowserAct', { ref: button.ref, action: 'click' });
  const read = await run('BrowserRead', {});
  const worked = read.text.includes(`RESULT:${marker}`);
  console.log(worked ? '✓ typed + clicked: the page changed' : '✗ the page did not change');
  console.log('  read back:', read.text.replace(/\s+/g, ' ').slice(0, 80));

  await run('BrowserClose', {});
  console.log('✓ closed');

  await app.close();
  server.close();
  process.exit(worked ? 0 : 1);
} catch (err) {
  console.error('✗', err.message);
  await app.close();
  server.close();
  process.exit(1);
}
