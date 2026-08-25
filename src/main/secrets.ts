/**
 * API keys. OS keychain when available, encrypted file otherwise.
 *
 * Electron's `safeStorage` is backed by the OS keychain on macOS/Windows and
 * by libsecret on Linux — where it may be unavailable (headless, minimal
 * desktop). Rather than fail, fall back to a file with 0600 and say so, so
 * the UI can tell the user their keys are file-stored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SecretStore {
  backend: 'keychain' | 'file';
  set(key: string, value: string): void;
  get(key: string): string | undefined;
  has(key: string): boolean;
  /** actually drop the entry — clearing by writing '' leaves a row behind */
  remove(key: string): void;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export function createSecretStore(dir: string, safeStorage?: SafeStorageLike): SecretStore {
  mkdirSync(dir, { recursive: true });
  const usable = Boolean(safeStorage?.isEncryptionAvailable());
  const file = join(dir, usable ? 'secrets.enc' : 'secrets.json');

  const load = (): Record<string, string> => {
    if (!existsSync(file)) return {};
    try {
      if (usable && safeStorage) {
        return JSON.parse(safeStorage.decryptString(readFileSync(file))) as Record<string, string>;
      }
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };

  let cache = load();

  const persist = (): void => {
    const json = JSON.stringify(cache);
    if (usable && safeStorage) {
      writeFileSync(file, safeStorage.encryptString(json), { mode: 0o600 });
    } else {
      writeFileSync(file, json, { mode: 0o600 });
    }
  };

  return {
    backend: usable ? 'keychain' : 'file',
    set(key, value) {
      cache[key] = value;
      persist();
    },
    get(key) {
      return cache[key];
    },
    has(key) {
      return typeof cache[key] === 'string' && cache[key]!.length > 0;
    },
    remove(key) {
      delete cache[key];
      persist();
    },
  };
}
