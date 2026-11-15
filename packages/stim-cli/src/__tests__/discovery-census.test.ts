import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StimContext } from '@stim-cli/core';
import { readDiscoveryCensusFile } from '@stim-cli/core/state';
import * as diskUsage from '../disk-usage.ts';
import { censusDue, runDiscoveryCensusIfDue } from '../workspace/discovery-census.ts';
import { runDiscoveryScanIfDue } from '../workspace/discovery-scan.ts';
import { hungRead } from '../workspace/bounded-read.ts';
import { loadConfig, saveConfig } from '../workspace/config.ts';
import { discoverCheckouts } from '../workspace/discovery.ts';
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
  const tick = (env: NodeJS.ProcessEnv = {}, operation = testContext({ env })) => ({
    operation,
    measured: { measurement: { disk: [{ volume: '/', freeMb: 500_000 }] } },
  });

  function checkout(path: string, output = 4096) {
    mkdirSync(join(path, 'android', 'build'), { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(path, 'android', 'build', 'out.bin'), Buffer.alloc(output));
  }

  async function run(
    now: number,
    options: Parameters<typeof runDiscoveryCensusIfDue>[1] = {},
    operation?: StimContext,
  ) {
    const result = await runDiscoveryCensusIfDue(tick({}, operation), { now, attempted: { at: 0 }, ...options });
    const file = readDiscoveryCensusFile();
    return { result, census: file.status === 'read' ? file.census : null };
  }

  const scanAt = (now: number) => runDiscoveryScanIfDue(tick(), { home, now, attempted: { at: 0 } });

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
    await scanAt(t0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('lists what no other route manages, with each folder, and measures the build output of both kinds', async () => {
    const { census } = await run(t0);
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
    for (const find of census?.finds ?? [])
      expect(find).toMatchObject({ dirs: 1, measuredDirs: 1, failedDirs: 0, unreadable: false });
    expect(census?.finds.find(({ path }) => path.endsWith('/a'))?.bytes).toBeGreaterThanOrEqual(16384);
    expect(census?.pending).toBe(false);
  });

  it('never reports a walk that failed as zero bytes, and a walk that waits as not measured yet', async () => {
    vi.spyOn(diskUsage, 'refreshMeasure').mockImplementation(async (path) =>
      path.includes('/old/') ? { outcome: 'failed', measure: null } : { outcome: 'busy', measure: null },
    );
    const { census } = await run(t0);
    const of = (name: string) => census?.finds.find(({ path }) => path.endsWith(name));
    expect(of('/dev/old')).toMatchObject({ dirs: 1, measuredDirs: 0, failedDirs: 1, bytes: 0 });
    expect(of('/dev/fresh')).toMatchObject({ dirs: 1, measuredDirs: 0, failedDirs: 0, bytes: 0 });
    expect(census?.pending).toBe(true);
  });

  it('measures at most the bound per run, leaves the rest not measured, and the next run continues without repeating', async () => {
    const { census: first } = await run(t0, { maxCheckouts: 2 });
    expect(first?.finds.filter(({ evaluatedAt }) => evaluatedAt === 0)).toHaveLength(3);
    expect(first?.pending).toBe(true);
    const refresh = vi.spyOn(diskUsage, 'refreshMeasure');
    const { census: second } = await run(t0 + hour, { maxCheckouts: 2 });
    expect(second?.finds.filter(({ evaluatedAt }) => evaluatedAt === 0)).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    const { census: third } = await run(t0 + 2 * hour, { maxCheckouts: 2 });
    expect(third?.pending).toBe(false);
  });

  it('starts no read once the budget is spent, and keeps every checkout not measured yet', async () => {
    const { census } = await run(t0, { budgetMs: -1 });
    expect(census?.finds).toHaveLength(5);
    expect(census?.finds.every(({ evaluatedAt, dirs }) => evaluatedAt === 0 && dirs === 0)).toBe(true);
  });

  it('classifies again after the roots change, so a folder just added is no longer listed', async () => {
    await run(t0);
    saveConfig({
      version: 2,
      projects: {},
      repos: {},
      maintenance: { discoverRoots: [join(home, 'dev', 'tools'), join(home, 'dev')] },
    });
    const { census } = await run(t0 + hour);
    expect(census?.finds.filter(({ kind }) => kind === 'reduce-only')).toEqual([]);
  });

  it('classifies the scan it records, not a discovery the same operation computed from an older scan', async () => {
    const operation = testContext();
    await discoverCheckouts(loadConfig(), [], operation);
    checkout(join(home, 'dev', 'added'));
    await scanAt(t0 + 8 * day);
    const { census } = await run(t0 + 8 * day, {}, operation);
    expect(census?.scanRanAt).toBe(t0 + 8 * day);
    expect(census?.finds.map(({ path }) => path.slice(home.length))).toContain('/dev/added');
  });

  it('is never run in a scoped home and writes nothing', async () => {
    await runDiscoveryCensusIfDue(tick({ STIM_HOME: join(base, 'state') }), { now: t0, attempted: { at: 0 } });
    expect(readDiscoveryCensusFile()).toEqual({ status: 'absent' });
  });

  describe('reads of a checkout', () => {
    const real = {
      readNames: (path: string) => readdir(path),
      isDirectory: async (path: string) => (await lstat(path)).isDirectory(),
      lstat: async (path: string) => {
        const info = await lstat(path);
        return {
          kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          mtimeMs: info.mtimeMs,
        } as const;
      },
      head: async (path: string, bytes: number) =>
        (await lstat(path)).isFile() ? (await readFile(path, 'utf8')).slice(0, bytes) : null,
    };
    const denied = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

    it('reads a denied listing as a checkout that could not be measured, never as a measured zero', async () => {
      const { census } = await run(t0, {
        io: {
          ...real,
          readNames: async (path) => {
            if (path.endsWith(join('dev', 'old', 'android'))) throw denied();
            return real.readNames(path);
          },
        },
      });
      const old = census?.finds.find(({ path }) => path.endsWith('/dev/old'));
      expect(old).toMatchObject({ unreadable: true, bytes: 0, measuredDirs: 0 });
      expect(census?.finds.find(({ path }) => path.endsWith('/dev/fresh'))).toMatchObject({
        unreadable: false,
        measuredDirs: 1,
      });
    });

    it('takes a path that does not exist as absent, not as a failure', async () => {
      const { census } = await run(t0, {
        io: {
          ...real,
          readNames: async (path) => {
            if (path.endsWith(join('dev', 'old', 'apps'))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return real.readNames(path);
          },
        },
      });
      expect(census?.finds.find(({ path }) => path.endsWith('/dev/old'))).toMatchObject({
        unreadable: false,
        measuredDirs: 1,
      });
    });

    describe.each([
      ['a listing that never answers', 'readNames'],
      ['a tag file read that never answers', 'head'],
    ] as const)('%s', (_name, which) => {
      let release: () => void = () => {};
      afterEach(() => release());

      it('ends the read at its timeout, leaves that checkout could not be measured and starts no further read', async () => {
        const never = new Promise<never>((_, reject) => {
          release = () => reject(denied());
        });
        const started: string[] = [];
        if (which === 'head') {
          const target = join(home, 'dev', 'old', 'target');
          mkdirSync(target);
          writeFileSync(join(target, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55');
        }
        const running = run(t0, {
          readTimeoutMs: 20,
          io: {
            ...real,
            readNames: (path) => {
              if (which === 'readNames' && path.endsWith(join('dev', 'fresh', 'apps'))) {
                started.push(which);
                return never;
              }
              return real.readNames(path);
            },
            head: () => {
              started.push(which);
              return never;
            },
          },
        });
        while (started.length === 0) await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(20);
        const { result, census } = await running;
        expect(result).toBeUndefined();
        expect(started).toHaveLength(1);
        const failed = census?.finds.filter(({ unreadable }) => unreadable) ?? [];
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ bytes: 0, measuredDirs: 0 });
        expect(census?.finds.filter(({ evaluatedAt }) => evaluatedAt === 0).length).toBeGreaterThan(0);
        expect(hungRead()).not.toBeNull();
      });
    });
  });

  describe('last git activity', () => {
    const real = {
      readNames: (path: string) => readdir(path),
      isDirectory: async (path: string) => (await lstat(path)).isDirectory(),
      lstat: async (path: string) => {
        const info = await lstat(path);
        return {
          kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          mtimeMs: info.mtimeMs,
        } as const;
      },
      head: async (path: string, bytes: number) =>
        (await lstat(path)).isFile() ? (await readFile(path, 'utf8')).slice(0, bytes) : null,
    };
    const at = (iso: string) => new Date(iso);
    const touch = (path: string, when: Date) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'x');
      utimesSync(path, when, when);
    };
    const git = async (io = real) => {
      const { census } = await run(t0, { io });
      return Object.fromEntries(
        (census?.finds ?? []).map(({ path, gitActivityAt }) => [path.slice(home.length), gitActivityAt]),
      );
    };

    it('is the newest of HEAD, index and logs/HEAD of a main checkout, and unknown without a git directory', async () => {
      const dir = join(home, 'dev', 'old', '.git');
      touch(join(dir, 'HEAD'), at('2026-01-01T00:00:00Z'));
      touch(join(dir, 'index'), at('2026-03-01T00:00:00Z'));
      touch(join(dir, 'logs', 'HEAD'), at('2026-02-01T00:00:00Z'));
      const found = await git();
      expect(found['/dev/old']).toBe(at('2026-03-01T00:00:00Z').getTime());
      expect(found['/dev/fresh']).toBeNull();
    });

    it('follows a linked worktree to its git directory under .git/worktrees', async () => {
      const gitDir = join(base, 'main', '.git', 'worktrees', 'fresh');
      touch(join(gitDir, 'HEAD'), at('2026-04-01T00:00:00Z'));
      writeFileSync(join(home, 'dev', 'fresh', '.git'), `gitdir: ${gitDir}\n`);
      expect((await git())['/dev/fresh']).toBe(at('2026-04-01T00:00:00Z').getTime());
    });

    it('is unknown for a .git file that names a directory outside a .git/worktrees directory', async () => {
      const elsewhere = join(base, 'elsewhere', 'gitdir');
      touch(join(elsewhere, 'HEAD'), at('2026-04-01T00:00:00Z'));
      writeFileSync(join(home, 'dev', 'fresh', '.git'), `gitdir: ${elsewhere}\n`);
      writeFileSync(join(home, 'dev', 'old', '.git'), 'gitdir: relative/.git/worktrees/x\n');
      const found = await git();
      expect(found['/dev/fresh']).toBeNull();
      expect(found['/dev/old']).toBeNull();
    });

    it('is unknown, not old, when a git file is a symlink', async () => {
      const dir = join(home, 'dev', 'old', '.git');
      touch(join(base, 'target-file'), at('2020-01-01T00:00:00Z'));
      mkdirSync(dir, { recursive: true });
      symlinkSync(join(base, 'target-file'), join(dir, 'HEAD'));
      expect((await git())['/dev/old']).toBeNull();
    });

    it('is unknown when the read never answers, and the run does not wait on it', async () => {
      touch(join(home, 'dev', 'fresh', '.git', 'HEAD'), at('2026-01-01T00:00:00Z'));
      let release: () => void = () => {};
      const never = new Promise<never>((_, reject) => {
        release = () => reject(new Error('released'));
      });
      const started: string[] = [];
      const running = run(t0, {
        readTimeoutMs: 20,
        io: {
          ...real,
          lstat: (path) => {
            if (path.endsWith(join('dev', 'fresh', '.git'))) {
              started.push(path);
              return never;
            }
            return real.lstat(path);
          },
        },
      });
      while (started.length === 0) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(20);
      const { census } = await running;
      release();
      expect(started).toHaveLength(1);
      expect(census?.finds.find(({ path }) => path.endsWith('/dev/fresh'))?.gitActivityAt).toBeNull();
    });
  });

  describe('errors from measuring', () => {
    it('lets an unverified child cleanup propagate as the same object', async () => {
      const failure = Object.assign(new Error('unverified'), { reportCleanup: true });
      vi.spyOn(diskUsage, 'refreshMeasure').mockRejectedValue(failure);
      await expect(run(t0)).rejects.toBe(failure);
    });

    it('contains any other error, returns its message and writes nothing', async () => {
      vi.spyOn(diskUsage, 'refreshMeasure').mockRejectedValue(new Error('disk exploded'));
      const { result, census } = await run(t0);
      expect(result).toBe('disk exploded');
      expect(census).toBeNull();
    });
  });
});
