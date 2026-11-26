import * as privateSize from '../private-size.ts';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { sharedCompilationCache, diskUsageCacheFile } from '@stim-cli/core/state';
import { cacheBlocked, measureSizes, sizeScanDeferred } from '../stimd/passes/measure.ts';
import { buildLockPath } from '../engine/build-lock.ts';
import { cacheClaimRoot } from '../cache/cache-claim.ts';
import { captureProcessToken } from '../process-identity.ts';
import { plantClaim } from './_factories.ts';
import { releaseBuildSlot, tryAcquireBuildSlot } from '../engine/build-slots.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { saveConfig } from '../workspace/config.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import { register } from '../cache/cache-manifest.ts';

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    freemem: vi.fn<typeof original.freemem>(original.freemem),
    totalmem: vi.fn<typeof original.totalmem>(original.totalmem),
    loadavg: vi.fn<typeof original.loadavg>(original.loadavg),
  };
});

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(os.tmpdir(), 'stim-maintenance-measure-')));
  process.env.STIM_HOME = home;
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  delete process.env.STIM_HOME;
});

test('high load defers scans and every measured output/cache uses a bounded du call without deleting data', async () => {
  const app = join(home, 'app');
  mkdirSync(app);
  saveConfig({ projects: { [app]: {} }, repos: {} });
  const workspace = ensureWorkspaceStorage(app);
  mkdirSync(join(workspace, 'derived-data'));
  const cas = sharedCompilationCache();
  mkdirSync(cas);
  const sentinel = join(cas, 'keep');
  writeFileSync(sentinel, 'cache bytes');
  const leftover = join(home, 'compilation-cache');
  mkdirSync(leftover);
  const registered = join(home, 'registered');
  mkdirSync(registered);
  register({ dir: registered, name: 'Test cache', prune: 'entries' });
  const calls: { file: string; args: readonly string[]; timeout: number | undefined }[] = [];
  setExecutor({
    runFile: (file, args, opts) => {
      calls.push({ file, args, timeout: opts?.timeoutMs });
      if (file === 'du') return `123\t${args[1]}\n`;
      return '';
    },
    runFileQuiet: () => null,
    runQuiet: () => null,
    findExecutable: () => null,
  });
  const load = vi.spyOn(os, 'loadavg').mockReturnValue([os.cpus().length * 5, 0, 0]);
  expect(sizeScanDeferred()).toBe(true);
  load.mockReturnValue([0, 0, 0]);
  expect(sizeScanDeferred()).toBe(false);
  const failures: string[] = [];
  const sizes = await measureSizes(100, (target) => failures.push(target));
  expect(sizes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ category: 'workspace-outputs', workspace: app, bytes: 123 * 1024, measuredAt: 100 }),
      expect.objectContaining({ category: 'compilation-cache', dir: cas, bytes: 123 * 1024 }),
      expect.objectContaining({ category: 'compilation-cache', dir: leftover, bytes: 123 * 1024 }),
      expect.objectContaining({ category: 'other', dir: registered, bytes: 123 * 1024 }),
    ]),
  );
  expect(failures).toEqual([]);
  const duCalls = calls.filter((call) => call.file === 'du');
  expect(duCalls.length).toBeGreaterThanOrEqual(3);
  for (const call of duCalls) {
    expect(call.args[0]).toBe('-sk');
    expect(call.timeout).toBe(120_000);
  }
  expect(existsSync(sentinel)).toBe(true);
});

test('the link left at the old compilation-cache name is measured once, as the renamed cache', async () => {
  const cas = join(home, 'compilation-cache.noindex');
  mkdirSync(cas);
  symlinkSync('compilation-cache.noindex', join(home, 'compilation-cache'), 'junction');
  register({ dir: join(home, 'compilation-cache'), name: 'Xcode compilation cache', prune: 'atomic' });
  setExecutor({
    runFile: (file, args) => (file === 'du' ? `123\t${args[1]}\n` : ''),
    runFileQuiet: () => null,
    runQuiet: () => null,
    findExecutable: () => null,
  });

  const sizes = await measureSizes(100, () => {});

  expect(sizes.filter((size) => size.category === 'compilation-cache' || size.category === 'other')).toEqual([
    expect.objectContaining({ category: 'compilation-cache', dir: cas }),
  ]);
});

const cas = () => ({
  name: 'Swift compilation cache',
  dir: sharedCompilationCache(),
  category: 'compilation-cache' as const,
});

