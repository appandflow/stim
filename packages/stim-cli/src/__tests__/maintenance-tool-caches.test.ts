import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as buildLocks from '../engine/build-lock.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { cleanToolCache, planToolCaches, surveyToolCaches, type ToolCache } from '../stimd/passes/unowned.ts';

const npm: ToolCache = {
  tool: 'npm',
  label: 'npm cache',
  paths: ['/nonexistent/stim-test/.npm'],
  command: ['npm', 'cache', 'clean', '--force'],
  running: /(^|[\s/])(npm|npx)(\s|$)|npm-cli\.js/,
};

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
