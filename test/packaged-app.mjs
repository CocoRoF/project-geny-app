// Does the SHIPPED artifact work? Launch the AppImage itself (not the dev
// tree) against a clean data root and require the bundled engine to come up.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dataRoot = mkdtempSync(join(tmpdir(), 'geny-appimage-'));
const app = await electron.launch({
  executablePath: process.argv[2],
  args: ['--no-sandbox', '--appimage-extract-and-run'],
  env: { ...process.env, GENY_DATA_ROOT: dataRoot, ELECTRON_RUN_AS_NODE: undefined },
});
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
console.log('✓ packaged app window:', await win.title());
const deadline = Date.now() + 180_000;
let s = await win.evaluate(() => window.geny.engine.status());
while (s.state !== 'ready' && s.state !== 'failed' && Date.now() < deadline) {
  await win.waitForTimeout(600);
  s = await win.evaluate(() => window.geny.engine.status());
}
console.log(`${s.state === 'ready' ? '✓' : '✗'} bundled engine: ${s.state}`,
  s.engine ? `executor ${s.engine} · py ${s.python} · runtime ${s.runtime?.source}` : (s.error ?? ''));
const paths = await win.evaluate(() => window.geny.app.paths());
console.log('  data root:', paths.dataRoot, paths.portable ? '(portable)' : '');
await app.close();
process.exit(s.state === 'ready' ? 0 : 1);
