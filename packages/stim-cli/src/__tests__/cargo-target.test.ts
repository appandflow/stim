import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cargoTargetTrimClaims } from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  deleteCargoTarget,
  staleCargoPaths,
  targetEntries,
  staleCargoTargetPaths,
  trimCargoTarget,
} from '../workspace/cargo-target.ts';
import { launchingWith, noLaunchers } from './fixtures/launching.ts';

const fsHooks = vi.hoisted(
  (): {
    rename?: (from: string) => void | Promise<void>;
    link?: (to: string) => void;
    dev?: (path: string) => number | undefined;
  } => ({}),
);
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fsHooks.rename?.(String(args[0]));
      return fs.rename(...args);
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      fsHooks.link?.(String(args[1]));
      return fs.link(...args);
    },
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await fs.lstat(...args);
      const dev = fsHooks.dev?.(String(args[0]));
      return dev === undefined ? stat : Object.assign(stat, { dev });
    },
  };
});

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

test.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
  'a launcher target under a case variant of the target keeps its profile, and a stale profile with none goes',
  async () => {
    try {
      makeProfile('debug', 3 * DAY);
      makeProfile('release', 3 * DAY);
      stubProcesses({});
      const disk = realpathSync.native(target);
      const variant = target.replace('stim-cargo-target-', 'STIM-CARGO-TARGET-');
      expect(variant).not.toBe(target);

      const result = await trimCargoTarget(variant, {
        needBytes: 0,
        launching: launchingWith(variant, { targets: [`${disk}/debug/deps/tool`], incomplete: [] }),
      });

      expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(true);
      expect(existsSync(join(target, 'release'))).toBe(false);
      expect(result.removed).toEqual(['release']);
      expect(result.kept.join(' ')).toContain('debug');
    } finally {
      resetExecutor();
    }
  },
);

test('a launcher on PATH that appears after the first reading keeps what it points into at the later reading, and a reading that has not answered keeps everything', async () => {
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
    const unanswered = await trimCargoTarget(target, {
      needBytes: 0,
      launching: launchingWith(target, {
        targets: [],
        incomplete: [{ kind: 'pending', path: '/hung', error: 'timed out' }],
      }),
    });
    expect(unanswered.removed).toEqual([]);
    expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(true);
  } finally {
    resetExecutor();
  }
});

function ageTree(path: string): void {
  const old = new Date(Date.now() - 3 * DAY);
  for (const entry of readdirSync(path, { withFileTypes: true }))
    if (entry.isDirectory()) ageTree(join(path, entry.name));
    else utimesSync(join(path, entry.name), old, old);
  utimesSync(path, old, old);
}

