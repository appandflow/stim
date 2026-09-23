import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

test.skipIf(process.platform === 'win32')(
  'a clone copy that fails midway is discarded before the regular copy publishes the artifact (skipped on Windows: the fallback runs the real cp, and a double quote is illegal in an NTFS name)',
  () => {
    const source = join(root, 'My App "quoted".app');
    mkdirSync(source);
    writeFileSync(join(source, 'binary'), 'app bytes');
    const dest = join(root, 'cache', 'entry');
    let attempts = 0;

    const stored = storeArtifact(dest, source, {
      runFile: (file, args) => {
        expect(artifactIn(dest)).toBeNull();
        attempts += 1;
        if (args.includes('-c')) {
          mkdirSync(args.at(-1)!);
          writeFileSync(join(args.at(-1)!, 'partial'), '');
          throw new Error('clone copy failed');
        }
        return execFileSync(file, args);
      },
    });

    assert(stored);
    expect(attempts).toBe(2);
    expect(readdirSync(stored)).toEqual(['binary']);
    expect(readFileSync(join(stored, 'binary'), 'utf8')).toBe('app bytes');
    expect(existsSync(`${dest}.staging-${process.pid}`)).toBe(false);
  },
);

test('an entry another process publishes during the copy is kept and returned', () => {
  const source = join(root, 'App.apk');
  writeFileSync(source, 'our bytes');
  const dest = join(root, 'cache', 'entry');

  const stored = storeArtifact(dest, source, {
    runFile: (file, args) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'App.apk'), 'their bytes');
      return execFileSync(file, args);
    },
  });

  expect(stored).toBe(join(dest, 'App.apk'));
  expect(readFileSync(join(dest, 'App.apk'), 'utf8')).toBe('their bytes');
  expect(readdirSync(join(root, 'cache'))).toEqual(['entry']);
});

test('an overwrite replaces the existing entry and leaves no staging or replaced copy behind', () => {
  const source = join(root, 'App.apk');
  writeFileSync(source, 'new bytes');
  const dest = join(root, 'cache', 'entry');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'App.apk'), 'old bytes');

  const stored = storeArtifact(dest, source, { runFile: execFileSync, overwrite: true });

  assert(stored);
  expect(readFileSync(stored, 'utf8')).toBe('new bytes');
  expect(readdirSync(join(root, 'cache'))).toEqual(['entry']);
});

test('an overwrite whose publication fails keeps the existing entry', () => {
  const source = join(root, 'App.apk');
  writeFileSync(source, 'new bytes');
  const dest = join(root, 'cache', 'entry');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'App.apk'), 'old bytes');

  expect(() =>
    storeArtifact(dest, source, {
      runFile: execFileSync,
      overwrite: true,
      writeMetadata: (staging) => rmSync(staging, { recursive: true, force: true }),
    }),
  ).toThrow(/ENOENT/);

  expect(readFileSync(join(dest, 'App.apk'), 'utf8')).toBe('old bytes');
  expect(readdirSync(join(root, 'cache'))).toEqual(['entry']);
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
  expect(readdirSync(join(root, 'cache'))).toEqual(['entry']);
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
