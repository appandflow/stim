import {
  existsSync,
  linkSync,
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
  removablePaths,
  staleCargoPaths,
  staleCargoTargetPaths,
  trimCargoTarget,
} from '../workspace/cargo-target.ts';
import { cargoTargetDirsAsync } from '../workspace/regenerable-dirs.ts';

const fsHooks = vi.hoisted(
  (): {
    dev?: (path: string) => number | undefined;
    afterLstat?: (path: string) => void;
    beforeReaddir?: (path: string) => void;
    afterRecognise?: () => void;
  } => ({}),
);
vi.mock('../workspace/regenerable-dirs.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/regenerable-dirs.ts')>();
  return {
    ...real,
    cargoTargetDirsAsync: async (root: string) => {
      const found = await real.cargoTargetDirsAsync(root);
      fsHooks.afterRecognise?.();
      return found;
    },
  };
});
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
    readdir: new Proxy(fs.readdir, {
      apply: (readdir, self, args: unknown[]) => {
        fsHooks.beforeReaddir?.(String(args[0]));
        return Reflect.apply(readdir, self, args);
      },
    }),
  };
});
afterEach(() => {
  delete fsHooks.dev;
  delete fsHooks.afterLstat;
  delete fsHooks.beforeReaddir;
  delete fsHooks.afterRecognise;
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

  test('a build holding the 193rd of many lock files keeps everything and is named', async () => {
    const paths = Array.from({ length: 193 }, (_, index) => join(target, `lock-${index}`));
    for (const path of paths) writeFileSync(path, '');
    const busy = paths.at(-1) ?? '';
    let ran = false;

    const held = await locked([busy], () =>
      withCargoLocks(paths, async () => {
        ran = true;
      }),
    );

    expect(held).toEqual({ value: { kept: `a build holds ${busy}` } });
    expect(ran).toBe(false);
  });

  test('at normal the cap keeps a target whose .cargo-lock is a link, and the file behind it stays', async () => {
    makeProfile('debug', 3 * DAY);
    writeFileSync(join(target, 'debug', 'lock-file'), '');
    rmSync(join(target, 'debug', '.cargo-lock'));
    symlinkSync('lock-file', join(target, 'debug', '.cargo-lock'));
    const old = new Date(Date.now() - 3 * DAY);
    utimesSync(join(target, 'debug'), old, old);

    const result = await trimCargoTarget(target, { needBytes: 1, idleOnly: true });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining('.cargo-lock could not be locked')]);
    expect(existsSync(join(target, 'debug', 'lock-file'))).toBe(true);
  });

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

  test('a stale profile with no .cargo-lock does not count toward the need, so incremental data still goes', async () => {
    makeProfile('debug', 3 * DAY);
    rmSync(join(target, 'debug', '.cargo-lock'));
    writeFileSync(join(target, 'debug', 'deps', 'big'), 'x'.repeat(200_000));
    const old = new Date(Date.now() - 3 * DAY);
    for (const dir of ['deps', '.']) utimesSync(join(target, 'debug', dir), old, old);
    makeProfile('release', 0);
    writeFileSync(join(target, 'release', 'incremental', 'data'), 'x'.repeat(10_000));

    const result = await trimCargoTarget(target, { needBytes: 1 });

    expect(result.removed).toEqual(['release/incremental']);
    expect(result.kept).toEqual(['debug: debug has no .cargo-lock to take']);
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

  test('the remover unlinks a link without following it, and never unlinks a keypair or a lock file', async () => {
    makeProfile('debug', 3 * DAY);
    const outside = join(tmpdir(), `${realpathSync(target).split('/').at(-1)}-outside`);
    mkdirSync(outside);
    onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'theirs'), 'theirs');
    symlinkSync(outside, join(target, 'debug', 'deps', 'linked'));
    writeFileSync(join(target, 'debug', 'deps', 'App-Keypair.json'), '[1]');
    const old = new Date(Date.now() - 3 * DAY);
    for (const dir of ['deps', '.']) utimesSync(join(target, 'debug', dir), old, old);

    const result = await trimCargoTarget(target, { needBytes: 0 });

    expect(result.removed).toEqual(['debug']);
    expect(readFileSync(join(outside, 'theirs'), 'utf8')).toBe('theirs');
    expect(existsSync(join(target, 'debug', 'deps', 'linked'))).toBe(false);
    expect(readFileSync(join(target, 'debug', 'deps', 'App-Keypair.json'), 'utf8')).toBe('[1]');
    expect(existsSync(join(target, 'debug', '.cargo-lock'))).toBe(true);
    expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(false);
    expect(result.kept).toEqual([expect.stringMatching(/^debug: left .*App-Keypair\.json$/)]);
  });

  test('a directory a build removes while the trim lists it does not keep the target', async () => {
    makeProfile('debug', 3 * DAY);
    const incremental = join(realpathSync.native(target), 'debug', 'incremental');
    fsHooks.beforeReaddir = (path) => {
      if (path !== incremental) return;
      delete fsHooks.beforeReaddir;
      rmSync(incremental, { recursive: true });
    };

    const result = await trimCargoTarget(target, { needBytes: 0, measure: false });

    expect(result.removed).toEqual(['debug']);
  });

  test('a trim interrupted once the fingerprints are gone leaves a profile a later trim still removes', async () => {
    makeProfile('debug', 3 * DAY);
    const debug = join(realpathSync.native(target), 'debug');
    const abort = new AbortController();
    fsHooks.afterLstat = (path) => {
      if (
        ['deps', 'build', 'incremental'].some((part) => path === join(debug, part)) &&
        readdirSync(join(debug, '.fingerprint')).length === 0
      )
        abort.abort();
    };

    await expect(trimCargoTarget(target, { needBytes: 0, signal: abort.signal })).rejects.toThrow('aborted');
    delete fsHooks.afterLstat;

    expect(readdirSync(join(target, 'debug', '.fingerprint'))).toEqual([]);
    expect(existsSync(join(target, 'debug', 'deps', 'libx.rlib'))).toBe(true);
    const later = await trimCargoTarget(target, { needBytes: 0, now: Date.now() + 2 * DAY });
    expect(later.removed).toEqual(['debug']);
    expect(readdirSync(join(target, 'debug'))).toEqual(['.cargo-lock']);
  });

  test('a target replaced before the locked step stays, and the profile of its replacement stays', async () => {
    makeProfile('debug', 3 * DAY);
    const lock = join(realpathSync.native(target), 'debug', '.cargo-lock');
    onTestFinished(() => rmSync(`${target}-moved`, { recursive: true, force: true }));
    fsHooks.afterLstat = (path) => {
      if (path !== lock) return;
      delete fsHooks.afterLstat;
      renameSync(target, `${target}-moved`);
      mkdirSync(join(target, 'debug', 'deps'), { recursive: true });
      writeFileSync(join(target, 'debug', 'deps', 'theirs'), 'theirs');
    };

    const result = await trimCargoTarget(target, { needBytes: 0 });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining('is no longer the directory Stim checked')]);
    expect(readFileSync(join(target, 'debug', 'deps', 'theirs'), 'utf8')).toBe('theirs');
  });

  test('a trim stopped at a deadline finishes the step in flight and leaves the rest', async () => {
    for (const name of ['debug', 'release', 'host-dev']) makeProfile(name, 3 * DAY);
    const deadline = new AbortController();
    fsHooks.afterLstat = (path) => {
      if (path.endsWith(join('deps', 'libx.rlib'))) deadline.abort();
    };

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
  const remove = () => deleteCargoTarget(dir, { idleMs: DAY });

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
    expect(await removablePaths(dir)).toEqual({ paths: [] });
  });

  test("Cargo's CACHEDIR.TAG stays, so a tagged target with no Cargo.toml is still recognised after the delete", async () => {
    writeFileSync(join(dir, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    rmSync(join(target, 'Cargo.toml'));
    ageTree(dir);

    const result = await remove();

    expect(result.removed.toSorted()).toEqual(['.rustc_info.json', 'debug', 'doc']);
    expect(await cargoTargetDirsAsync(target)).toEqual([dir]);
    expect(await deleteCargoTarget(dir, {})).toEqual({ bytes: 0, removed: [], kept: [] });
  });

  test('a target replaced by a link once recognised stays, and nothing behind the link goes', async () => {
    const elsewhere = join(target, 'elsewhere');
    mkdirSync(join(elsewhere, 'doc'), { recursive: true });
    writeFileSync(join(elsewhere, 'doc', 'index.html'), 'theirs');
    ageTree(elsewhere);
    fsHooks.afterRecognise = () => {
      delete fsHooks.afterRecognise;
      renameSync(dir, `${dir}-moved`);
      symlinkSync(elsewhere, dir);
    };

    const result = await remove();

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining('is no longer a directory')]);
    expect(readFileSync(join(elsewhere, 'doc', 'index.html'), 'utf8')).toBe('theirs');
  });

  test('a target replaced by another real directory under the same path stays, and what that one holds stays', async () => {
    rmSync(join(dir, 'debug', '.cargo-lock'));
    ageTree(dir);
    stubProcesses({
      lsof: () => {
        if (!existsSync(`${dir}-moved`)) {
          renameSync(dir, `${dir}-moved`);
          mkdirSync(join(dir, 'doc'), { recursive: true });
          writeFileSync(join(dir, 'doc', 'index.html'), 'theirs');
        }
        return '';
      },
    });

    const result = await remove();

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining('is no longer the directory')]);
    expect(readFileSync(join(dir, 'doc', 'index.html'), 'utf8')).toBe('theirs');
  });

  test('a binary hard-linked into deps is counted once in the bytes freed', async () => {
    const binary = join(dir, 'debug', 'app');
    writeFileSync(binary, Buffer.alloc(1024 * 1024, 1));
    linkSync(binary, join(dir, 'debug', 'deps', 'app-0123456789abcdef'));
    ageTree(dir);

    const result = await remove();

    expect(result.removed.toSorted()).toEqual(['.rustc_info.json', 'debug', 'doc']);
    expect(result.bytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(result.bytes).toBeLessThan(1.5 * 1024 * 1024);
  });

  test('a target with nothing left in it goes too', async () => {
    rmSync(join(dir, 'debug', '.cargo-lock'));
    ageTree(dir);

    await remove();

    expect(existsSync(dir)).toBe(false);
  });

  test('a symbolic link stays, and so does what it points at', async () => {
    const outside = join(target, 'outside.json');
    writeFileSync(outside, 'theirs');
    rmSync(join(dir, '.rustc_info.json'));
    symlinkSync(outside, join(dir, '.rustc_info.json'));
    const old = new Date(Date.now() - 3 * DAY);
    lutimesSync(join(dir, '.rustc_info.json'), old, old);
    utimesSync(dir, old, old);

    expect((await remove()).removed.toSorted()).toEqual(['debug', 'doc']);
    expect(readFileSync(outside, 'utf8')).toBe('theirs');
  });

  test.each([
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
    ['it is no longer a Cargo target', () => rmSync(join(target, 'Cargo.toml')), 'no longer a Cargo target'],
  ])('it stays whole when %s', async (_, arrange, why) => {
    arrange();

    const result = await remove();

    expect(result.removed).toEqual([]);
    expect(result.kept).toContainEqual(expect.stringContaining(why));
    expect(existsSync(join(dir, 'debug', 'app'))).toBe(true);
    expect(existsSync(join(dir, 'doc', 'index.html'))).toBe(true);
  });

  test("an earlier engine's staged trim stays, receipts in it included, while the rest goes", async () => {
    mkdirSync(join(dir, '.stim-trimmed', '4'), { recursive: true });
    writeFileSync(join(dir, '.stim-trimmed', '4', 'r.json'), '{}');
    ageTree(dir);

    const result = await remove();

    expect(result.removed).toContain('debug');
    expect(readFileSync(join(dir, '.stim-trimmed', '4', 'r.json'), 'utf8')).toBe('{}');
    expect(existsSync(join(dir, 'debug', 'app'))).toBe(false);
  });

  test('a directory on another device is not entered, and the delete reports it left', async () => {
    fsHooks.dev = (path) => (path.endsWith('/doc') ? -1 : undefined);

    const result = await remove();

    expect(result.kept).toContainEqual(expect.stringMatching(/^left .*\/doc$/));
    expect(existsSync(join(dir, 'doc', 'index.html'))).toBe(true);
    expect(existsSync(join(dir, 'debug', 'app'))).toBe(false);
  });

  test('a .cargo-lock that is a link keeps it whole, and the file behind it stays', async () => {
    writeFileSync(join(dir, 'debug', 'lock-file'), '');
    rmSync(join(dir, 'debug', '.cargo-lock'));
    symlinkSync('lock-file', join(dir, 'debug', '.cargo-lock'));
    ageTree(dir);
    const old = new Date(Date.now() - 3 * DAY);
    lutimesSync(join(dir, 'debug', '.cargo-lock'), old, old);

    const result = await remove();

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining('.cargo-lock could not be locked')]);
    expect(existsSync(join(dir, 'debug', 'lock-file'))).toBe(true);
  });

  test('a build that holds a profile lock keeps it whole', async () => {
    const held = await locked([join(dir, 'debug', '.cargo-lock')], remove);

    expect(held).toMatchObject({ value: { removed: [], kept: [expect.stringContaining('a build holds')] } });
    expect(existsSync(join(dir, 'debug', 'app'))).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')(
  "handing an idle Exact app's target to Exact's cleaner (skipped on win32)",
  () => {
    let dir: string;
    let checkout: string;
    let calls: string[][];
    let report: (args: string[]) => { stdout: string; status: number };
    beforeEach(() => {
      dir = join(target, 'target');
      writeFileSync(join(target, 'exact.mjs'), 'ensureBun("1.4.2");\n');
      for (const path of ['bake/app/development', 'traces', 'debug/.fingerprint'])
        mkdirSync(join(dir, path), { recursive: true });
      writeFileSync(join(dir, 'bake', 'app', 'development', 'app.bin'), 'x'.repeat(5000));
      writeFileSync(join(dir, 'traces', 'trace-1.json'), '{}');
      ageTree(dir);
      checkout = join(target, 'exact2');
      mkdirSync(checkout);
      writeFileSync(join(checkout, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.3' }));
      calls = [];
      const real = realpathSync(dir);
      report = (args) => {
        const dryRun = args.includes('--dry-run');
        return {
          status: 0,
          stdout: JSON.stringify({
            version: 1,
            status: 'ok',
            dryRun,
            target: real,
            remove: [join(real, 'bake', 'app', 'development'), join(real, 'debug')],
            kept: [{ path: join(real, 'traces'), why: 'record' }],
            held: [],
          }),
        };
      };
      const executor = getExecutor();
      setExecutor({
        ...executor,
        runFileQuietAsync: async (file, args, options) =>
          processTable(file, args) ?? executor.runFileQuietAsync(file, args, options),
        runFileAsync: async (file, args, options) => {
          if (file === 'lsof' || file === 'ps') return '';
          if (!file.endsWith('/bin/bun')) return executor.runFileAsync(file, args, options);
          calls.push([file, ...args]);
          if (args[1] === 'help') return `verbs\n\nExact checkout: ${checkout} at 064bf18d3`;
          if (!args.includes('--dry-run')) {
            const planned = report(args);
            if (planned.status === 0)
              for (const path of JSON.parse(planned.stdout).remove) rmSync(path, { recursive: true, force: true });
          }
          const { stdout, status } = report(args);
          if (status !== 0) throw Object.assign(new Error('Command failed'), { status, stdout });
          return stdout;
        },
      });
    });
    let devServerIn: string | null = null;
    afterEach(() => {
      devServerIn = null;
    });
    /** A process table that lists this test and, when `devServerIn` is set, a dev server working in that folder. */
    const processTable = (file: string, args: string[]): string | null => {
      const other = devServerIn === null ? [] : [4242];
      if (file === 'ps' && args.includes('pid=,args='))
        return [`${process.pid} node test`, ...other.map((pid) => `${pid} bun ${devServerIn}/exact.mjs dev`)].join(
          '\n',
        );
      if (file === 'ps' && args.includes('pid=,ppid='))
        return [process.pid, ...other].map((pid) => `${pid} 1`).join('\n');
      return null;
    };
    const remove = () => deleteCargoTarget(dir, { idleMs: DAY });

    test("a dry run then the clean run with the Bun each pin names, and Exact's records stay", async () => {
      const result = await remove();

      const real = realpathSync(target);
      expect(calls).toEqual([
        [expect.stringMatching(/\.bun-1\.4\.2\/bin\/bun$/), join(real, 'exact.mjs'), 'help'],
        [
          expect.stringMatching(/\.bun-1\.4\.3\/bin\/bun$/),
          join(checkout, 'scripts', 'sweep.mjs'),
          'clean',
          real,
          '--dry-run',
          '--json',
        ],
        [expect.stringMatching(/\.bun-1\.4\.2\/bin\/bun$/), join(real, 'exact.mjs'), 'help'],
        [
          expect.stringMatching(/\.bun-1\.4\.3\/bin\/bun$/),
          join(checkout, 'scripts', 'sweep.mjs'),
          'clean',
          real,
          '--json',
        ],
      ]);
      expect(result.removed).toEqual(['bake/app/development', 'debug']);
      expect(result.bytes).toBeGreaterThan(0);
      expect(existsSync(join(dir, 'traces', 'trace-1.json'))).toBe(true);
      expect(await removablePaths(dir)).toMatchObject({ paths: expect.any(Array) });
    });

    test.each([
      [
        'Exact reports a lock held',
        () =>
          (report = () => ({
            status: 1,
            stdout: JSON.stringify({
              version: 1,
              status: 'busy',
              dryRun: true,
              target: dir,
              remove: [],
              kept: [],
              held: ['/t/debug/.cargo-lock'],
            }),
          })),
        'Exact reports it in use: /t/debug/.cargo-lock',
      ],
      [
        'an older checkout treats clean as a target path and prints no JSON',
        () => (report = () => ({ status: 1, stdout: '' })),
        "Exact's cleaner cannot run",
      ],
      [
        'a report of another version',
        () =>
          (report = () => ({
            status: 0,
            stdout: JSON.stringify({ version: 2, status: 'ok', remove: [], kept: [], held: [] }),
          })),
        "Exact's cleaner cannot run",
      ],
      ['the checkout pins no Bun', () => writeFileSync(join(checkout, 'package.json'), '{}'), 'pins no Bun version'],
    ])('it stays whole when %s', async (_, arrange, why) => {
      arrange();

      const result = await remove();

      expect(result.removed).toEqual([]);
      expect(result.kept).toEqual([expect.stringContaining(why)]);
      expect(existsSync(join(dir, 'bake', 'app', 'development', 'app.bin'))).toBe(true);
    });

    test('a clean that ends without a report fails with an unknown outcome instead of keeping the target', async () => {
      report = (args) =>
        args.includes('--dry-run')
          ? {
              status: 0,
              stdout: JSON.stringify({
                version: 1,
                status: 'ok',
                remove: [join(realpathSync(dir), 'debug')],
                kept: [],
                held: [],
              }),
            }
          : { status: 137, stdout: '' };

      await expect(remove()).rejects.toThrow('what it removed is not known');
    });

    test.each([
      ['help', (args: string[]) => args[1] === 'help'],
      ['the dry run', (args: string[]) => args.includes('--dry-run')],
    ])('a cleanup refusal from the executor during %s is reported, not turned into a keep', async (_, when) => {
      const executor = getExecutor();
      setExecutor({
        ...executor,
        runFileAsync: async (file, args, options) => {
          if (file.endsWith('/bin/bun') && when(args))
            throw Object.assign(new Error('refused'), { reportCleanup: true });
          return executor.runFileAsync(file, args, options);
        },
      });

      await expect(remove()).rejects.toThrow('refused');
    });

    test('a target Exact kept is not asked about again within a day', async () => {
      report = () => ({
        status: 1,
        stdout: JSON.stringify({ version: 1, status: 'busy', remove: [], kept: [], held: ['/t/debug/.cargo-lock'] }),
      });
      await remove();
      const asked = calls.length;

      const result = await remove();

      expect(calls).toHaveLength(asked);
      expect(result.kept).toEqual([expect.stringContaining('Stim asks again after a day')]);
    });

    test("an earlier Stim's staged trim keeps the target, and Exact is never asked", async () => {
      mkdirSync(join(dir, '.stim-trimmed', '3', '.fingerprint'), { recursive: true });
      mkdirSync(join(dir, '.stim-trimmed', '4'), { recursive: true });
      writeFileSync(join(dir, '.stim-trimmed', '4', 'r.json'), '{}');
      ageTree(dir);

      const result = await remove();

      expect(result.kept).toEqual([expect.stringContaining('.stim-trimmed from an earlier Stim')]);
      expect(calls).toEqual([]);
      expect(readFileSync(join(dir, '.stim-trimmed', '4', 'r.json'), 'utf8')).toBe('{}');
      expect(existsSync(join(dir, 'debug'))).toBe(true);
    });

    test('a process working in the app keeps it, and Exact is never asked', async () => {
      devServerIn = realpathSync(target);

      const result = await remove();

      expect(result.kept).toEqual([expect.stringContaining('its app may be in use: process 4242')]);
      expect(calls).toEqual([]);
    });
  },
);

describe.skipIf(process.platform === 'win32')('Exact files in a target no Exact app owns (skipped on win32)', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(target, 'target');
    for (const path of ['.apple-cargo-locks/aarch64-apple-ios', 'debug/.fingerprint'])
      mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    writeFileSync(join(dir, 'debug', '.cargo-lock'), '');
    writeFileSync(join(dir, 'debug', 'app'), 'binary');
    writeFileSync(join(dir, '.apple-cargo-locks', 'aarch64-apple-ios', 'libapp.lock.flock'), '');
    ageTree(dir);
    stubProcesses({});
  });
  const remove = () => deleteCargoTarget(dir, { idleMs: DAY });

  test("the remover leaves Exact's lock files and .apple-cargo-locks", async () => {
    const result = await remove();

    expect(existsSync(join(dir, 'debug', 'app'))).toBe(false);
    expect(result.removed).toContain('debug');
    expect(existsSync(join(dir, '.apple-cargo-locks', 'aarch64-apple-ios', 'libapp.lock.flock'))).toBe(true);
  });

  test("a target holding Exact's sweep lock and a receipt with no Exact app beside it stays whole", async () => {
    writeFileSync(join(dir, '.exact-sweep.json.lock'), '');
    mkdirSync(join(dir, 'web-receipts'));
    writeFileSync(join(dir, 'web-receipts', 'r.json'), '{}');
    ageTree(dir);

    const result = await remove();

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining('.exact-sweep.json.lock but no Exact app beside it')]);
    expect(existsSync(join(dir, 'web-receipts', 'r.json'))).toBe(true);
    expect(existsSync(join(dir, 'debug', 'app'))).toBe(true);
  });

  test("a target holding Exact's ledger with no Exact app beside it stays whole", async () => {
    writeFileSync(join(dir, '.exact-sweep.json'), JSON.stringify({ at: Date.now() - 3 * DAY, units: {} }));
    mkdirSync(join(dir, 'web-receipts'));
    writeFileSync(join(dir, 'web-receipts', 'r.json'), '{}');
    ageTree(dir);

    const result = await remove();

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([expect.stringContaining('.exact-sweep.json but no Exact app beside it')]);
    expect(existsSync(join(dir, 'web-receipts', 'r.json'))).toBe(true);
  });
});
