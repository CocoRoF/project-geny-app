/**
 * Live2D runtime provisioning.
 *
 * WHY THIS IS NOT SIMPLY BUNDLED — the licence was read, not assumed:
 *
 * `live2dcubismcore.min.js` says so in its own header: "This file
 * corresponds to the 'Redistributable Code' in the agreement", and §5.1 of
 * the Live2D Proprietary Software License Agreement does let a customer
 * distribute Redistributable Code as part of their application. So far so
 * good — bundling it would be permitted in principle.
 *
 * The blocker is a different document. Releasing a work built with the SDK
 * needs a Publication License Agreement, and individuals and small
 * businesses are exempt — EXCEPT for an "Expandable Application", which
 * Live2D defines as a work with significant expandability, "particularly
 * those generating indefinite model numbers through file/data combinations
 * (avatars, streaming apps...)", and their help page names "avatar systems"
 * as the example. For those, "a separate contract is also required for each
 * work, regardless of whether the user is a General User, Small-Scale
 * Enterprise, or Large Entity" — the revenue exemption does not reach them.
 *
 * This app is exactly that: an avatar overlay that renders an indefinite
 * number of user-supplied models. Shipping the SDK inside it would make the
 * published app a released Expandable Application built with the SDK, and
 * that needs a contract this project does not have.
 *
 * So the split is:
 *   · pixi.js and pixi-live2d-display are MIT — the app ships them.
 *   · Cubism Core is fetched, on an explicit click, from Live2D's own
 *     public CDN into the user's own model folder. The user obtains it from
 *     Live2D under the licence shown to them; this project redistributes
 *     nothing.
 *
 * The practical result is the same one click, and it stays clean.
 * https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
 * https://help.live2d.com/en/sdk/sdk_001/
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Live2D's own public CDN for the web Core — the same file their samples load. */
export const CUBISM_CORE_URL =
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

export const CUBISM_LICENSE_URL =
  'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html';

/** MIT bundles the app carries, mapped to the name the scaffold looks for. */
const BUNDLED: Array<{ resource: string; devPath: string; as: string; licence?: string; devLicence?: string }> = [
  {
    resource: 'pixi.min.js',
    devPath: 'node_modules/pixi.js/dist/browser/pixi.min.js',
    as: 'pixi.min.js',
    licence: 'pixi.LICENSE.txt',
    devLicence: 'node_modules/pixi.js/LICENSE',
  },
  {
    resource: 'pixi-live2d-display.min.js',
    // cubism4 = the build for .model3.json models, which is what the app detects
    devPath: 'node_modules/pixi-live2d-display/dist/cubism4.min.js',
    as: 'pixi-live2d-display.min.js',
    licence: 'pixi-live2d-display.LICENSE.txt',
    devLicence: 'node_modules/pixi-live2d-display/LICENSE',
  },
];

export interface RuntimePaths {
  /** `<resources>/live2d` when packaged, the repo root when not */
  resourceDir: string;
  repoRoot: string;
  packaged: boolean;
}

const source = (paths: RuntimePaths, entry: (typeof BUNDLED)[number], licence = false): string => {
  const name = licence ? entry.licence! : entry.resource;
  const dev = licence ? entry.devLicence! : entry.devPath;
  return paths.packaged ? join(paths.resourceDir, name) : join(paths.repoRoot, dev);
};

/**
 * Put the MIT half of the runtime into a model's `runtime/` folder.
 *
 * Copied in rather than referenced from the app so the folder stays
 * self-contained — the same folder opens in a plain browser, and the user
 * can read exactly what the page loads.
 */
export function installBundledRuntime(paths: RuntimePaths, modelDir: string): string[] {
  const runtime = join(modelDir, 'runtime');
  mkdirSync(runtime, { recursive: true });
  const written: string[] = [];
  for (const entry of BUNDLED) {
    const from = source(paths, entry);
    if (!existsSync(from)) continue;
    copyFileSync(from, join(runtime, entry.as));
    written.push(entry.as);
    const licenceFrom = source(paths, entry, true);
    if (entry.licence && existsSync(licenceFrom)) {
      copyFileSync(licenceFrom, join(runtime, entry.licence));
    }
  }
  return written;
}

export interface CoreResult {
  path: string;
  bytes: number;
  /** already present, so nothing was downloaded */
  cached: boolean;
}

/**
 * Fetch Cubism Core into a model's `runtime/`.
 *
 * Validated rather than trusted: a captive portal or a moved URL would
 * otherwise leave an HTML error page named `.js`, and the failure would
 * surface much later as an unreadable script error inside the overlay.
 */
export async function fetchCubismCore(
  modelDir: string,
  options: { force?: boolean; timeoutSeconds?: number } = {},
): Promise<CoreResult> {
  const runtime = join(modelDir, 'runtime');
  mkdirSync(runtime, { recursive: true });
  const target = join(runtime, 'live2dcubismcore.min.js');

  if (!options.force && existsSync(target)) {
    return { path: target, bytes: statSync(target).size, cached: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (options.timeoutSeconds ?? 60) * 1000);
  let body: string;
  try {
    const response = await fetch(CUBISM_CORE_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Live2D CDN 이 ${response.status} 를 반환했습니다`);
    }
    body = await response.text();
  } catch (err) {
    if (controller.signal.aborted) throw new Error('다운로드 시간이 초과됐습니다');
    const cause = err instanceof Error ? (err.cause as Error | undefined)?.message ?? err.message : String(err);
    throw new Error(`Cubism Core 를 받지 못했습니다: ${cause}`);
  } finally {
    clearTimeout(timer);
  }

  // it must actually be the Core, not an error page or a redirect stub
  if (!body.includes('Live2DCubismCore') || body.length < 50_000) {
    throw new Error('받은 파일이 Cubism Core 가 아닙니다 — 네트워크가 가로챈 응답일 수 있습니다');
  }

  // write via a temp name so an interrupted download never leaves a
  // half-file that looks installed
  const temp = `${target}.part`;
  writeFileSync(temp, body, 'utf8');
  renameSync(temp, target);

  // the terms travel with the file — the user obtained it from Live2D, and
  // this is the agreement it came under
  writeFileSync(
    join(runtime, 'live2dcubismcore.LICENSE.txt'),
    [
      'Live2D Cubism Core',
      '(C) Live2D Inc. All rights reserved.',
      '',
      'This file was downloaded from Live2D\'s official distribution:',
      `  ${CUBISM_CORE_URL}`,
      '',
      'It is licensed to you by Live2D under the Live2D Proprietary Software',
      'License Agreement, NOT under this application\'s Apache-2.0 licence:',
      `  ${CUBISM_LICENSE_URL}`,
      '',
      'Publishing a work that uses the Cubism SDK may additionally require a',
      'Publication License Agreement. Individuals and small businesses are',
      'normally exempt, but that exemption does NOT cover an "Expandable',
      'Application" such as an avatar system — which is what this app is. If',
      'you intend to distribute something built with it, read:',
      '  https://help.live2d.com/en/sdk/sdk_001/',
      '',
      'Nothing here is legal advice.',
      '',
    ].join('\n'),
    'utf8',
  );

  return { path: target, bytes: body.length, cached: false };
}
