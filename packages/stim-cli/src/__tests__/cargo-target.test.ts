import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { withCargoLocks } from '../workspace/cargo-lock.ts';
import {
  deleteCargoTarget,
  removableEntries,
  staleCargoPaths,
  staleCargoTargetPaths,
  targetEntries,
  trimCargoTarget,
} from '../workspace/cargo-target.ts';

const fsHooks = vi.hoisted(
  (): { dev?: (path: string) => number | undefined; afterLstat?: (path: string) => void } => ({}),
);
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await fs.lstat(...args);
      const dev = fsHooks.dev?.(String(args[0]));
      fsHooks.afterLstat?.(String(args[0]));
      return dev === undefined ? stat : Object.assign(stat, { dev });
    },
  };
});
afterEach(() => {
  delete fsHooks.dev;
  delete fsHooks.afterLstat;
  resetExecutor();
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

const locked = <T>(paths: string[], run: () => Promise<T>) => withCargoLocks(paths, run);

describe.skipIf(process.platform === 'win32')('trimming in place (Cargo locks need flock: skipped on win32)', () => {
  beforeEach(() => stubProcesses({}));

  test('stale profiles go in place, their lock files and the fresh profile stay, and nothing is staged', async () => {
    makeProfile('debug', 3 * DAY);
    makeProfile('aarch64-linux-android/host-dev', 3 * DAY);
    makeProfile('release', 0);

    const result = await trimCargoTarget(target, { needBytes: 0 });

    expect(result.removed.toSorted()).toEqual(['aarch64-linux-android', 'debug']);
    expect(readdirSync(join(target, 'debug'))).toEqual(['.cargo-lock']);
    expect(readdirSync(join(target, 'aarch64-linux-android', 'host-dev'))).toEqual(['.cargo-lock']);
    expect(existsSync(join(target, 'release', 'deps', 'libx.rlib'))).toBe(true);
    expect(readdirSync(target).filter((name) => name.startsWith('.stim-'))).toEqual([]);
    expect(staleCargoTargetPaths(target, Date.now())).toEqual({ paths: [] });
  });

  test('a profile a process works in or runs a binary from stays, and an unreadable process list keeps everything', async () => {
    makeProfile('debug', 3 * DAY);
    makeProfile('release', 3 * DAY);
    makeProfile('host-dev', 3 * DAY);
    const real = realpathSync.native(target);
    stubProcesses({
      lsof: () => `p100\nn${real}/debug\nn/usr/lib/libSystem.B.dylib\n`,
      ps: () => `${real}/release/deps/mytest-0123456789abcdef --nocapture\n/bin/zsh -l\n`,
    });

    const result = await trimCargoTarget(target, { needBytes: 0 });

    expect(result.removed).toEqual(['host-dev']);
    expect(result.kept).toEqual(['debug: a process uses it', 'release: a process uses it']);

    stubProcesses({
      lsof: () => {
        throw new Error('lsof timed out');
      },
    });
    makeProfile('profile-b', 3 * DAY);
    const unreadable = await trimCargoTarget(target, { needBytes: 0 });
    expect(unreadable.removed).toEqual([]);
    expect(existsSync(join(target, 'profile-b', 'deps', 'libx.rlib'))).toBe(true);
  });

  test.each(['.cargo-lock', '.cargo-build-lock', '.cargo-artifact-lock'])(
    'a profile whose %s a build holds stays, and the others go',
    async (lock) => {
      makeProfile('debug', 3 * DAY);
      makeProfile('release', 3 * DAY);
      writeFileSync(join(target, 'debug', lock), '');
      const old = new Date(Date.now() - 3 * DAY);
      utimesSync(join(target, 'debug'), old, old);

      const held = await locked([join(target, 'debug', lock)], () => trimCargoTarget(target, { needBytes: 0 }));

      expect(held).toMatchObject({ value: { removed: ['release'] } });
      expect('value' in held && held.value.kept).toEqual([expect.stringMatching(/^debug: a build holds .*debug/)]);
      expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(true);
    },
  );

  test('a profile with no .cargo-lock stays, and a missing build lock is never created', async () => {
    makeProfile('debug', 3 * DAY);
    rmSync(join(target, 'debug', '.cargo-lock'));
    const old = new Date(Date.now() - 3 * DAY);
    utimesSync(join(target, 'debug'), old, old);
    makeProfile('release', 3 * DAY);

    const result = await trimCargoTarget(target, { needBytes: 0 });

    expect(result.removed).toEqual(['release']);
    expect(result.kept).toEqual(['debug: debug has no .cargo-lock to take']);
    expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(true);
    expect(existsSync(join(target, 'release', '.cargo-build-lock'))).toBe(false);
  });

  test('at normal the cap trims only an idle target: a process anywhere in it or a held lock keeps it whole', async () => {
    makeProfile('debug', 3 * DAY);
    makeProfile('release', 0);
    const real = realpathSync.native(target);
    stubProcesses({ lsof: () => `p100\nn${real}/release/deps/libx.rlib\n` });
    const used = await trimCargoTarget(target, { needBytes: 1, idleOnly: true });
    expect(used.removed).toEqual([]);
    expect(used.kept).toEqual([expect.stringContaining('a process uses')]);

    stubProcesses({});
    const held = await locked([join(target, 'release', '.cargo-lock')], () =>
      trimCargoTarget(target, { needBytes: 1, idleOnly: true }),
    );
    expect(held).toMatchObject({ value: { removed: [], kept: [expect.stringContaining('a build holds')] } });
    expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(true);

    const idle = await trimCargoTarget(target, { needBytes: 1, idleOnly: true });
    expect(idle.removed).toEqual(['debug']);
  });

  test('incremental data goes after the stale profiles, largest first until the need is covered', async () => {
    makeProfile('debug', 0);
    makeProfile('release', 0);
    writeFileSync(join(target, 'debug', 'incremental', 'big'), 'x'.repeat(200_000));
    writeFileSync(join(target, 'release', 'incremental', 'small'), 'x');

    const result = await trimCargoTarget(target, { needBytes: 1 });

    expect(result.removed).toEqual(['debug/incremental']);
    expect(existsSync(join(target, 'debug', 'incremental'))).toBe(false);
    expect(existsSync(join(target, 'release', 'incremental', 'small'))).toBe(true);
    expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(true);
  });

  test('the remover unlinks a link without following it, and never unlinks a keypair, a lock file or another device', async () => {
    makeProfile('debug', 3 * DAY);
    const outside = join(tmpdir(), `${realpathSync(target).split('/').at(-1)}-outside`);
    mkdirSync(outside);
    onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'theirs'), 'theirs');
    symlinkSync(outside, join(target, 'debug', 'deps', 'linked'));
    writeFileSync(join(target, 'debug', 'deps', 'App-Keypair.json'), '[1]');
    mkdirSync(join(target, 'debug', 'build', 'mounted'));
    writeFileSync(join(target, 'debug', 'build', 'mounted', 'data'), 'x');
    const old = new Date(Date.now() - 3 * DAY);
    for (const dir of ['deps', 'build', '.']) utimesSync(join(target, 'debug', dir), old, old);
    fsHooks.dev = (path) => (path.endsWith('/mounted') ? -1 : undefined);

    const result = await trimCargoTarget(target, { needBytes: 0 });

    expect(result.removed).toEqual(['debug']);
    expect(readFileSync(join(outside, 'theirs'), 'utf8')).toBe('theirs');
    expect(existsSync(join(target, 'debug', 'deps', 'linked'))).toBe(false);
    expect(readFileSync(join(target, 'debug', 'deps', 'App-Keypair.json'), 'utf8')).toBe('[1]');
    expect(existsSync(join(target, 'debug', 'build', 'mounted', 'data'))).toBe(true);
    expect(existsSync(join(target, 'debug', '.cargo-lock'))).toBe(true);
    expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(false);
    expect(result.kept).toEqual([
      expect.stringMatching(
        /^debug: left .*App-Keypair\.json, .*mounted$|^debug: left .*mounted, .*App-Keypair\.json$/,
      ),
    ]);
  });

  test('the remover stops when a directory it is emptying becomes a link, and never deletes through it', async () => {
    makeProfile('debug', 3 * DAY);
    const deps = join(realpathSync.native(target), 'debug', 'deps');
    const outside = join(tmpdir(), `${realpathSync(target).split('/').at(-1)}-swapped`);
    mkdirSync(outside);
    onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'libx.rlib'), 'theirs');
    fsHooks.afterLstat = (path) => {
      if (path !== join(deps, 'libx.rlib')) return;
      delete fsHooks.afterLstat;
      renameSync(deps, `${deps}-aside`);
      symlinkSync(outside, deps);
    };

    const result = await trimCargoTarget(target, { needBytes: 0 });

    expect(readFileSync(join(outside, 'libx.rlib'), 'utf8')).toBe('theirs');
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining(`${deps} is no longer a directory inside`)]);
  });

  test('a link named like a keypair anywhere in the target keeps it whole, and what it points at stays', async () => {
    makeProfile('debug', 3 * DAY);
    const deps = join(target, 'debug', 'deps');
    writeFileSync(join(deps, 'wallet.json'), '[9]');
    symlinkSync('wallet.json', join(deps, 'App-Keypair.json'));
    const old = new Date(Date.now() - 3 * DAY);
    lutimesSync(join(deps, 'App-Keypair.json'), old, old);
    for (const path of [join(deps, 'wallet.json'), deps, join(target, 'debug')]) utimesSync(path, old, old);

    const result = await trimCargoTarget(target, { needBytes: 0 });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining('App-Keypair.json is a symbolic link')]);
    expect(readFileSync(join(deps, 'wallet.json'), 'utf8')).toBe('[9]');
  });

  test.each(['.stim-trimmed', '.stim-not-restored-1-0'])(
    'a leftover %s of an earlier trim keeps the target whole and says what to do',
    async (leftover) => {
      makeProfile('debug', 3 * DAY);
      mkdirSync(join(target, leftover, '0'), { recursive: true });

      const result = await trimCargoTarget(target, { needBytes: 0 });

      expect(result.removed).toEqual([]);
      expect(result.kept).toEqual([
        expect.stringContaining(`${leftover} is a leftover of an earlier Stim's trim; delete it`),
      ]);
      expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(true);
    },
  );

  test('a trim stopped at a deadline finishes the step in flight and leaves the rest', async () => {
    for (const name of ['debug', 'release', 'host-dev']) makeProfile(name, 3 * DAY);
    const deadline = new AbortController();
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) =>
        file === 'lsof' || file === 'ps' ? '' : real.runFileAsync(file, args, options),
      spawn: (...args: Parameters<typeof real.spawn>) => {
        deadline.abort();
        return real.spawn(...args);
      },
    });

    const result = await trimCargoTarget(target, {
      needBytes: 0,
      incremental: 'all',
      measure: false,
      stop: deadline.signal,
    });

    expect(result.removed).toHaveLength(1);
    expect(
      ['debug', 'release', 'host-dev'].filter((name) => existsSync(join(target, name, 'deps', 'libx.rlib'))),
    ).toHaveLength(2);
    expect(result.kept).toEqual(['the rest was left at the build headroom deadline']);
  });

  test.skipIf(process.platform !== 'darwin')(
    'a process path under a case variant of the target keeps its profile, and a stale profile with none goes',
    async () => {
      makeProfile('debug', 3 * DAY);
      makeProfile('release', 3 * DAY);
      const disk = realpathSync.native(target);
      stubProcesses({ lsof: () => `p100\nn${disk}/debug/deps/tool\n` });
      const variant = target.replace('stim-cargo-target-', 'STIM-CARGO-TARGET-');

      const result = await trimCargoTarget(variant, { needBytes: 0 });

      expect(result.removed).toEqual(['release']);
      expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(true);
    },
  );
});

