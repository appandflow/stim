import { assert } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as buildLocks from '../engine/build-lock.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  cleanToolCache,
  onShortVolume,
  planToolCaches,
  surveyToolCaches,
  type ToolCache,
} from '../stimd/passes/unowned.ts';

const npm: ToolCache = {
  tool: 'npm',
  label: 'npm cache',
  paths: ['/nonexistent/stim-test/.npm'],
  command: ['npm', 'cache', 'clean', '--force'],
  running: /(^|[\s/])(npm|npx)(\s|$)|npm-cli\.js/,
};

test.each([
  { name: 'a cache on another volume than the critical one stays', short: new Set([1]), acts: false },
  { name: 'a cache on the critical volume goes', short: new Set([2]), acts: true },
  { name: '--pressure critical treats every volume as short', short: null, acts: true },
])('$name', ({ short, acts }) => {
  expect(onShortVolume(['/Volumes/other/.npm'], short, () => 2)).toBe(acts);
});

test.each([
  { name: 'a running install keeps its cache', lines: ['/usr/local/bin/node /usr/lib/npm-cli.js install'], kept: true },
  { name: 'unrelated processes do not', lines: ['/bin/zsh', '/usr/local/bin/node server.js'], kept: false },
  { name: 'processes that cannot be listed keep it', lines: null, kept: true },
])('$name', ({ lines, kept }) => {
  const [plan] = planToolCaches([npm], lines, new Map([[npm, 1024]]));
  expect(plan?.kept !== null).toBe(kept);
});

describe('cleaning a tool cache', () => {
  const calls: string[][] = [];
  let ps = '';
  let root = '';
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-tool-caches-')));
    mkdirSync(join(root, '.npm'));
    vi.stubEnv('npm_config_cache', join(root, '.npm'));
    calls.length = 0;
    ps = `${process.pid} node vitest\n`;
    setExecutor({
      ...getExecutor(),
      runFileAsync: async (file, args) => {
        calls.push([file, ...args]);
        return '';
      },
      runFileQuietAsync: async (file) => (file === 'ps' ? ps : file === 'lsof' ? `p${process.pid}\nn/\n` : null),
      findExecutable: (name) => (name === 'npm' ? '/usr/local/bin/npm' : null),
    });
  });
  afterEach(() => {
    resetExecutor();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  test('runs npm cache clean --force only when acting, on the cache npm_config_cache names', async () => {
    const [plan] = await surveyToolCaches();
    expect(plan?.cache.paths).toEqual([join(root, '.npm')]);
    if (!plan) return;
    expect((await cleanToolCache(plan, false)).outcome).toBe('would');
    expect(calls.filter(([file]) => file === 'npm')).toEqual([]);
    expect((await cleanToolCache(plan, true)).outcome).toBe('done');
    expect(calls.filter(([file]) => file === 'npm')).toEqual([['npm', 'cache', 'clean', '--force']]);
  });

  test('keeps the cache when an install started after the plan', async () => {
    ps += '4242 npm install\n';
    const result = await cleanToolCache({ cache: npm, bytes: 1024, kept: null }, true);
    expect(result.outcome).toBe('kept');
    expect(calls).toEqual([]);
  });
});

describe('removing a cache directory Stim deletes itself', () => {
  let root = '';
  const directory = (path: string): ToolCache => ({
    tool: 'gradle',
    label: 'Gradle caches',
    paths: [path],
    command: null,
    running: /GradleDaemon/,
  });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-tool-dirs-')));
    setExecutor({
      ...getExecutor(),
      runFileAsync: async () => '',
      runFileQuietAsync: async (file) =>
        file === 'ps' ? `${process.pid} node vitest\n` : file === 'lsof' ? `p${process.pid}\nn/\n` : null,
    });
  });
  afterEach(() => {
    resetExecutor();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  test('renames it aside and deletes it, leaving nothing behind', async () => {
    const cache = join(root, 'modules-2');
    mkdirSync(join(cache, 'files'), { recursive: true });
    const result = await cleanToolCache({ cache: directory(cache), bytes: 1, kept: null }, true);
    expect(result.outcome).toBe('done');
    expect(readdirSync(root)).toEqual([]);
  });

  test('keeps it while a Stim build holds a build lock', async () => {
    const cache = join(root, 'modules-2');
    mkdirSync(cache);
    vi.spyOn(buildLocks, 'listBuildLocks').mockReturnValue([
      {
        path: join(root, 'ios.lock'),
        name: 'ios',
        platform: 'ios',
        key: null,
        pid: 1,
        projectRoot: null,
        startedAt: null,
        logFile: null,
        alive: true,
        unresolved: false,
      },
    ]);
    const result = await cleanToolCache({ cache: directory(cache), bytes: 1, kept: null }, true);
    expect(result).toMatchObject({ outcome: 'kept', detail: expect.stringContaining('Stim build holds') });
    expect(existsSync(cache)).toBe(true);
  });

  test('finishes a removal an earlier run renamed aside', async () => {
    const caches = join(root, 'caches');
    const leftover = join(caches, '.stim-delete-modules-2-0f0e0d0c-0b0a-4908-8706-050403020100');
    mkdirSync(join(leftover, 'files'), { recursive: true });
    vi.stubEnv('GRADLE_USER_HOME', root);
    try {
      const plan = (await surveyToolCaches()).find((entry) => entry.cache.tool === 'gradle');
      expect(plan?.cache.paths).toEqual([leftover]);
      assert(plan);
      expect((await cleanToolCache(plan, true)).outcome).toBe('done');
      expect(readdirSync(caches)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('keeps a cache directory that is a link, and what it points to', async () => {
    const target = join(root, 'external-modules');
    mkdirSync(target);
    const link = join(root, 'modules-2');
    symlinkSync(target, link, 'dir');
    const result = await cleanToolCache({ cache: directory(link), bytes: 1, kept: null }, true);
    expect(result).toMatchObject({ outcome: 'kept', detail: expect.stringContaining('is a link') });
    expect(existsSync(target)).toBe(true);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a removal that fails after the rename as failed with the bytes left aside',
    async () => {
      const cache = join(root, 'modules-2');
      const locked = join(cache, 'locked');
      mkdirSync(locked, { recursive: true });
      writeFileSync(join(locked, 'blob'), 'x'.repeat(4096));
      chmodSync(locked, 0o500);
      try {
        const result = await cleanToolCache({ cache: directory(cache), bytes: 8192, kept: null }, true);
        expect(result.outcome).toBe('failed');
        expect(result.detail).toContain('left aside');
        expect(readdirSync(root).filter((name) => name.startsWith('.stim-delete-modules-2-'))).toHaveLength(1);
      } finally {
        for (const name of readdirSync(root)) chmodSync(join(root, name, 'locked'), 0o700);
      }
    },
  );

  test('never deletes a path outside the test runner temporary directory', async () => {
    const result = await cleanToolCache(
      { cache: directory('/nonexistent/stim-test/modules-2'), bytes: 1, kept: null },
      true,
    );
    expect(result).toMatchObject({
      outcome: 'kept',
      detail: expect.stringContaining('outside its temporary directory'),
    });
  });
});
