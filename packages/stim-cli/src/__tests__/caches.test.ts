import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { cacheUser } from '../cache/cache-claim.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, setExecutor, resetExecutor } from '../exec.ts';
import { discoverCaches, pruneCache } from '../cache/caches.ts';
import { emptyCaches, trimCaches } from '../commands/gc/caches.ts';
import { register } from '../cache/cache-manifest.ts';
import { makeCacheDescriptor } from './_factories.ts';
import assert from 'node:assert';

const cacheIo = vi.hoisted(
  (): {
    beforeRead?: (path: unknown) => Promise<void>;
    beforeRemove?: (path: unknown) => Promise<void>;
  } => ({}),
);
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      await cacheIo.beforeRead?.(args[0]);
      return fs.readdir(...args);
    },
    rm: async (...args: Parameters<typeof fs.rm>) => {
      await cacheIo.beforeRemove?.(args[0]);
      return fs.rm(...args);
    },
  };
});

const LONG_AGO = new Date(Date.now() - 90 * 24 * 3600 * 1000);

function age(path: string, when = LONG_AGO) {
  utimesSync(path, when, when);
}

let tmpHome: string;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-home-'));
  process.env.STIM_HOME = tmpHome;
});
afterEach(() => {
  resetExecutor();
  cacheIo.beforeRead = undefined;
  cacheIo.beforeRemove = undefined;
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test.each(['trimming', 'emptying'] as const)(
  'cache %s yields during directory measurement and cancellation preserves the entry',
  async (action) => {
    const dir = join(tmpHome, 'slow-cache');
    const entry = join(dir, 'entry');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'artifact'), 'cached bytes');
    age(entry);
    const abort = new AbortController();
    let measuring!: () => void;
    const measurement = new Promise<void>((resolve) => {
      measuring = resolve;
    });
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) => {
        if (file !== 'du' || !args?.includes(entry)) return real.runFileAsync(file, args, options);
        measuring();
        return new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      },
    });
    const output = {
      log: () => {},
      error: () => {},
      record: () => {},
      fail: () => {},
    };
    const cache = makeCacheDescriptor({ dir, prune: 'entries' });
    const trimming =
      action === 'trimming'
        ? trimCaches([cache], 30, output, abort.signal)
        : emptyCaches([{ ...cache, willEmpty: true }], output, abort.signal);
    const outcome = trimming.catch((error: unknown) => error);
    expect(await Promise.race([measurement.then(() => 'measuring'), trimming.then(() => 'finished')])).toBe(
      'measuring',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(existsSync(entry)).toBe(true);
    abort.abort(new Error('cancel cache trimming'));
    expect(await outcome).toMatchObject({ message: 'cancel cache trimming' });
    expect(existsSync(join(entry, 'artifact'))).toBe(true);
  },
);

test('a registration cannot make the shared Gradle build cache deletable', () => {
  const gradleHome = mkdtempSync(join(tmpdir(), 'stim-gradle-registered-'));
  const previous = process.env.GRADLE_USER_HOME;
  const buildCache = join(gradleHome, 'caches', 'build-cache-1');
  const alias = join(gradleHome, 'build-cache-alias');
  const entry = join(buildCache, 'entry');
  mkdirSync(buildCache, { recursive: true });
  symlinkSync(buildCache, alias, 'dir');
  writeFileSync(entry, 'x');
  age(entry);
  try {
    process.env.GRADLE_USER_HOME = gradleHome;
    register({ dir: alias, name: 'Registered Gradle cache', prune: 'entries' });
    register({ dir: buildCache, name: 'Duplicate real Gradle cache', prune: 'atomic' });
    const caches = discoverCaches();
    const found = caches.find((c) => realpathSync(c.dir) === realpathSync(buildCache));
    assert(found);
    expect(found.prune).toBe('report-only');
    expect(pruneCache(found, { olderThanDays: 30 }).skipped).toMatch(/report-only/);
    expect(existsSync(entry)).toBe(true);
    expect(caches.filter((c) => realpathSync(c.dir) === realpathSync(buildCache))).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.GRADLE_USER_HOME;
    else process.env.GRADLE_USER_HOME = previous;
    rmSync(gradleHome, { recursive: true, force: true });
  }
});

