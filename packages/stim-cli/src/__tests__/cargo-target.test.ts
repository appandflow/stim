import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  renameStands,
  selectIncremental,
  staleCargoPaths,
  staleCargoTargetPaths,
  trimCargoTarget,
} from '../workspace/cargo-target.ts';

const DAY = 24 * 3_600_000;
const NOW = Date.parse('2026-11-11T20:00:00Z');
const profile = (path: string, ageMs: number | null) => ({ path, lastUsedMs: ageMs === null ? null : NOW - ageMs });

test('a stale profile goes alone, a triple goes whole only when every profile in it is stale and it holds nothing else', () => {
  const profiles = [
    profile('debug', 2 * DAY),
    profile('release', DAY / 2),
    profile('aarch64-linux-android/host-dev', 3 * DAY),
    profile('aarch64-apple-ios/debug', 3 * DAY),
    profile('aarch64-apple-ios/release', DAY / 2),
    profile('wasm32-unknown-unknown/debug', 3 * DAY),
    profile('wasm32-unknown-unknown/release', 3 * DAY),
  ];
  expect(staleCargoPaths(profiles, new Set(['aarch64-linux-android']), NOW).toSorted()).toEqual([
    'aarch64-apple-ios/debug',
    'aarch64-linux-android/host-dev',
    'debug',
    'wasm32-unknown-unknown',
  ]);
});

test('a profile whose last use cannot be read stays', () => {
  expect(staleCargoPaths([profile('debug', null)], new Set(), NOW)).toEqual([]);
});

let target: string;
beforeEach(() => {
  target = mkdtempSync(join(tmpdir(), 'stim-cargo-target-'));
});
afterEach(() => rmSync(target, { recursive: true, force: true }));

function makeProfile(path: string, ageMs: number): void {
  const dir = join(target, path);
  for (const part of ['.fingerprint', 'deps', 'build', 'incremental']) mkdirSync(join(dir, part), { recursive: true });
  mkdirSync(join(dir, '.fingerprint', 'unit-0123456789abcdef'));
  writeFileSync(join(dir, '.fingerprint', 'unit-0123456789abcdef', 'lib'), 'x');
  writeFileSync(join(dir, 'deps', 'libx.rlib'), 'x'.repeat(1000));
  const at = new Date(Date.now() - ageMs);
  for (const entry of [
    join(dir, '.fingerprint', 'unit-0123456789abcdef', 'lib'),
    join(dir, '.fingerprint', 'unit-0123456789abcdef'),
    ...['.fingerprint', 'deps', 'build', 'incremental'].map((part) => join(dir, part)),
    join(dir, 'deps', 'libx.rlib'),
    dir,
  ])
    utimesSync(entry, at, at);
}

test('an Exact ledger stamp keeps a profile whose directories were not written for days', () => {
  makeProfile('debug', 3 * DAY);
  makeProfile('release', 3 * DAY);
  writeFileSync(
    join(target, '.exact-sweep.json'),
    JSON.stringify({ at: Date.now(), units: { 'release#0123456789abcdef': Date.now() - 1000 } }),
  );

  expect(staleCargoTargetPaths(target, Date.now())).toEqual({ paths: ['debug'] });
});

test('a ledger that is not a unit ledger refuses the whole target', () => {
  makeProfile('debug', 3 * DAY);
  writeFileSync(join(target, '.exact-sweep.json'), '{"units":');
  expect(staleCargoTargetPaths(target, Date.now())).toMatchObject({ refusal: expect.stringContaining('unit ledger') });
});

test('trimming removes the stale profiles, keeps the rest and leaves nothing aside', async () => {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: async (file, args, options) =>
      file === 'lsof' || file === 'ps' ? '' : real.runFileAsync(file, args, options),
  });
  try {
    makeProfile('debug', 3 * DAY);
    makeProfile('aarch64-linux-android/host-dev', 3 * DAY);
    makeProfile('release', 0);

    const result = await trimCargoTarget(target, { needBytes: 0 });

    expect(result.removed.toSorted()).toEqual(['aarch64-linux-android', 'debug']);
    expect(existsSync(join(target, 'debug'))).toBe(false);
    expect(existsSync(join(target, 'release', 'deps', 'libx.rlib'))).toBe(true);
    expect(existsSync(join(target, '.stim-trimmed'))).toBe(false);
  } finally {
    resetExecutor();
  }
});

test('the incremental pass takes the largest directories until the overage is covered', () => {
  const candidates = [
    { path: 'a', bytes: 5 },
    { path: 'b', bytes: 9 },
    { path: 'c', bytes: 2 },
  ];
  expect(selectIncremental(candidates, 12)).toEqual(['b', 'a']);
  expect(selectIncremental(candidates, 100)).toEqual(['b', 'a', 'c']);
  expect(selectIncremental(candidates, 0)).toEqual([]);
});

test('a move is rolled back when a build holds the lock afterwards or lsof cannot say', () => {
  expect(renameStands({ stdout: '' })).toBe(true);
  expect(renameStands({ status: 1, stdout: '' })).toBe(true);
  expect(renameStands({ stdout: '4242\n' })).toBe(false);
  expect(renameStands({ status: 2, stdout: '' })).toBe(false);
});
