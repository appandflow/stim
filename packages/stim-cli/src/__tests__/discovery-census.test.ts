import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDiscoveryCensusFile } from '@stim-cli/core/state';
import * as diskUsage from '../disk-usage.ts';
import { censusDue, runDiscoveryCensusIfDue } from '../workspace/discovery-census.ts';
import { runDiscoveryScanIfDue } from '../workspace/discovery-scan.ts';
import { saveConfig } from '../workspace/config.ts';
import { testContext } from './_context.ts';

vi.mock('../workspace/protected-locations.ts', async (original) => {
  const real = await original<typeof import('../workspace/protected-locations.ts')>();
  return {
    ...real,
    isProtectedLocation: (path: string) => real.isProtectedLocation(path, { home: homedir(), temps: [] }),
  };
});

const hour = 3_600_000;
const day = 24 * hour;
const t0 = Date.UTC(2026, 10, 14);
const reads = {
  processes: async () => ({ commands: [], cwds: [] }),
  launchers: async () => ({ targets: [], incomplete: [] }),
  sessions: async () => [],
};

describe('censusDue', () => {
  const last = { at: t0, scanRanAt: 5, roots: ['/a'], pending: false };
  it('is due for no census, another scan, other roots, a day, or an hour while something waits', () => {
    expect(censusDue(null, 5, ['/a'], t0)).toBe(true);
    expect(censusDue(last, 6, ['/a'], t0 + hour)).toBe(true);
    expect(censusDue(last, 5, ['/a', '/b'], t0 + hour)).toBe(true);
    expect(censusDue(last, 5, ['/a'], t0 + hour)).toBe(false);
    expect(censusDue(last, 5, ['/a'], t0 + day)).toBe(true);
    expect(censusDue({ ...last, pending: true }, 5, ['/a'], t0 + hour)).toBe(true);
    expect(censusDue({ ...last, pending: true }, 5, ['/a'], t0 + hour - 1)).toBe(false);
  });
});

