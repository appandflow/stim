import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactIn, storeArtifact } from '../artifact-store.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-artifact-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('a failed clone copy falls back to a regular copy before publishing the artifact', () => {
  const source = join(root, 'My App "quoted".app');
  mkdirSync(source);
  writeFileSync(join(source, 'binary'), 'app bytes');
  const dest = join(root, 'cache', 'entry');
  let attempts = 0;

  const stored = storeArtifact(dest, source, {
    runFile: (file, args) => {
      expect(artifactIn(dest)).toBeNull();
      attempts += 1;
      if (args.includes('-c')) throw new Error('clone copy unavailable');
      return execFileSync(file, args);
    },
  });

  assert(stored);
  expect(attempts).toBe(2);
  expect(readFileSync(join(stored, 'binary'), 'utf8')).toBe('app bytes');
  expect(existsSync(`${dest}.staging-${process.pid}`)).toBe(false);
});

test('a failed copy leaves the existing artifact intact and does not invoke rename-error handling', () => {
  const dest = join(root, 'cache', 'entry');
  mkdirSync(dest, { recursive: true });
  const existing = join(dest, 'App.apk');
  writeFileSync(existing, 'cached bytes');
  expect(() =>
    storeArtifact(dest, join(root, 'missing.apk'), {
      runFile: execFileSync,
      overwrite: true,
      onRenameError: () => {
        throw new Error('unexpected rename failure');
      },
    }),
  ).toThrow(/missing\.apk/);

  expect(readFileSync(existing, 'utf8')).toBe('cached bytes');
});

test('a rename failure propagates when the caller has no handler', () => {
  const source = join(root, 'App.apk');
  writeFileSync(source, 'apk bytes');
  const dest = join(root, 'cache', 'entry');
  expect(() =>
    storeArtifact(dest, source, {
      runFile: execFileSync,
      writeMetadata: (staging) => rmSync(staging, { recursive: true, force: true }),
    }),
  ).toThrow(/ENOENT/);

  expect(artifactIn(dest)).toBeNull();
});

test('a caller can discard a failed publication and resolve it as a cache miss', () => {
  const source = join(root, 'App.apk');
  writeFileSync(source, 'apk bytes');
  const dest = join(root, 'cache', 'entry');
  const discarded: string[] = [];
  const stored = storeArtifact(dest, source, {
    runFile: execFileSync,
    writeMetadata: (staging) => rmSync(staging, { recursive: true, force: true }),
    onRenameError: (staging) => {
      rmSync(staging, { recursive: true, force: true });
      discarded.push(staging);
    },
  });

  expect(stored).toBeNull();
  expect(discarded).toEqual([`${dest}.staging-${process.pid}`]);
});
