#!/usr/bin/env node
/** Headless sidecar smoke: ready → ping → turn(no key: graceful error) →
 *  shutdown. Runs without Electron and without an API key, so CI can gate
 *  the protocol contract on every commit. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PY = process.platform === 'win32'
  ? join('engine', '.venv', 'Scripts', 'python.exe')
  : join('engine', '.venv', 'bin', 'python');

const agentDir = mkdtempSync(join(tmpdir(), 'geny-smoke-'));
const py = spawn(PY, ['-I', '-X', 'utf8', '-u', '-m', 'geny_app.sidecar', '--serve'], {
  cwd: process.cwd(),
  env: { ...process.env, PYTHONPATH: 'engine', PYTHONNOUSERSITE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderrTail = '';
py.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });

const results = [];
const send = (o) => py.stdin.write(JSON.stringify(o) + '\n');
const fail = (m) => { console.error('✗', m); console.error(stderrTail.slice(-1500)); process.exit(1); };

createInterface({ input: py.stdout }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return fail('non-JSON on protocol stdout: ' + line.slice(0, 200)); }
  results.push(m);
  if (m.type === 'ready') {
    console.log(`✓ ready — protocol ${m.protocol}, engine ${m.engine}, python ${m.python}`);
    send({ id: 'p1', op: 'ping' });
  } else if (m.type === 'pong') {
    console.log('✓ pong');
    send({ id: 't1', op: 'turn', session: 's1', text: 'hello',
           config: { provider: 'anthropic', agentDir, model: 'claude-sonnet-4-6' } });
  } else if (m.id === 't1' && m.type === 'started') {
    console.log('✓ turn started (pipeline built, MCP wired, memory provider live)');
  } else if (m.id === 't1' && (m.type === 'error' || m.type === 'done' || m.type === 'cancelled')) {
    const kind = m.type === 'error' ? `error → ${String(m.error).slice(0, 90)}` : m.type;
    console.log(`✓ exactly one terminal event: ${kind}`);
    send({ id: 'x', op: 'shutdown' });
  } else if (m.type === 'notice' && m.message === 'bye') {
    const terminals = results.filter((r) => r.id === 't1' && ['done', 'error', 'cancelled'].includes(r.type));
    if (terminals.length !== 1) return fail(`expected 1 terminal event, got ${terminals.length}`);
    console.log('✓ clean shutdown');
    console.log(`\nprotocol OK — ${results.length} messages, no stdout corruption`);
    process.exit(0);
  }
});
py.on('close', (c) => fail(`sidecar exited early (code ${c})`));
setTimeout(() => fail('timeout'), 90000);
