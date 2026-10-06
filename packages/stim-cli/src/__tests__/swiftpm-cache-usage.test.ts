import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSwiftpmCacheUsage, swiftpmCacheUsageFile } from '@stim-cli/core/state';
import { getSwiftpmCacheUsage } from '../devices/swiftpm-cache-usage.ts';
import { swiftpmCacheLines } from '../devices/swiftpm-cache-usage-output.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

let home: string;
let dir: string;
let du: ReturnType<typeof vi.fn<(file: string, args: string[]) => Promise<string>>>;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-swiftpm-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CACHE_HOME', join(home, '.cache'));
  vi.stubEnv('STIM_HOME', join(home, 'stim'));
  dir =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'org.swift.swiftpm')
      : join(home, '.cache', 'org.swift.swiftpm');
  du = vi.fn<(file: string, args: string[]) => Promise<string>>(
    async (_file: string, args: string[]) => `1536\t${args.at(-1)}\n`,
  );
  setExecutor({ runFileAsync: du });
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('reports measured allocated bytes without modifying the shared SwiftPM cache', async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'keep'), 'shared build data');
  const usage = await getSwiftpmCacheUsage();
  expect(usage).toMatchObject({ version: 1, dir, present: true, bytes: 1536 * 1024, complete: true });
  expect(du).toHaveBeenCalledWith('du', ['-sk', dir], { timeoutMs: 60_000 });
  expect(readSwiftpmCacheUsage()).toEqual(usage);
  expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('shared build data');
  expect(swiftpmCacheLines({ ...usage, bytes: 1.5 * 1024 ** 3 }, Date.parse(usage.measuredAt) + 120_000)[0]).toBe(
    'SwiftPM cache (1.5 GB) - measured 2m ago',
  );
  expect(swiftpmCacheLines(usage).join('\n')).toContain(dir);
  expect(swiftpmCacheLines(usage).join('\n')).toContain('shared by every SwiftPM build');
});

test('an absent cache has zero bytes and no output or du call', async () => {
  const usage = await getSwiftpmCacheUsage();
  expect(usage).toMatchObject({ dir, present: false, bytes: 0, complete: true });
  expect(du).not.toHaveBeenCalled();
  expect(swiftpmCacheLines(usage)).toEqual([]);
});

test.each([
  Object.assign(new Error('denied'), { status: 1 }),
  Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
  Object.assign(new Error('missing du'), { code: 'ENOENT' }),
])('a failed du reports unknown bytes instead of throwing or crediting partial output: %s', async (error) => {
  mkdirSync(dir, { recursive: true });
  du.mockRejectedValue(Object.assign(error, { stdout: `1536\t${dir}` }));
  const usage = await getSwiftpmCacheUsage();
  expect(usage).toMatchObject({ present: true, bytes: null, complete: false });
  expect(readSwiftpmCacheUsage()).toEqual(usage);
});

test('reuses a measurement for ten minutes then refreshes it', async () => {
  mkdirSync(dir, { recursive: true });
  const first = await getSwiftpmCacheUsage();
  du.mockResolvedValue(`2000\t${dir}`);
  expect(await getSwiftpmCacheUsage()).toEqual(first);
  expect(du).toHaveBeenCalledTimes(1);
  writeFileSync(
    swiftpmCacheUsageFile(),
    JSON.stringify({ ...first, measuredAt: new Date(Date.now() - 600_000).toISOString() }),
  );
  expect((await getSwiftpmCacheUsage()).bytes).toBe(2000 * 1024);
  expect(du).toHaveBeenCalledTimes(2);
});

test('a changed resolved directory cannot reuse another cache size', async () => {
  mkdirSync(dir, { recursive: true });
  await getSwiftpmCacheUsage();
  rmSync(dir, { recursive: true });
  const other = join(home, 'other-cache');
  mkdirSync(other);
  symlinkSync(other, dir, process.platform === 'win32' ? 'junction' : 'dir');
  du.mockResolvedValue(`32\t${other}`);
  expect(await getSwiftpmCacheUsage()).toMatchObject({ dir: other, bytes: 32 * 1024 });
  expect(du).toHaveBeenCalledTimes(2);
});

test.skipIf(process.platform === 'darwin')(
  'XDG_CACHE_HOME overrides the home cache and changing it remeasures',
  async () => {
    mkdirSync(dir, { recursive: true });
    await getSwiftpmCacheUsage();
    const xdg = join(home, 'xdg');
    vi.stubEnv('XDG_CACHE_HOME', xdg);
    const other = join(xdg, 'org.swift.swiftpm');
    mkdirSync(other, { recursive: true });
    expect((await getSwiftpmCacheUsage()).dir).toBe(other);
    expect(du).toHaveBeenCalledTimes(2);
    vi.stubEnv('XDG_CACHE_HOME', '');
    expect((await getSwiftpmCacheUsage()).dir).toBe(dir);
    expect(du).toHaveBeenCalledTimes(3);
  },
);

test.skipIf(process.platform === 'win32')(
  'real du accepts the report-only invocation on a temporary directory',
  async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'data'), Buffer.alloc(8192, 1));
    resetExecutor();
    const usage = await getSwiftpmCacheUsage();
    expect(usage.complete).toBe(true);
    expect(usage.bytes).toBeGreaterThanOrEqual(8192);
  },
);
