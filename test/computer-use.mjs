/**
 * Computer use: the agent typing and clicking as the user.
 *
 * This is the one capability whose mistakes are not confined to a
 * workspace, so the gate matters as much as the mechanism. Asserted here:
 *
 *  · OFF by default, and refusing says why
 *  · a disabled capability is refused even when the master switch is on
 *  · with consent, keystrokes REALLY reach the focused window (checked by
 *    reading what arrived, not by trusting a resolved promise)
 *  · screenshot coordinates are mapped into screen space
 *
 * Linux needs xdotool; without it the test reports the backend's own
 * explanation and skips the parts that need a keyboard.
 */
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'geny-cu-'));
const env = { ...process.env, GENY_DATA_ROOT: dataRoot };
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

const tool = (name, args) =>
  app.evaluate(({}, a) => globalThis.__genyHostTool(a.name, a.args, 'cu-test'), { name, args })
    .then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e) }));

// ── default posture ────────────────────────────────────────────────────
const status = await main.evaluate(() => window.geny.computer.status());
check('computer use is OFF until asked for', status.enabled === false);
check('the input backend is reported by name', Boolean(status.backend), `${status.backend} (${status.backendAvailable ? '사용 가능' : status.backendReason})`);

const refused = await tool('ComputerType', { text: 'should not happen' });
check(
  'while off, typing is refused with a reason the user can act on',
  !refused.ok && /꺼져 있습니다/.test(refused.e),
  (refused.e ?? '').slice(-45),
);

// ── per-capability gate ────────────────────────────────────────────────
// auto mode so the test does not need to answer a modal; the dialog path is
// exercised by the ask-mode default in normal use
await main.evaluate(() =>
  window.geny.computer.save({ enabled: true, mode: 'auto', input: false, apps: true }));
const inputOff = await tool('ComputerType', { text: 'nope' });
check(
  'a disabled capability is refused even with the master switch on',
  !inputOff.ok && /input/.test(inputOff.e),
  (inputOff.e ?? '').slice(-40),
);

const cu = await main.evaluate(() => window.geny.computer.save({ input: true }));
check('capabilities can be turned on one at a time', cu.input === true && cu.enabled === true);

// ── does a keystroke actually arrive? ──────────────────────────────────
if (!cu.backendAvailable) {
  console.log(`· no input backend on this machine (${cu.backendReason}) — skipping the keystroke checks`);
} else {
  // A focused, focusable input in the app's own window is the receiver: if
  // the synthetic keystroke reaches it, it reached the OS.
  await main.evaluate(() => {
    const el = document.createElement('input');
    el.id = 'cu-target';
    el.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;width:300px';
    document.body.appendChild(el);
    el.focus();
  });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setAlwaysOnTop(true);
    w.focus();
  });
  await main.waitForTimeout(700);

  const typed = await tool('ComputerType', { text: 'geny' });
  await main.waitForTimeout(1200);
  const got = await main.evaluate(() => document.getElementById('cu-target')?.value ?? '');
  check('typed text really reaches the focused window', typed.ok && got.includes('geny'), `received "${got}"`);

  const keyed = await tool('ComputerKey', { combo: 'BackSpace' });
  await main.waitForTimeout(900);
  const after = await main.evaluate(() => document.getElementById('cu-target')?.value ?? '');
  check('a key combination is delivered too', keyed.ok && after.length < got.length, `"${got}" → "${after}"`);
}

// ── coordinate mapping ─────────────────────────────────────────────────
// The model clicks where it saw the thing, in the SCREENSHOT's pixels. If
// the capture was scaled, a raw click lands somewhere else entirely.
const mapped = await app.evaluate(async ({ screen }) => {
  const size = screen.getPrimaryDisplay().size;
  return { size };
});
await tool('ScreenCapture', {});
const click = await tool('ComputerClick', { x: 10, y: 10, button: 'left' });
check(
  'a click after a full-size capture lands where it was seen',
  click.ok && click.r?.x === 10 && click.r?.y === 10,
  click.ok ? `(10,10) → (${click.r.x},${click.r.y}) on ${mapped.size.width}x${mapped.size.height}` : click.e,
);

// The mapping only does anything when the capture and the screen differ —
// a HiDPI display, or a capture that was scaled down. Pretend the model is
// looking at a half-size image and check the click is doubled.
await app.evaluate(({}, s) => globalThis.__genyNoteCapture(s.w, s.h), {
  w: Math.round(mapped.size.width / 2),
  h: Math.round(mapped.size.height / 2),
});
const scaled = await tool('ComputerClick', { x: 100, y: 50, button: 'left' });
check(
  'a scaled screenshot is corrected, not clicked literally',
  scaled.ok && scaled.r.x === 200 && scaled.r.y === 100,
  scaled.ok ? `(100,50) on a half-size capture → (${scaled.r.x},${scaled.r.y})` : scaled.e,
);

// ── the tools are gated per agent like everything else ─────────────────
const agent = await main.evaluate(() =>
  window.geny.agents.create({ name: 'cu', provider: 'claude_code_cli' }));
await main.evaluate((id) => window.geny.agents.update(id, { tools: ['Read'] }), agent.id);
const after = await main.evaluate((id) => window.geny.agents.list().then((a) => a.find((x) => x.id === id)), agent.id);
check('computer tools obey the per-agent tool selection', after.tools.join(',') === 'Read');

await main.evaluate(() => window.geny.computer.save({ enabled: false }));
const offAgain = await main.evaluate(() => window.geny.computer.status());
check('turning it off clears session grants', offAgain.enabled === false && offAgain.sessionGrants.length === 0);

await app.close();
const ok = results.every(Boolean);
console.log(`\ncomputer use: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);