test('pruneCache trims only the listed files when a cache does not own its directory', () => {
  const mine = join(tmpdir(), `metro-file-map-stim-prunetest-${process.pid}`);
  const notMine = join(tmpdir(), `stim-bystander-${process.pid}`);
  writeFileSync(mine, 'x');
  writeFileSync(notMine, 'y');
  const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  utimesSync(mine, longAgo, longAgo);
  utimesSync(notMine, longAgo, longAgo);
  try {
    const r = pruneCache(makeCacheDescriptor({ dir: tmpdir(), files: [mine], prune: 'entries' }), {
      olderThanDays: 30,
    });
    expect(r.removed).toBe(1);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(notMine)).toBe(true);
  } finally {
    rmSync(mine, { force: true });
    rmSync(notMine, { force: true });
  }
});

test.each(['read', 'remove'] as const)(
  'atomic cache cancellation holds its claim during a pending %s',
  async (phase) => {
    const dir = join(tmpHome, 'atomic-cache');
    mkdirSync(dir);
    writeFileSync(join(dir, 'first'), 'cached bytes');
    writeFileSync(join(dir, 'second'), 'cached bytes');
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let start!: () => void;
    const ready = new Promise<void>((resolve) => {
      start = resolve;
    });
    let removed: string | undefined;
    if (phase === 'read')
      cacheIo.beforeRead = async (path) => {
        if (path === dir) {
          start();
          await gate;
        }
      };
    else
      cacheIo.beforeRemove = async (path) => {
        if (String(path).startsWith(dir) && !removed) {
          removed = String(path);
          start();
          await gate;
        }
      };
    const output = { log: () => {}, error: () => {}, record: () => {}, fail: () => {} };
    const pending = Promise.resolve(
      emptyCaches([{ ...makeCacheDescriptor({ dir, prune: 'atomic' }), willEmpty: true }], output, controller.signal),
    );
    const outcome = pending.catch((error: unknown) => error);
    try {
      expect(await Promise.race([ready.then(() => 'pending'), pending.then(() => 'finished')])).toBe('pending');
      controller.abort(new Error('cancel atomic emptying'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cacheUser(dir)).toContain('emptying');
      expect(existsSync(join(dir, 'first'))).toBe(true);
      expect(existsSync(join(dir, 'second'))).toBe(true);
      release();
      expect(await outcome).toBe(controller.signal.reason);
      expect(cacheUser(dir)).toBeUndefined();
      expect(existsSync(join(dir, 'first'))).toBe(removed !== join(dir, 'first'));
      expect(existsSync(join(dir, 'second'))).toBe(removed !== join(dir, 'second'));
    } finally {
      release();
      await outcome;
      cacheIo.beforeRead = undefined;
      cacheIo.beforeRemove = undefined;
    }
  },
);

test('pruneCache skips a cache whose directory is the home directory, however old its entries are', () => {
  const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'stim-prune-home-')));
  for (const key of ['HOME', 'USERPROFILE']) vi.stubEnv(key, fakeHome);
  const documents = join(fakeHome, 'Documents');
  mkdirSync(documents);
  age(documents);
  try {
    const r = pruneCache(makeCacheDescriptor({ dir: fakeHome, prune: 'entries' }), { olderThanDays: 30 });
    expect(r.skipped).toMatch(/not a directory this cache owns/);
    expect(r.removed).toBe(0);
    expect(existsSync(documents)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('a registered ancestor cannot delete its protected Gradle build-cache child', () => {
  const gradleHome = mkdtempSync(join(tmpdir(), 'stim-gradle-parent-'));
  const previous = process.env.GRADLE_USER_HOME;
  const cachesRoot = join(gradleHome, 'caches');
  const buildCache = join(cachesRoot, 'build-cache-1');
  const entry = join(buildCache, 'entry');
  mkdirSync(buildCache, { recursive: true });
  writeFileSync(entry, 'x');
  age(entry);
  try {
    process.env.GRADLE_USER_HOME = gradleHome;
    register({ dir: cachesRoot, name: 'Gradle caches root', prune: 'entries' });
    const caches = discoverCaches();
    const found = caches.find((c) => realpathSync(c.dir) === realpathSync(cachesRoot));
    assert(found);
    expect(found.prune).toBe('report-only');
    expect(pruneCache(found, { olderThanDays: 30 }).skipped).toMatch(/report-only/);
    expect(existsSync(entry)).toBe(true);
    expect(caches.some((c) => realpathSync(c.dir) === realpathSync(buildCache))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.GRADLE_USER_HOME;
    else process.env.GRADLE_USER_HOME = previous;
    rmSync(gradleHome, { recursive: true, force: true });
  }
});
