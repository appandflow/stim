import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cargoTargetTrimClaims } from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { staleCargoPaths, staleCargoTargetPaths, trimCargoTarget } from '../workspace/cargo-target.ts';
import { launchingWith, noLaunchers } from './fixtures/launching.ts';

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
  writeFileSync(join(dir, '.cargo-lock'), '');
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

test('a target triple holding anything but Cargo files and profiles loses only its stale profiles', () => {
  makeProfile('apple-modules/host-dev', 3 * DAY);
  writeFileSync(join(target, 'apple-modules', 'kept-crates-host-dev.json'), '{}');
  makeProfile('aarch64-apple-ios/release', 3 * DAY);
  writeFileSync(join(target, 'aarch64-apple-ios', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
  writeFileSync(join(target, 'aarch64-apple-ios', '.rustc_info.json'), '{}');

  const stale = staleCargoTargetPaths(target, Date.now());
  expect('paths' in stale ? stale.paths.toSorted() : stale).toEqual(['aarch64-apple-ios', 'apple-modules/host-dev']);
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

    const result = await trimCargoTarget(target, { launching: noLaunchers(target), needBytes: 0 });

    expect(result.removed.toSorted()).toEqual(['aarch64-linux-android', 'debug']);
    expect(existsSync(join(target, 'debug'))).toBe(false);
    expect(existsSync(join(target, 'release', 'deps', 'libx.rlib'))).toBe(true);
    expect(existsSync(join(target, '.stim-trimmed'))).toBe(false);
  } finally {
    resetExecutor();
  }
});

function stubProcesses(handlers: { lsof?: (args: string[]) => string; ps?: () => string }): void {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: async (file, args, options) => {
      if (file === 'lsof') return handlers.lsof?.(args) ?? '';
      if (file === 'ps') return handlers.ps?.() ?? '';
      return real.runFileAsync(file, args, options);
    },
  });
}

test('a profile a process works in or runs a binary from stays, and an unreadable process list keeps everything', async () => {
  try {
    makeProfile('debug', 3 * DAY);
    makeProfile('release', 3 * DAY);
    makeProfile('host-dev', 3 * DAY);
    const real = realpathSync.native(target);
    stubProcesses({
      lsof: (args) => (args.includes('-t') ? '' : `p100\nn${real}/debug\nn/usr/lib/libSystem.B.dylib\n`),
      ps: () => `${real}/release/deps/mytest-0123456789abcdef --nocapture\n/bin/zsh -l\n`,
    });

    const result = await trimCargoTarget(target, { launching: noLaunchers(target), needBytes: 0 });

    expect(result.removed).toEqual(['host-dev']);
    expect(result.kept).toEqual(['debug: a process uses it', 'release: a process uses it']);

    stubProcesses({
      lsof: () => {
        throw new Error('lsof timed out');
      },
    });
    makeProfile('profile-b', 3 * DAY);
    const unreadable = await trimCargoTarget(target, { launching: noLaunchers(target), needBytes: 0 });
    expect(unreadable.removed).toEqual([]);
    expect(existsSync(join(target, 'profile-b', 'deps', 'libx.rlib'))).toBe(true);
  } finally {
    resetExecutor();
  }
});

test('a directory that cannot be put back after a build took its lock is never deleted', async () => {
  try {
    makeProfile('debug', 3 * DAY);
    let locks = 0;
    stubProcesses({
      lsof: (args) => {
        if (
          !args.includes(join(realpathSync.native(target), 'debug', '.cargo-lock')) &&
          !args.some((arg) => arg.includes('.stim-trimmed'))
        )
          return '';
        if (++locks < 2) return '';
        mkdirSync(join(target, 'debug', 'deps'), { recursive: true });
        writeFileSync(join(target, 'debug', 'deps', 'new-build'), 'x');
        return '4242\n';
      },
    });
    const result = await trimCargoTarget(target, { launching: noLaunchers(target), needBytes: 0 });

    expect(result.removed).toEqual([]);
    expect(result.kept.join(' ')).toContain('could not be put back');
    expect(existsSync(join(target, 'debug', 'deps', 'new-build'))).toBe(true);
    const stranded = readdirSync(target).filter((name) => name.startsWith('.stim-not-restored-'));
    expect(stranded).toHaveLength(1);
    expect(existsSync(join(target, stranded[0] ?? '', '.fingerprint'))).toBe(true);
  } finally {
    resetExecutor();
  }
});