describe.skipIf(process.platform === 'win32')(
  'deleting an idle Cargo target whole (skipped on win32, where Stim cannot list the running processes)',
  () => {
    let dir: string;
    let real: string;
    beforeEach(() => {
      dir = join(target, 'target');
      writeFileSync(join(target, 'Cargo.toml'), '');
      for (const path of ['debug/.fingerprint/unit', 'debug/deps', 'doc'])
        mkdirSync(join(dir, path), { recursive: true });
      writeFileSync(join(dir, '.rustc_info.json'), '{}');
      writeFileSync(join(dir, 'debug', '.cargo-lock'), '');
      writeFileSync(join(dir, 'debug', 'app'), 'binary');
      writeFileSync(join(dir, 'doc', 'index.html'), 'x');
      ageTree(dir);
      real = realpathSync(dir);
      stubProcesses({});
    });
    afterEach(() => {
      resetExecutor();
      delete fsHooks.rename;
      delete fsHooks.dev;
      delete fsHooks.link;
    });
    const remove = () => deleteCargoTarget(dir, { idleMs: DAY, launching: noLaunchers(target) });

    test('everything goes after the move aside but a deploy/ folder holding a Solana keypair', async () => {
      for (const name of ['criterion', 'gungraun', 'iai']) {
        mkdirSync(join(dir, name, 'base'), { recursive: true });
        writeFileSync(join(dir, name, 'base', 'summary.json'), '{}');
      }
      mkdirSync(join(dir, 'deploy'));
      writeFileSync(join(dir, 'deploy', 'app-keypair.json'), '[1,2,3]');
      writeFileSync(join(dir, 'deploy', 'app.so'), 'program');
      mkdirSync(join(dir, 'notes'));
      mkdirSync(join(dir, 'cargo-timings'));
      writeFileSync(join(dir, 'cargo-timings', 'cargo-timing.html'), '<html>');
      writeFileSync(join(dir, '.future-incompat-report.json'), '{}');
      ageTree(dir);

      const result = await remove();

      expect(result.removed.toSorted()).toEqual([
        '.future-incompat-report.json',
        '.rustc_info.json',
        'cargo-timings',
        'criterion',
        'debug',
        'doc',
        'gungraun',
        'iai',
        'notes',
      ]);
      expect(result.kept).toEqual([]);
      expect(readdirSync(dir)).toEqual(['deploy']);
      expect(readFileSync(join(dir, 'deploy', 'app-keypair.json'), 'utf8')).toBe('[1,2,3]');
      expect(readFileSync(join(dir, 'deploy', 'app.so'), 'utf8')).toBe('program');
    });

    test('a deploy/ folder without a keypair goes, and so does the emptied target/', async () => {
      mkdirSync(join(dir, 'deploy'));
      writeFileSync(join(dir, 'deploy', 'app.so'), 'program');
      ageTree(dir);

      const result = await remove();

      expect(result.removed).toContain('deploy');
      expect(existsSync(dir)).toBe(false);
    });

    test('a symbolic link named like a Cargo file stays, and so does what it points at', async () => {
      const outside = join(target, 'outside.json');
      writeFileSync(outside, 'theirs');
      rmSync(join(dir, '.rustc_info.json'));
      symlinkSync(outside, join(dir, '.rustc_info.json'));
      const old = new Date(Date.now() - 3 * DAY);
      lutimesSync(join(dir, '.rustc_info.json'), old, old);
      utimesSync(dir, old, old);

      const result = await remove();

      expect(result.removed.toSorted()).toEqual(['debug', 'doc']);
      expect(lstatSync(join(dir, '.rustc_info.json')).isSymbolicLink()).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe('theirs');
    });

    test('an entry on another device that cannot be renamed stays, and the rest goes', async () => {
      fsHooks.rename = (from) => {
        if (from.endsWith('/doc'))
          throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      };

      const result = await remove();

      expect(result.kept).toEqual([expect.stringContaining('doc: it could not be moved aside: EXDEV')]);
      expect(readdirSync(dir)).toEqual(['doc']);
    });

    test.each([
      [
        'a trim left a directory for a person',
        () => mkdirSync(join(dir, '.stim-not-restored-1-0')),
        'could not put back',
      ],
      [
        'a build wrote a top-level entry',
        () => utimesSync(join(dir, 'doc'), new Date(), new Date()),
        'doc was written in that time',
      ],
      [
        'a build wrote one level into a top-level directory',
        () => utimesSync(join(dir, 'debug', 'deps'), new Date(), new Date()),
        'debug/deps was written in that time',
      ],
      [
        'a build wrote inside a target triple profile only',
        () => {
          mkdirSync(join(dir, 'aarch64-apple-ios', 'debug', '.fingerprint'), { recursive: true });
          mkdirSync(join(dir, 'aarch64-apple-ios', 'debug', 'deps'));
          ageTree(dir);
          utimesSync(join(dir, 'aarch64-apple-ios', 'debug', 'deps'), new Date(), new Date());
        },
        'a build used its aarch64-apple-ios/debug profile in that time',
      ],
      [
        "Exact's ledger stamps a unit in that time",
        () => {
          writeFileSync(
            join(dir, '.exact-sweep.json'),
            JSON.stringify({ at: Date.now(), units: { 'debug#0123456789abcdef': Date.now() - 1000 } }),
          );
          ageTree(dir);
        },
        "Exact's ledger stamps a unit",
      ],
      [
        'a process runs a binary in it',
        () => stubProcesses({ lsof: (args) => (args.includes('-Fn') ? `p100\nn${real}/debug/app\n` : '') }),
        'a process uses',
      ],
      [
        'a build holds a profile lock',
        () => stubProcesses({ lsof: (args) => (args.at(-1) === join(real, 'debug', '.cargo-lock') ? '4242\n' : '') }),
        'a build holds',
      ],
      [
        'a build takes a profile lock during the move',
        () =>
          stubProcesses({
            lsof: (args) =>
              args.at(-1)?.includes('.stim-trimmed') && args.at(-1)?.endsWith('.cargo-lock') ? '4242\n' : '',
          }),
        'during the move',
      ],
      [
        'a process opens a file in it during the move',
        () => {
          let reads = 0;
          stubProcesses({
            lsof: (args) => (args.includes('-Fn') && reads++ > 0 ? `p100\nn${real}/.stim-trimmed/0/index.html\n` : ''),
          });
        },
        'a process took',
      ],
      [
        'a process names a moved file by its original path during the move',
        () => {
          let reads = 0;
          stubProcesses({
            lsof: (args) => (args.includes('-Fn') && reads++ > 0 ? `p100\nn${real}/doc/index.html\n` : ''),
          });
        },
        'a process took',
      ],
      [
        'a build writes an entry staged later during the move',
        () =>
          (fsHooks.rename = (from) => {
            if (from.endsWith('/debug')) utimesSync(join(dir, 'doc', 'index.html'), new Date(), new Date());
          }),
        'was used during the move',
      ],
      [
        'another filesystem is mounted in it',
        () => (fsHooks.dev = (path) => (path.endsWith('/doc') ? -1 : undefined)),
        'another filesystem',
      ],
      ['it is no longer a Cargo target', () => rmSync(join(target, 'Cargo.toml')), 'no longer a Cargo target'],
      [
        'a process works in the target itself',
        () => stubProcesses({ lsof: (args) => (args.includes('-Fn') ? `p100\nn${real}\n` : '') }),
        'a process uses',
      ],
      [
        'a process holds a file in a folder the delete would remove',
        () => {
          mkdirSync(join(dir, 'notes'));
          writeFileSync(join(dir, 'notes', 'open.txt'), 'x');
          ageTree(dir);
          stubProcesses({ lsof: (args) => (args.includes('-Fn') ? `p100\nn${real}/notes/open.txt\n` : '') });
        },
        'a process uses',
      ],
      [
        "a process opens a file under a moved folder's original path during the move",
        () => {
          mkdirSync(join(dir, 'notes'));
          ageTree(dir);
          let reads = 0;
          stubProcesses({
            lsof: (args) => (args.includes('-Fn') && reads++ > 0 ? `p100\nn${real}/notes/new.txt\n` : ''),
          });
        },
        'a process took',
      ],
    ])('it stays whole when %s', async (_, arrange, why) => {
      arrange();

      const result = await remove();

      expect(result.removed).toEqual([]);
      expect(result.kept).toContainEqual(expect.stringContaining(why));
      expect(existsSync(join(dir, 'debug', 'app'))).toBe(true);
      expect(existsSync(join(dir, 'doc', 'index.html'))).toBe(true);
      expect(existsSync(join(dir, '.stim-trimmed'))).toBe(false);
    });

    test.each([
      ['a bind mount lies under it', () => `36 35 0:1 / ${real}/doc rw - ext4 /dev/x rw\n`, 'is a mount point'],
      [
        'the mounts cannot be read',
        () => {
          throw new Error('EACCES');
        },
        'the mounts cannot be read',
      ],
    ])('it stays whole when %s', async (_, mountInfo, why) => {
      const result = await deleteCargoTarget(dir, { idleMs: DAY, launching: noLaunchers(target), mountInfo });

      expect(result.kept).toEqual([expect.stringContaining(why)]);
      expect(existsSync(join(dir, 'doc', 'index.html'))).toBe(true);
    });

    test('a delete that stops after staging leaves a marker that later trims and deletes refuse', async () => {
      let reached!: () => void;
      const staged = new Promise<void>((resolve) => (reached = resolve));
      fsHooks.rename = (from) => {
        if (!from.endsWith('/doc')) return;
        reached();
        return new Promise(() => {});
      };
      void remove();
      await staged;
      delete fsHooks.rename;
      rmSync(cargoTargetTrimClaims(real), { recursive: true, force: true });

      const trim = await trimCargoTarget(dir, { launching: noLaunchers(target), needBytes: 0 });
      const again = await remove();

      expect(trim.kept).toEqual([expect.stringContaining('could not be put back')]);
      expect(again).toMatchObject({ removed: [], kept: [expect.any(String)] });
      expect(readFileSync(join(dir, '.stim-trimmed', '1', 'app'), 'utf8')).toBe('binary');
      expect(JSON.parse(readFileSync(join(dir, '.stim-trimmed', 'NOT-RESTORED'), 'utf8'))).toMatchObject({
        1: 'debug',
      });
      expect(existsSync(join(dir, 'doc', 'index.html'))).toBe(true);
    });

    test.skipIf(process.getuid?.() === 0)('a deploy/ folder that cannot be read counts as holding a keypair', () => {
      mkdirSync(join(dir, 'deploy'));
      chmodSync(join(dir, 'deploy'), 0o000);
      try {
        expect(targetEntries(dir)).toMatchObject({ kept: ['deploy'] });
      } finally {
        chmodSync(join(dir, 'deploy'), 0o755);
      }
    });

    test.each([
      [
        'a keypair appears in the staged deploy/',
        () => {
          mkdirSync(join(dir, 'deploy'));
          ageTree(dir);
          return () => writeFileSync(join(dir, '.stim-trimmed', '2', 'app-keypair.json'), '[1]');
        },
        'holds a Solana keypair now',
      ],
      ['a build recreates a moved profile', () => () => mkdirSync(join(dir, 'debug')), 'appeared during the move'],
      [
        'a write lands in the kept deploy/',
        () => {
          mkdirSync(join(dir, 'deploy'));
          writeFileSync(join(dir, 'deploy', 'app-keypair.json'), '[1]');
          ageTree(dir);
          return () => utimesSync(join(dir, 'deploy', 'app-keypair.json'), new Date(), new Date());
        },
        'was used during the move',
      ],
    ])('it puts everything back when %s before the delete', async (_, arrange, why) => {
      const during = arrange();
      fsHooks.rename = (from) => {
        if (from.endsWith('/doc')) during();
      };

      const result = await remove();

      expect(result.removed).toEqual([]);
      expect(result.kept).toEqual([expect.stringContaining(why)]);
      expect(existsSync(join(dir, 'doc', 'index.html'))).toBe(true);
      expect(readdirSync(dir).some((name) => name === 'debug' || name.startsWith('.stim-not-restored-'))).toBe(true);
    });

    test('a mount that appears under the target during the move puts everything back', async () => {
      let reads = 0;
      const mountInfo = () => (reads++ ? `36 35 0:1 / ${real}/doc rw - ext4 /dev/x rw\n` : '');

      const result = await deleteCargoTarget(dir, { idleMs: DAY, launching: noLaunchers(target), mountInfo });

      expect(result.kept).toEqual([expect.stringContaining('is a mount point')]);
      expect(existsSync(join(dir, 'doc', 'index.html'))).toBe(true);
      expect(existsSync(join(dir, 'debug', 'app'))).toBe(true);
    });

    test('a tagged target whose staged size scan is cancelled gets its names back and goes on the next run', async () => {
      rmSync(join(target, 'Cargo.toml'));
      writeFileSync(join(dir, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
      ageTree(dir);
      const controller = new AbortController();
      const executor = getExecutor();
      setExecutor({
        ...executor,
        runFileAsync: async (file, args, options) => {
          if (file === 'du') {
            controller.abort();
            throw new Error('du was cancelled');
          }
          return file === 'lsof' || file === 'ps' ? '' : executor.runFileAsync(file, args, options);
        },
      });

      await expect(
        deleteCargoTarget(dir, { idleMs: DAY, launching: noLaunchers(target), signal: controller.signal }),
      ).rejects.toThrow('aborted');

      expect(readdirSync(dir).toSorted()).toEqual(['.rustc_info.json', 'CACHEDIR.TAG', 'debug', 'doc']);
      stubProcesses({});
      ageTree(dir);
      expect((await remove()).kept).toEqual([]);
      expect(existsSync(dir)).toBe(false);
    });

    test('a cancelled delete puts every moved entry back and leaves nothing staged', async () => {
      const controller = new AbortController();
      fsHooks.rename = (from) => {
        if (from.endsWith('/debug')) controller.abort();
      };

      await expect(
        deleteCargoTarget(dir, { idleMs: DAY, launching: noLaunchers(target), signal: controller.signal }),
      ).rejects.toThrow('aborted');

      expect(readdirSync(dir).toSorted()).toEqual(['.rustc_info.json', 'debug', 'doc']);
      expect(existsSync(join(dir, 'doc', 'index.html'))).toBe(true);
    });

    test('a roll back keeps a file a build recreates between the check and the restore', async () => {
      stubProcesses({
        lsof: (args) => {
          const lock = args.at(-1) ?? '';
          return lock.includes('.stim-trimmed') && lock.endsWith('.cargo-lock') ? '4242\n' : '';
        },
      });
      const recreate = () => writeFileSync(join(dir, '.rustc_info.json'), 'new');
      fsHooks.link = (to) => {
        if (to.endsWith('/.rustc_info.json')) recreate();
      };
      fsHooks.rename = (from) => {
        if (from.endsWith('/.stim-trimmed/0')) recreate();
      };

      const result = await remove();

      expect(result.kept).toEqual([expect.stringContaining('could not be put back')]);
      expect(readFileSync(join(dir, '.rustc_info.json'), 'utf8')).toBe('new');
      const kept = readdirSync(dir).find((name) => name.startsWith('.stim-not-restored-')) ?? '';
      expect(readFileSync(join(dir, kept), 'utf8')).toBe('{}');
    });

    test('a roll back keeps a file a build recreated and leaves the staged copy for a person', async () => {
      stubProcesses({
        lsof: (args) => {
          const lock = args.at(-1) ?? '';
          if (!lock.includes('.stim-trimmed') || !lock.endsWith('.cargo-lock')) return '';
          writeFileSync(join(dir, '.rustc_info.json'), 'new');
          return '4242\n';
        },
      });

      const result = await remove();

      expect(result.kept).toEqual([expect.stringContaining('could not be put back')]);
      expect(readFileSync(join(dir, '.rustc_info.json'), 'utf8')).toBe('new');
      const kept = readdirSync(dir).find((name) => name.startsWith('.stim-not-restored-')) ?? '';
      expect(readFileSync(join(dir, kept), 'utf8')).toBe('{}');
      expect(existsSync(join(dir, 'debug', 'app'))).toBe(true);
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  "deleting an idle Exact app's target, whose Exact folders all stay (skipped on win32, as above)",
  () => {
    let dir: string;
    let lock: string;
    beforeEach(() => {
      dir = join(target, 'target');
      writeFileSync(join(target, 'exact.mjs'), '');
      for (const path of [
        '.apple-cargo-locks/aarch64-apple-ios',
        'bake/app',
        'clients/app',
        'apple-swift/ios-17.0',
        'debug/.fingerprint',
      ])
        mkdirSync(join(dir, path), { recursive: true });
      writeFileSync(join(dir, '.rustc_info.json'), '{}');
      lock = join(dir, '.apple-cargo-locks', 'aarch64-apple-ios', 'libapp.lock.flock');
      for (const file of [lock, join(dir, '.exact-sweep.json.lock'), join(dir, 'clients', 'app', 'client.js')])
        writeFileSync(file, '');
      writeFileSync(join(dir, '.exact-sweep.json'), JSON.stringify({ at: Date.now() - 3 * DAY, units: {} }));
      ageTree(dir);
      stubProcesses({});
    });
    afterEach(() => {
      if (existsSync(join(dir, 'bake'))) chmodSync(join(dir, 'bake'), 0o755);
      resetExecutor();
    });
    const remove = () => deleteCargoTarget(dir, { idleMs: DAY, launching: noLaunchers(target) });

    test('it goes whole when old: Exact folders, records and receipts included', async () => {
      mkdirSync(join(dir, 'traces'));
      writeFileSync(join(dir, 'traces', 'trace-1.json'), '{"session":1}');
      writeFileSync(join(dir, 'web-dist.json'), '{}');
      mkdirSync(join(dir, 'web-dist.previous'));
      writeFileSync(join(dir, 'web-dist.previous', 'notes.md'), 'mine');
      for (const scratch of ['web-check-AbC123', 'push-ts-Xy9Z01']) mkdirSync(join(dir, scratch));
      writeFileSync(join(dir, 'web-check-failure.json'), '{}');
      mkdirSync(join(dir, 'apple-modules'));
      writeFileSync(join(dir, 'apple-modules', '.exact-sweep.json'), '{"units":{"debug#00":1}}');
      writeFileSync(join(dir, 'apple-modules', '.exact-sweep.json.lock'), '');
      writeFileSync(join(dir, 'clients', 'app', 'receipt.json'), '{"development":{"token":"abc"}}');
      ageTree(dir);

      const result = await remove();

      expect(result.kept).toEqual([]);
      expect(result.removed).toEqual(expect.arrayContaining(['apple-modules', 'bake', 'clients', 'traces']));
      expect(existsSync(dir)).toBe(false);
    });

    test.each([
      [
        'a build wrote one level into a top-level directory',
        () => utimesSync(join(dir, 'clients', 'app'), new Date(), new Date()),
        'clients/app was written in that time',
      ],
      [
        'a build holds an Apple Cargo lock',
        () =>
          stubProcesses({
            lsof: (args) =>
              args.at(-1) === join(realpathSync(dir), '.apple-cargo-locks', 'aarch64-apple-ios', 'libapp.lock.flock')
                ? '4242\n'
                : '',
          }),
        'libapp.lock.flock',
      ],
    ])('it stays whole when %s', async (_, arrange, why) => {
      arrange();

      const result = await remove();

      expect(result.removed).toEqual([]);
      expect(result.kept).toContainEqual(expect.stringContaining(why));
      expect(existsSync(join(dir, 'clients', 'app', 'client.js'))).toBe(true);
    });
    test('an Apple Cargo lock a build takes during the move puts everything back', async () => {
      stubProcesses({
        lsof: (args) =>
          args.at(-1)?.includes('.stim-trimmed') && args.at(-1)?.endsWith('libapp.lock.flock') ? '4242\n' : '',
      });

      const result = await remove();

      expect(result.kept).toEqual([expect.stringContaining('during the move')]);
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(join(dir, 'clients', 'app', 'client.js'))).toBe(true);
    });

    test.skipIf(process.getuid?.() === 0)('it stays whole when an entry cannot be listed', async () => {
      chmodSync(join(dir, 'bake'), 0o000);

      const result = await remove();

      expect(result.kept).toContainEqual(expect.stringContaining('bake cannot be listed'));
      expect(existsSync(join(dir, 'clients', 'app', 'client.js'))).toBe(true);
    });
  },
);