describe('runDiscoveryCensusIfDue', () => {
  let base: string;
  let home: string;
  const tick = (env: NodeJS.ProcessEnv = {}) => ({
    operation: testContext({ env }),
    measured: { measurement: { disk: [{ volume: '/', freeMb: 500_000 }] } },
  });

  function checkout(path: string, output = 4096) {
    mkdirSync(join(path, 'android', 'build'), { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(path, 'android', 'build', 'out.bin'), Buffer.alloc(output));
  }

  function age(path: string, at: number) {
    const date = new Date(at);
    utimesSync(join(path, 'package.json'), date, date);
    utimesSync(join(path, 'android', 'build', 'out.bin'), date, date);
    utimesSync(join(path, 'android', 'build'), date, date);
    utimesSync(join(path, 'android'), date, date);
    utimesSync(path, date, date);
  }

  async function run(now: number, options: Parameters<typeof runDiscoveryCensusIfDue>[1] = {}) {
    await runDiscoveryCensusIfDue(tick(), { now, attempted: { at: 0 }, reads, ...options });
    const file = readDiscoveryCensusFile();
    return file.status === 'read' ? file.census : null;
  }

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-census-')));
    home = join(base, 'home');
    mkdirSync(home);
    vi.stubEnv('STIM_HOME', '');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    saveConfig({ version: 2, projects: {}, repos: {}, maintenance: { discoverRoots: [join(home, 'dev', 'tools')] } });
    checkout(join(home, 'dev', 'old'), 8192);
    checkout(join(home, 'dev', 'fresh'));
    checkout(join(home, 'dev', 'tools', 'managed'));
    checkout(join(home, '.exact', 'exact2', 'a'), 16384);
    checkout(join(home, '.exact', 'exact2', 'b'));
    checkout(join(home, '.mytool'));
    age(join(home, 'dev', 'old'), t0 - 40 * day);
    await runDiscoveryScanIfDue(tick(), { home, now: t0, attempted: { at: 0 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('lists what no other route manages, with each folder, and measures the build output of both kinds', async () => {
    const census = await run(t0);
    expect(census?.scanRanAt).toBe(t0);
    const found = (census?.finds ?? []).map(({ path, kind, folder, adoptable }) => [
      path.slice(home.length),
      kind,
      folder.slice(home.length),
      adoptable,
    ]);
    expect(found).toEqual([
      ['/dev/fresh', 'reduce-only', '/dev', true],
      ['/dev/old', 'reduce-only', '/dev', true],
      ['/.exact/exact2/a', 'dot-folder', '/.exact/exact2', true],
      ['/.exact/exact2/b', 'dot-folder', '/.exact/exact2', true],
      ['/.mytool', 'dot-folder', '', false],
    ]);
    for (const find of census?.finds ?? []) expect(find).toMatchObject({ dirs: 1, measuredDirs: 1, failedDirs: 0 });
    expect(census?.finds.find(({ path }) => path.endsWith('/a'))?.bytes).toBeGreaterThanOrEqual(16384);
    expect(census?.pending).toBe(false);
  });

  it('records the newest activity only of a reduce-only checkout proven idle past maintenance.olderThanDays', async () => {
    const census = await run(t0);
    const activity = Object.fromEntries(
      (census?.finds ?? []).map(({ path, lastActivityAt }) => [path.slice(home.length), lastActivityAt]),
    );
    expect(activity['/dev/old']).toBe(t0 - 40 * day);
    expect(activity['/dev/fresh']).toBeNull();
    expect(activity['/.exact/exact2/a']).toBeNull();
  });

  it('keeps a checkout that something runs from out of the idle list', async () => {
    const census = await run(t0, {
      reads: {
        ...reads,
        processes: async () => ({ commands: [{ pid: 7, line: `${join(home, 'dev', 'old')}/bin/tool` }], cwds: [] }),
      },
    });
    expect(census?.finds.find(({ path }) => path.endsWith('/old'))?.lastActivityAt).toBeNull();
  });

  it('never reports a walk that failed as zero bytes, and a walk that waits as unmeasured yet', async () => {
    const refresh = vi.spyOn(diskUsage, 'refreshMeasure');
    refresh.mockImplementation(async (path) =>
      path.includes('/old/') ? { outcome: 'failed', measure: null } : { outcome: 'busy', measure: null },
    );
    const census = await run(t0);
    const of = (name: string) => census?.finds.find(({ path }) => path.endsWith(name));
    expect(of('/dev/old')).toMatchObject({ dirs: 1, measuredDirs: 0, failedDirs: 1, bytes: 0 });
    expect(of('/dev/fresh')).toMatchObject({ dirs: 1, measuredDirs: 0, failedDirs: 0, bytes: 0 });
    expect(census?.pending).toBe(true);
  });

  it('measures at most the bound per run, leaves the rest not measured, and the next run continues without repeating', async () => {
    const first = await run(t0, { maxCheckouts: 2 });
    expect(first?.finds.filter(({ evaluatedAt }) => evaluatedAt === 0)).toHaveLength(3);
    expect(first?.pending).toBe(true);
    const refresh = vi.spyOn(diskUsage, 'refreshMeasure');
    const second = await run(t0 + hour, { maxCheckouts: 2 });
    expect(second?.finds.filter(({ evaluatedAt }) => evaluatedAt === 0)).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    const third = await run(t0 + 2 * hour, { maxCheckouts: 2 });
    expect(third?.pending).toBe(false);
  });

  it('classifies again after the roots change, so a folder just added is no longer listed', async () => {
    await run(t0);
    saveConfig({
      version: 2,
      projects: {},
      repos: {},
      maintenance: { discoverRoots: [join(home, 'dev', 'tools'), join(home, 'dev')] },
    });
    const census = await run(t0 + hour);
    expect(census?.finds.filter(({ kind }) => kind === 'reduce-only')).toEqual([]);
  });

  it('is never run in a scoped home and writes nothing', async () => {
    await runDiscoveryCensusIfDue(tick({ STIM_HOME: join(base, 'state') }), { now: t0, attempted: { at: 0 }, reads });
    expect(readDiscoveryCensusFile()).toEqual({ status: 'absent' });
  });
});