function ageTree(path: string): void {
  const old = new Date(Date.now() - 3 * DAY);
  for (const entry of readdirSync(path, { withFileTypes: true }))
    if (entry.isDirectory()) ageTree(join(path, entry.name));
    else if (!entry.isSymbolicLink()) utimesSync(join(path, entry.name), old, old);
  utimesSync(path, old, old);
}

describe.skipIf(process.platform === 'win32')('deleting an idle Cargo target whole (skipped on win32)', () => {
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
  const remove = () => deleteCargoTarget(dir, { idleMs: DAY, mountInfo: null });

  test('everything goes in place but lock files and a deploy/ holding a Solana keypair, and nothing is left to plan again', async () => {
    mkdirSync(join(dir, 'criterion', 'base'), { recursive: true });
    writeFileSync(join(dir, 'criterion', 'base', 'summary.json'), '{}');
    mkdirSync(join(dir, 'deploy'));
    writeFileSync(join(dir, 'deploy', 'app-keypair.json'), '[1,2,3]');
    writeFileSync(join(dir, 'deploy', 'app.so'), 'program');
    ageTree(dir);

    const result = await remove();

    expect(result.removed.toSorted()).toEqual(['.rustc_info.json', 'criterion', 'debug', 'doc']);
    expect(result.kept).toEqual([]);
    expect(readdirSync(dir).toSorted()).toEqual(['debug', 'deploy']);
    expect(readdirSync(join(dir, 'debug'))).toEqual(['.cargo-lock']);
    expect(readdirSync(join(dir, 'deploy')).toSorted()).toEqual(['app-keypair.json', 'app.so']);
    expect(await removableEntries(dir)).toEqual([]);
  });

  test('a link named like a keypair deep in deploy/ keeps the whole target, and the key it points at stays', async () => {
    mkdirSync(join(dir, 'deploy', 'debug'), { recursive: true });
    writeFileSync(join(dir, 'deploy', 'debug', 'wallet.json'), '[1,2,3]');
    symlinkSync('wallet.json', join(dir, 'deploy', 'debug', 'app-keypair.json'));
    ageTree(dir);
    const old = new Date(Date.now() - 3 * DAY);
    lutimesSync(join(dir, 'deploy', 'debug', 'app-keypair.json'), old, old);

    const result = await remove();

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining('app-keypair.json is a symbolic link')]);
    expect(readFileSync(join(dir, 'deploy', 'debug', 'wallet.json'), 'utf8')).toBe('[1,2,3]');
    expect(existsSync(join(dir, 'debug', 'app'))).toBe(true);
  });

  test('a target with nothing left in it goes too', async () => {
    rmSync(join(dir, 'debug', '.cargo-lock'));
    ageTree(dir);

    await remove();

    expect(existsSync(dir)).toBe(false);
  });

  test('a symbolic link stays, and so does what it points at; a deploy that is a link keeps the whole target', async () => {
    const outside = join(target, 'outside.json');
    writeFileSync(outside, 'theirs');
    rmSync(join(dir, '.rustc_info.json'));
    symlinkSync(outside, join(dir, '.rustc_info.json'));
    const old = new Date(Date.now() - 3 * DAY);
    lutimesSync(join(dir, '.rustc_info.json'), old, old);
    utimesSync(dir, old, old);

    expect((await remove()).removed.toSorted()).toEqual(['debug', 'doc']);
    expect(readFileSync(outside, 'utf8')).toBe('theirs');

    mkdirSync(join(target, 'keys'));
    writeFileSync(join(dir, 'doc-again'), 'x');
    symlinkSync(join(target, 'keys'), join(dir, 'deploy'));
    ageTree(dir);
    lutimesSync(join(dir, 'deploy'), old, old);
    expect(targetEntries(dir)?.output).toEqual([]);
    expect((await remove()).removed).toEqual([]);
    expect(existsSync(join(dir, 'doc-again'))).toBe(true);
  });

  test.each([
    ['a leftover of an earlier trim', () => mkdirSync(join(dir, '.stim-not-restored-1-0')), 'is a leftover'],
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
      () => stubProcesses({ lsof: () => `p100\nn${real}/debug/app\n` }),
      'a process uses',
    ],
    [
      'another filesystem is mounted in it',
      () => (fsHooks.dev = (path) => (path.endsWith('/doc') ? -1 : undefined)),
      'another filesystem',
    ],
    ['it is no longer a Cargo target', () => rmSync(join(target, 'Cargo.toml')), 'no longer a Cargo target'],
    [
      'Criterion rewrites a saved baseline deep inside while its folders stay old',
      () => {
        mkdirSync(join(dir, 'criterion', 'bench', 'base'), { recursive: true });
        writeFileSync(join(dir, 'criterion', 'bench', 'base', 'sample.json'), '{}');
        ageTree(dir);
        utimesSync(join(dir, 'criterion', 'bench', 'base', 'sample.json'), new Date(), new Date());
      },
      'criterion holds a file written in that time',
    ],
  ])('it stays whole when %s', async (_, arrange, why) => {
    arrange();

    const result = await remove();

    expect(result.removed).toEqual([]);
    expect(result.kept).toContainEqual(expect.stringContaining(why));
    expect(existsSync(join(dir, 'debug', 'app'))).toBe(true);
    expect(existsSync(join(dir, 'doc', 'index.html'))).toBe(true);
  });

  test('a build that holds a profile lock keeps it whole', async () => {
    const held = await locked([join(dir, 'debug', '.cargo-lock')], remove);

    expect(held).toMatchObject({ value: { removed: [], kept: [expect.stringContaining('a build holds')] } });
    expect(existsSync(join(dir, 'debug', 'app'))).toBe(true);
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
    const result = await deleteCargoTarget(dir, { idleMs: DAY, mountInfo });

    expect(result.kept).toEqual([expect.stringContaining(why)]);
    expect(existsSync(join(dir, 'doc', 'index.html'))).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')("deleting an idle Exact app's target (skipped on win32)", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(target, 'target');
    writeFileSync(join(target, 'exact.mjs'), '');
    for (const path of ['.apple-cargo-locks/aarch64-apple-ios', 'bake/app', 'clients/app', 'debug/.fingerprint'])
      mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, '.rustc_info.json'), '{}');
    for (const file of [
      join(dir, '.apple-cargo-locks', 'aarch64-apple-ios', 'libapp.lock.flock'),
      join(dir, '.exact-sweep.json.lock'),
      join(dir, 'clients', 'app', 'client.js'),
    ])
      writeFileSync(file, '');
    writeFileSync(join(dir, '.exact-sweep.json'), JSON.stringify({ at: Date.now() - 3 * DAY, units: {} }));
    ageTree(dir);
    stubProcesses({});
  });
  afterEach(() => {
    if (existsSync(join(dir, 'bake'))) chmodSync(join(dir, 'bake'), 0o755);
  });
  const remove = () => deleteCargoTarget(dir, { idleMs: DAY, mountInfo: null });

  test("Exact's folders and records go, and its lock files stay", async () => {
    mkdirSync(join(dir, 'traces'));
    writeFileSync(join(dir, 'traces', 'trace-1.json'), '{"session":1}');
    writeFileSync(join(dir, 'clients', 'app', 'receipt.json'), '{"development":{"token":"abc"}}');
    ageTree(dir);

    const result = await remove();

    expect(result.kept).toEqual([]);
    expect(readdirSync(dir).toSorted()).toEqual(['.apple-cargo-locks', '.exact-sweep.json.lock']);
    expect(existsSync(join(dir, '.apple-cargo-locks', 'aarch64-apple-ios', 'libapp.lock.flock'))).toBe(true);
  });

  test('it stays whole while a build holds an Apple Cargo lock', async () => {
    const lock = join(realpathSync(dir), '.apple-cargo-locks', 'aarch64-apple-ios', 'libapp.lock.flock');
    stubProcesses({ lsof: (args) => (args.at(-1) === lock ? '4242\n' : '') });

    const result = await remove();

    expect(result.removed).toEqual([]);
    expect(result.kept).toContainEqual(expect.stringContaining('libapp.lock.flock'));
    expect(existsSync(join(dir, 'clients', 'app', 'client.js'))).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0)('it stays whole when an entry cannot be listed', async () => {
    chmodSync(join(dir, 'bake'), 0o000);

    const result = await remove();

    expect(result.kept).toContainEqual(expect.stringContaining('bake cannot be listed'));
    expect(existsSync(join(dir, 'clients', 'app', 'client.js'))).toBe(true);
  });
});