test('only a claim on the Swift compilation cache blocks emptying it, not build locks or slots', () => {
  const dir = sharedCompilationCache();
  const token = captureProcessToken(process.ppid);
  if (!token) throw new Error('no process identity for the parent process');
  plantClaim(buildLockPath('ios', 'app'), 'exclusive', { pid: process.ppid, processToken: token });
  const slot = tryAcquireBuildSlot({ max: 2, root: '/w/ios' });
  expect(cacheBlocked(cas(), [])).toBeUndefined();
  releaseBuildSlot(slot);
  const claim = plantClaim(
    cacheClaimRoot(dir),
    'shared',
    { pid: process.ppid, processToken: token },
    {
      details: { platform: 'ios', projectRoot: '/w/ios' },
    },
  );
  expect(cacheBlocked(cas(), [])).toBe(`the ios build (pid ${process.ppid} in /w/ios) may be using it`);
  writeFileSync(claim, '{');
  expect(cacheBlocked(cas(), [])).toBe(`the cache claim ${claim} is unresolved, so a build may be using it`);
});

test.each([
  { label: 'uncapped', cap: 0, age: 1, bytes: 200, walked: false },
  { label: 'under cap', cap: 1, age: 1, bytes: 100, walked: false },
  { label: 'expired', cap: 1, age: 6, bytes: 100, walked: true },
  { label: 'category total over cap', cap: 1, age: 1, bytes: 600_000_000, walked: true },
  { label: 'missing sibling', cap: 1, age: 1, bytes: 100, walked: true, missing: true },
  { label: 'partial sibling', cap: 1, age: 1, bytes: 100, walked: true, partial: true },
  { label: 'expired sibling', cap: 1, age: 1, bytes: 100, walked: true, expired: true },
])('cache reuse: $label', async ({ cap, age, bytes, walked, missing, partial, expired }) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
  vi.stubEnv('STIM_CACHES_SWIFT_COMPILATION_CACHE_MAX_GB', String(cap));
  saveConfig({ projects: {}, repos: {} });
  const dirs = [sharedCompilationCache(), join(home, 'compilation-cache')];
  const measuredAt = Date.now() - age * 3_600_000;
  const at = (i: number) => (expired && i === 1 ? Date.now() - 7 * 3_600_000 : measuredAt);
  for (const [i, dir] of dirs.entries()) {
    mkdirSync(dir, { recursive: true });
    const file = diskUsageCacheFile(dir);
    mkdirSync(join(file, '..'), { recursive: true });
    if (!(missing && i === 1))
      writeFileSync(
        file,
        JSON.stringify({
          path: dir,
          bytes,
          privateBytes: null,
          measuredAt: new Date(at(i)).toISOString(),
          ...(partial && i === 1 ? { partial: true } : {}),
        }),
      );
  }
  const walk = vi.spyOn(privateSize, 'measureTree').mockResolvedValue({ bytes: 50, privateBytes: null });
  const sizes = await measureSizes(Date.now(), () => {}, undefined, []);
  expect(
    sizes.filter((size) => dirs.includes(size.dir)).map(({ bytes: count, measuredAt: time }) => [count, time]),
  ).toEqual(dirs.map(() => [walked ? 50 : bytes, walked ? Date.now() : measuredAt]));
  expect(walk.mock.calls.filter(([dir]) => dirs.includes(dir))).toHaveLength(walked ? 2 : 0);
});

test('a capped category reuses its sizes when one of its folders does not exist', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
  vi.stubEnv('STIM_CACHES_BUILD_CACHE_MAX_GB', '1');
  saveConfig({ projects: {}, repos: {} });
  const dir = join(home, 'relocated-build-cache');
  mkdirSync(dir, { recursive: true });
  register({ dir, name: 'Build cache', prune: 'entries' });
  const file = diskUsageCacheFile(dir);
  mkdirSync(join(file, '..'), { recursive: true });
  const measuredAt = Date.now() - 3_600_000;
  writeFileSync(file, JSON.stringify({ path: dir, bytes: 100, measuredAt: new Date(measuredAt).toISOString() }));
  const walk = vi.spyOn(privateSize, 'measureTree').mockResolvedValue({ bytes: 50, privateBytes: null });
  const sizes = await measureSizes(Date.now(), () => {}, undefined);
  expect(sizes.find((size) => size.dir === dir)).toMatchObject({ category: 'build-cache', bytes: 100, measuredAt });
  expect(walk.mock.calls.filter(([path]) => path === dir)).toHaveLength(0);
});
