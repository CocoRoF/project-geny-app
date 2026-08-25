/**
 * Packaging contracts — the things whose breakage only shows up on a user's
 * machine, hours after CI went green.
 *
 * Reads electron-builder.yml as text rather than pulling in a YAML parser:
 * the four values under test are plain scalars, and a dependency added for
 * one test is a dependency the installer carries forever.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const yml = readFileSync('electron-builder.yml', 'utf8');

/** `key: value` at the given indent, ignoring comment lines */
const read = (key: string, indent = ''): string | undefined =>
  new RegExp(`^${indent}${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(yml)?.[1];

const artifactNames = [...yml.matchAll(/^\s*artifactName:[ \t]*(.+?)[ \t]*$/gm)].map((m) => m[1]!);

describe('installer naming', () => {
  it('names every installer Geny_app_<os>_<version>', () => {
    // default + mac + win + linux
    expect(artifactNames).toHaveLength(4);
    for (const name of artifactNames) {
      expect(name).toMatch(/^Geny_app_[a-z${}]+_(\$\{arch\}_)?\$\{version\}\.\$\{ext\}$/);
    }
  });

  it('carries the arch on macOS, the only two-arch target', () => {
    // without it both dmgs resolve to one filename and one overwrites the
    // other in the release
    const mac = artifactNames.find((n) => n.includes('macos'));
    expect(mac).toContain('${arch}');
  });

  it('leaves latest*.yml alone', () => {
    // electron-updater looks the feed up by that exact filename, so a
    // rename would silently break every auto-update
    expect(yml).not.toMatch(/artifactName:.*latest/);
  });
});

describe('install prefix', () => {
  /**
   * electron-builder installs a .deb into `/opt/<productName>`, and dpkg
   * refuses to let two packages own the same file. `geny-connector` ships
   * with productName "Geny", so claiming it aborts the install with
   * "trying to overwrite '/opt/Geny/LICENSES.chromium.html'".
   */
  it('does not claim /opt/Geny, which geny-connector owns', () => {
    expect(read('productName')).not.toBe('Geny');
  });

  it('is still recognisably this app', () => {
    expect(read('productName')).toMatch(/geny/i);
  });
});