test('a profile whose Cargo 1.97 build lock is held stays, whichever of the lock files the build holds', async () => {
  try {
    makeProfile('debug', 3 * DAY);
    writeFileSync(join(target, 'debug', '.cargo-build-lock'), '');
    const old = new Date(Date.now() - 3 * DAY);
    utimesSync(join(target, 'debug'), old, old);
    stubProcesses({
      lsof: (args) => (args.includes('-t') && args.some((arg) => arg.endsWith('.cargo-build-lock')) ? '4242\n' : ''),
    });

    const result = await trimCargoTarget(target, { launching: noLaunchers(target), needBytes: 0 });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(['debug: a build holds its .cargo-build-lock']);
  } finally {
    resetExecutor();
  }
});

test('a second trim of a target, from another Stim home, keeps what the first moved aside and reports that it was kept', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-cargo-trim-home-'));
  const otherHome = mkdtempSync(join(tmpdir(), 'stim-cargo-trim-other-'));
  vi.stubEnv('STIM_HOME', home);
  try {
    makeProfile('debug', 3 * DAY);
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => (release = done));
    let paused: () => void = () => {};
    const reachedPause = new Promise<void>((done) => (paused = done));
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) => {
        if (file === 'lsof' && args.some((arg: string) => arg.includes('.stim-trimmed'))) {
          paused();
          await gate;
          return '';
        }
        return file === 'lsof' || file === 'ps' ? '' : real.runFileAsync(file, args, options);
      },
    });
    const first = trimCargoTarget(target, { launching: noLaunchers(target), needBytes: 0 });
    await reachedPause;
    const staged = join(realpathSync.native(target), '.stim-trimmed', '0', '.fingerprint');
    expect(existsSync(staged)).toBe(true);

    vi.stubEnv('STIM_HOME', otherHome);
    const second = await trimCargoTarget(target, { launching: noLaunchers(target), needBytes: 0 });

    expect(second.removed).toEqual([]);
    expect(second.kept.join(' ')).toContain('another trim of it holds');
    expect(existsSync(staged)).toBe(true);
    release();
    expect((await first).removed).toEqual(['debug']);
    expect(existsSync(join(target, '.stim-trimmed'))).toBe(false);
    expect(existsSync(cargoTargetTrimClaims(realpathSync.native(target)))).toBe(false);
  } finally {
    resetExecutor();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(otherHome, { recursive: true, force: true });
  }
});

test('a trim stopped at a deadline keeps every unit it has not moved, finishes the one in flight and walks nothing', async () => {
  try {
    for (const name of ['debug', 'release', 'host-dev']) makeProfile(name, 3 * DAY);
    const deadline = new AbortController();
    const real = getExecutor();
    const walked: string[] = [];
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) => {
        if (file === 'du' || file === 'nice') walked.push(String(args.at(-1)));
        if (file === 'lsof' && args.some((arg: string) => arg.includes('.stim-trimmed'))) deadline.abort();
        return file === 'lsof' || file === 'ps' ? '' : real.runFileAsync(file, args, options);
      },
    });

    const result = await trimCargoTarget(target, {
      launching: noLaunchers(target),
      needBytes: 0,
      incremental: 'all',
      measure: false,
      stop: deadline.signal,
    });

    const present = ['debug', 'release', 'host-dev'].filter((name) =>
      existsSync(join(target, name, 'deps', 'libx.rlib')),
    );
    expect(result.removed).toHaveLength(1);
    expect(present).toHaveLength(2);
    for (const name of present)
      expect(existsSync(join(target, name, '.fingerprint', 'unit-0123456789abcdef', 'lib'))).toBe(true);
    expect(result.kept.join(' ')).toContain('headroom deadline');
    expect(existsSync(join(target, '.stim-trimmed'))).toBe(false);
    expect(walked).toEqual([]);
  } finally {
    resetExecutor();
  }
});

test('a launcher on PATH that appears after the first reading keeps what it points into at the later reading, and an incomplete reading keeps everything', async () => {
  try {
    makeProfile('release', 0);
    mkdirSync(join(target, 'release', 'incremental', 'x'), { recursive: true });
    const real = realpathSync.native(target);
    stubProcesses({});
    let readings = 0;
    const launchers = async () => ({
      targets: readings++ === 0 ? [] : [`${real}/release/incremental/x/tool`],
      incomplete: [],
    });

    const result = await trimCargoTarget(target, {
      needBytes: 1,
      incremental: 'all',
      launching: { launchers, anew: launchers, checkout: target },
    });

    expect(readings).toBe(2);
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining('on PATH')]);
    expect(existsSync(join(target, 'release', 'incremental', 'x'))).toBe(true);

    makeProfile('debug', 3 * DAY);
    const unreadable = await trimCargoTarget(target, {
      needBytes: 0,
      launching: launchingWith(target, {
        targets: [],
        incomplete: [{ kind: 'directory', path: '/locked', error: 'EACCES' }],
      }),
    });
    expect(unreadable.removed).toEqual([]);
    expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(true);
  } finally {
    resetExecutor();
  }
});
