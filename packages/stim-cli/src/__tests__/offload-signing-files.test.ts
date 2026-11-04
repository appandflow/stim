import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { firstSigningFile, isSigningKeystore } from '../offload/signing-files.ts';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-signing-files-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text = 'bytes'): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return path;
}

test.each([
  { path: 'android/app/release.keystore', left: true },
  { path: 'apps/other/upload.JKS', left: true },
  { path: 'android/keystore.properties', left: true },
  { path: 'android/app/debug.keystore', left: false },
  { path: 'android/gradle.properties', left: false },
])('$path left out of an Android sync: $left', ({ path, left }) => {
  expect(isSigningKeystore(path)).toBe(left);
});

test.each([
  { name: 'a store password', path: 'android/signing.properties', text: 'storePassword=hunter2\n', found: true },
  {
    name: 'a project property password',
    path: 'android/gradle.properties',
    text: 'APP_KEY_PASSWORD = x\n',
    found: true,
  },
  { name: 'EAS local credentials', path: 'credentials.json', text: '{"keystorePassword": "x"}', found: true },
  { name: 'the debug password', path: 'android/gradle.properties', text: 'storePassword=android\n', found: false },
  {
    name: 'properties with no password',
    path: 'android/gradle.properties',
    text: 'hermesEnabled=true\n',
    found: false,
  },
  { name: 'a password word in another file type', path: 'README.md', text: 'storePassword=hunter2\n', found: false },
])('$name found: $found', async ({ path, text, found }) => {
  write(path, text);
  expect(await firstSigningFile(root, ['package.json', path], null)).toBe(found ? path : null);
});

test('the configured android.keystore counts under any name, resolved through a symlinked root', async () => {
  const path = write('android/signing/app.key');
  expect(await firstSigningFile(root, [path], join(root, path))).toBe(path);
  expect(await firstSigningFile(root, [path], join(root, 'absent.key'))).toBe(null);
});

test('a password file that cannot be read counts as holding a password', async () => {
  expect(await firstSigningFile(root, ['android/gone.properties'], null)).toBe('android/gone.properties');
});
