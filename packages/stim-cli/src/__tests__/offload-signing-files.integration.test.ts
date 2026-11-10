import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { staticInputs } from '../fingerprint/inputs.ts';
import { isUncertain, preimage, preimageHash, type Platform } from '../fingerprint/key.ts';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-signing-fingerprint-')));
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

function fingerprint(platform: Platform): string {
  const result = staticInputs({ root, tracked: null, expoResolves: false }, { platform });
  if (isUncertain(result)) throw new Error(result.uncertain);
  return preimageHash(preimage(platform, result.native, result.layout, result.inputs));
}

test('adding a signing file does not move the Android fingerprint, so a worker agrees either way', async () => {
  write('package.json', '{"name":"app","version":"1.0.0"}');
  write('android/build.gradle', 'x');
  const before = fingerprint('android');
  write('android/keystore.properties', 'x');
  expect(fingerprint('android')).toBe(before);
});

test.each([
  { path: 'android/app/release.keystore', platform: 'android' as const, moves: false },
  { path: 'android/keystore.properties', platform: 'android' as const, moves: false },
  { path: 'android/app/debug.keystore', platform: 'android' as const, moves: true },
  { path: 'android/app/src/main/res/raw/truststore.jks', platform: 'android' as const, moves: true },
  { path: 'android/app/src/main/assets/client.p12', platform: 'android' as const, moves: true },
  { path: 'ios/client.p12', platform: 'ios' as const, moves: false },
])('editing $path moves the $platform fingerprint: $moves', async ({ path, platform, moves }) => {
  write('package.json', '{"name":"app","version":"1.0.0"}');
  write('android/build.gradle', 'x');
  write('ios/Podfile', 'x');
  write(path, 'one');
  const before = fingerprint(platform);
  write(path, 'two');
  const after = fingerprint(platform);
  expect(after !== before).toBe(moves);
});
