import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { daemonNdjsonFile } from '@stim-cli/core/state';
import { cacheUser } from '../cache/cache-claim.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, setExecutor, resetExecutor } from '../exec.ts';
import { discoverCaches, jestCacheDir, pruneCache, sizeCaches } from '../cache/caches.ts';
import { emptyCaches } from '../commands/gc/caches.ts';
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

test('cache emptying yields during directory measurement and cancellation preserves the entry', async () => {
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
  const trimming = emptyCaches([{ ...cache, willEmpty: true }], output, abort.signal);
  const outcome = trimming.catch((error: unknown) => error);
  expect(await Promise.race([measurement.then(() => 'measuring'), trimming.then(() => 'finished')])).toBe('measuring');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(existsSync(entry)).toBe(true);
  abort.abort(new Error('cancel cache trimming'));
  expect(await outcome).toMatchObject({ message: 'cancel cache trimming' });
  expect(existsSync(join(entry, 'artifact'))).toBe(true);
});

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
    register({
      dir: buildCache,
      name: 'Duplicate real Gradle cache',
      prune: 'atomic',
    });
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

test('pruneCache writes one size_failed record for a cache whose entries all fail to size', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-prune-size-'));
  vi.stubEnv('STIM_HOME', home);
  const dir = join(home, 'cache');
  const longAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  for (const name of ['a', 'b', 'c']) {
    mkdirSync(join(dir, name), { recursive: true });
    utimesSync(join(dir, name), longAgo, longAgo);
  }
  setExecutor({
    ...getExecutor(),
    runFile: () => {
      throw Object.assign(new Error('du: denied'), { status: 1 });
    },
  });
  try {
    expect(pruneCache(makeCacheDescriptor({ dir, prune: 'entries' }), { olderThanDays: 30 }).removed).toBe(3);
    const records = readFileSync(daemonNdjsonFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line): { event?: unknown } => JSON.parse(line))
      .filter((record) => record.event === 'size_failed');
    expect(records).toEqual([expect.objectContaining({ root: dir, reason: 'exit', status: 1 })]);
  } finally {
    resetExecutor();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
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

function jestDir() {
  const dir = jestCacheDir();
  assert(dir);
  return dir;
}

const windows = process.platform === 'win32';

function processTable(table: string | null) {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileQuiet: (file, args, options) => (file === 'ps' ? table : real.runFileQuiet(file, args, options)),
  });
}

describe.skipIf(windows)("Jest's default cache", () => {
  test.each([
    ['no Jest process runs', '10 1 node /usr/lib/node_modules/vitest/vitest.mjs run\n', null],
    [
      'Expo runs Metro workers',
      '10 1 node /w/node_modules/expo/bin/cli start --port 8081\n11 10 node /w/node_modules/.pnpm/jest-worker@29.7.0/node_modules/jest-worker/build/workers/processChild.js\n',
      null,
    ],
    [
      'the React Native CLI runs Metro workers',
      '10 1 node /w/node_modules/react-native/cli.js start\n11 10 node /w/node_modules/.pnpm/jest-worker@29.7.0/node_modules/jest-worker/build/workers/processChild.js\n',
      null,
    ],
    [
      'Metro runs its workers',
      '10 1 node /w/node_modules/metro/src/cli.js serve\n11 10 node /w/node_modules/.pnpm/jest-worker@29.7.0/node_modules/jest-worker/build/workers/processChild.js\n',
      null,
    ],
    ['a Jest bin runs', '10 1 node /w/node_modules/.bin/jest --watch\n', 'a Jest process is running'],
    [
      'a Jest runner runs with its workers',
      '10 1 node /w/node_modules/jest/bin/jest.js\n11 10 node /w/node_modules/.pnpm/jest-worker@29.7.0/node_modules/jest-worker/build/workers/processChild.js\n',
      'a Jest process is running',
    ],
    [
      'a wrapper runs Jest with its workers',
      '10 1 node /w/node_modules/react-scripts/scripts/test.js --watch\n11 10 node /w/node_modules/.pnpm/jest-worker@29.7.0/node_modules/jest-worker/build/workers/processChild.js\n',
      'a Jest process is running',
    ],
    [
      'a Jest worker has no listed parent',
      '11 10 node /w/node_modules/.pnpm/jest-worker@29.7.0/node_modules/jest-worker/build/workers/processChild.js\n',
      'a Jest process is running',
    ],
    [
      'the process list cannot be read',
      null,
      'the process list could not be read, so a running Jest cannot be ruled out',
    ],
  ] as const)("the age sweep of Jest's default cache when %s", (_label, table, kept) => {
    processTable(table);
    const dir = jestDir();
    const recent = new Date();
    const entry = (name: string, kind: 'file' | 'dir', atime = LONG_AGO, mtime = LONG_AGO) => {
      const path = join(dir, name);
      if (kind === 'dir') {
        mkdirSync(join(path, '0a'), { recursive: true });
        writeFileSync(join(path, '0a', 'index_0a1b'), 'transformed');
      } else writeFileSync(path, 'x');
      utimesSync(path, atime, mtime);
      return path;
    };
    const written = 'a'.repeat(32);
    const reading = 'b'.repeat(32);
    const unused = 'c'.repeat(32);
    mkdirSync(dir, { recursive: true });
    try {
      const writtenTransforms = entry(`jest-transform-cache-${written}-1`, 'dir');
      entry(`perf-cache-${written}-2`, 'file', recent, recent);
      const readingTransforms = entry(`jest-transform-cache-${reading}-1`, 'dir');
      entry(`haste-map-${reading}-root-3`, 'file', recent, LONG_AGO);
      const unusedTransforms = entry(`jest-transform-cache-${unused}-1`, 'dir', recent, LONG_AGO);
      const unusedMap = entry(`haste-map-${unused}-root-3`, 'file');
      const unknown = entry('notes', 'dir');
      const unparsedId = entry('jest-transform-cache--acme-app-1', 'dir');

      const cache = discoverCaches().find((c) => c.name === 'Jest cache');
      assert(cache);
      const r = pruneCache(cache, { olderThanDays: 3, byMtime: true });

      expect(r.skipped).toBe(kept);
      expect(r.removed).toBe(kept ? 0 : 2);
      expect(existsSync(unusedTransforms)).toBe(Boolean(kept));
      expect(existsSync(unusedMap)).toBe(Boolean(kept));
      expect(existsSync(writtenTransforms)).toBe(true);
      expect(existsSync(readingTransforms)).toBe(true);
      expect(existsSync(unknown)).toBe(true);
      expect(existsSync(unparsedId)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.skipIf(windows)('a Jest config used while its transform cache is being sized keeps it', () => {
  const dir = jestDir();
  const id = 'e'.repeat(32);
  const transforms = join(dir, `jest-transform-cache-${id}-1`);
  const sibling = join(dir, `jest-transform-cache-${id}-2`);
  mkdirSync(join(transforms, '0a'), { recursive: true });
  mkdirSync(sibling);
  age(transforms);
  age(sibling);
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileQuiet: (file, args, options) => (file === 'ps' ? '' : real.runFileQuiet(file, args, options)),
    runFile: (file, args, options) => {
      const sized = [transforms, sibling].find((path) => args?.includes(path));
      if (file === 'du' && sized) {
        const now = new Date();
        utimesSync(sized === transforms ? sibling : transforms, now, now);
        return '4\t' + sized;
      }
      return real.runFile(file, args, options);
    },
  });
  try {
    const cache = discoverCaches().find((c) => c.name === 'Jest cache');
    assert(cache);
    expect(pruneCache(cache, { olderThanDays: 3, byMtime: true }).removed).toBe(0);
    expect(existsSync(transforms)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(windows)('a Jest process that starts while an entry is being sized stops the pass', () => {
  const dir = jestDir();
  const first = join(dir, `jest-transform-cache-${'1'.repeat(32)}-1`);
  const second = join(dir, `jest-transform-cache-${'2'.repeat(32)}-1`);
  for (const path of [first, second]) {
    mkdirSync(path, { recursive: true });
    age(path);
  }
  let started = false;
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileQuiet: (file, args, options) =>
      file === 'ps' ? (started ? '10 1 node /w/node_modules/.bin/jest\n' : '') : real.runFileQuiet(file, args, options),
    runFile: (file, args, options) => {
      if (file === 'du') {
        started = true;
        return '4\t' + String(args?.at(-1));
      }
      return real.runFile(file, args, options);
    },
  });
  try {
    const cache = discoverCaches().find((c) => c.name === 'Jest cache');
    assert(cache);
    const r = pruneCache(cache, { olderThanDays: 3, byMtime: true });
    expect(r.removed).toBe(0);
    expect(r.skipped).toBe('a Jest process is running');
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(windows)('a Jest config that writes a new entry while its transform cache is being sized keeps it', () => {
  const dir = jestDir();
  const id = 'f'.repeat(32);
  const transforms = join(dir, `jest-transform-cache-${id}-1`);
  const fresh = join(dir, `haste-map-${id}-root-4`);
  mkdirSync(join(transforms, '0a'), { recursive: true });
  age(transforms);
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileQuiet: (file, args, options) => (file === 'ps' ? '' : real.runFileQuiet(file, args, options)),
    runFile: (file, args, options) => {
      if (file === 'du' && args?.includes(transforms)) {
        writeFileSync(fresh, 'x');
        return '4\t' + transforms;
      }
      return real.runFile(file, args, options);
    },
  });
  try {
    const cache = discoverCaches().find((c) => c.name === 'Jest cache');
    assert(cache);
    expect(pruneCache(cache, { olderThanDays: 3, byMtime: true }).removed).toBe(0);
    expect(existsSync(transforms)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(windows)('a symlinked entry in the Jest cache is never removed', () => {
  processTable('');
  const dir = jestDir();
  const target = join(tmpHome, 'linked-transforms');
  const link = join(dir, `jest-transform-cache-${'a'.repeat(32)}-1`);
  mkdirSync(target);
  age(target);
  mkdirSync(dir);
  symlinkSync(target, link);
  try {
    const cache = discoverCaches().find((c) => c.name === 'Jest cache');
    assert(cache);
    expect(pruneCache(cache, { olderThanDays: 3, byMtime: true }).removed).toBe(0);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(target)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!windows)('the Jest cache is not discovered on Windows', () => {
  expect(jestCacheDir()).toBeNull();
  expect(discoverCaches().some((c) => c.name === 'Jest cache')).toBe(false);
});

test('sizeCaches leaves a file-list cache without a known size unmeasured and runs no du', async () => {
  const real = getExecutor();
  const du: string[] = [];
  setExecutor({
    ...real,
    runFileAsync: async (file, args, options) => {
      if (file === 'du') du.push(String(args));
      return real.runFileAsync(file, args, options);
    },
  });
  const [sized] = await sizeCaches([
    makeCacheDescriptor({ dir: tmpHome, files: [join(tmpHome, 'entry')], prune: 'entries' }),
  ]);
  expect(sized?.bytes).toBeUndefined();
  expect(sized?.sizeError).toBeUndefined();
  expect(du).toEqual([]);
});

test.skipIf(windows)('a Jest cache path that is a symlink is not discovered, so nothing behind it is pruned', () => {
  const dir = jestDir();
  const target = join(tmpHome, 'not-jest');
  const old = [join(target, 'Documents'), join(target, `jest-transform-cache-${'d'.repeat(32)}-1`)];
  for (const path of old) {
    mkdirSync(path, { recursive: true });
    age(path);
  }
  symlinkSync(target, dir);
  try {
    expect(discoverCaches().some((c) => c.name === 'Jest cache')).toBe(false);
    for (const path of old) expect(existsSync(path)).toBe(true);
  } finally {
    rmSync(dir, { force: true });
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
    const output = {
      log: () => {},
      error: () => {},
      record: () => {},
      fail: () => {},
    };
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
