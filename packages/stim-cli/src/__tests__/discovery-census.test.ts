import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StimContext } from '@stim-cli/core';
import { readDiscoveryCensusFile, readDiscoveryScanFile, readDiskUsage } from '@stim-cli/core/state';
import * as diskUsage from '../disk-usage.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { discoveryLines, discoveryReport, lowDiskLine } from '../workspace/discovery-report.ts';
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

  it('is due while a recorded find lies where the scan no longer descends, judged on the path alone', () => {
    const find = (path: string) => ({ ...last, finds: [{ path }] });
    expect(censusDue(find('/h/Documents/app'), 5, ['/a'], t0 + hour, '/h')).toBe(true);
    expect(censusDue(find('/h/documents/app'), 5, ['/a'], t0 + hour, '/h')).toBe(true);
    expect(censusDue(find('/h/dev/app'), 5, ['/a'], t0 + hour, '/h')).toBe(false);
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

  it('keeps the census pending while the bound leaves expired measurements, refreshes the longest-waiting first, and finishes the rest in the next runs', async () => {
    const complete = () =>
      discoveryReport({
        scan: readDiscoveryScanFile(),
        census: readDiscoveryCensusFile(),
        setting: { value: [join(home, 'dev', 'tools')], error: null },
        home,
        canonical: null,
      }).complete;
    const { census: first } = await run(t0, { maxCheckouts: 3 });
    const measuredFirst = (first?.finds ?? []).filter(({ evaluatedAt }) => evaluatedAt === t0).map(({ path }) => path);
    expect(measuredFirst).toHaveLength(3);
    const { census: second } = await run(t0 + day, { maxCheckouts: 3 });
    const at = (census: typeof second, when: number) =>
      (census?.finds ?? []).filter(({ evaluatedAt }) => evaluatedAt === when).map(({ path }) => path);
    expect(at(second, t0 + day).filter((path) => measuredFirst.includes(path))).toHaveLength(1);
    expect(at(second, t0 + day)).toHaveLength(3);
    expect(second?.pending).toBe(true);
    expect(complete()).toBe(false);
    const { census: third } = await run(t0 + day + hour, { maxCheckouts: 3 });
    expect(third?.finds.every(({ evaluatedAt }) => evaluatedAt >= t0 + day)).toBe(true);
    expect(third?.pending).toBe(false);
    expect(complete()).toBe(true);
  });

  it('measures the others when one checkout exhausts the budget every run, and leaves that one not measured', async () => {
    const slow = join(home, 'dev', 'fresh');
    const real = {
      readNames: (path: string) => readdir(path),
      isDirectory: async (path: string) => (await lstat(path)).isDirectory(),
      realpath: (path: string) => realpath(path),
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
    const io = {
      ...real,
      readNames: async (path: string) => {
        if (path === join(slow, 'apps')) vi.setSystemTime(Date.now() + 100_000);
        return real.readNames(path);
      },
    };
    const complete = () =>
      discoveryReport({
        scan: readDiscoveryScanFile(),
        census: readDiscoveryCensusFile(),
        setting: { value: [join(home, 'dev', 'tools')], error: null },
        home,
        canonical: null,
      }).complete;
    await run(t0, { io });
    const { census } = await run(t0 + hour, { io });
    const of = (name: string) => census?.finds.find(({ path }) => path.endsWith(name));
    expect(of('/dev/old')?.evaluatedAt).toBe(t0 + hour);
    expect(of('/dev/fresh')).toMatchObject({ evaluatedAt: 0, measuredDirs: 0 });
    expect(census?.pending).toBe(true);
    expect(complete()).toBe(false);
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
      realpath: (path: string) => realpath(path),
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
      realpath: (path: string) => realpath(path),
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
      writeFileSync(join(gitDir, 'gitdir'), `${join(home, 'dev', 'fresh', '.git')}\n`);
      writeFileSync(join(home, 'dev', 'fresh', '.git'), `gitdir: ${gitDir}\n`);
      expect((await git())['/dev/fresh']).toBe(at('2026-04-01T00:00:00Z').getTime());
    });

    it('accepts a relative gitdir that validates', async () => {
      const gitDir = join(base, 'main', '.git', 'worktrees', 'fresh');
      touch(join(gitDir, 'HEAD'), at('2026-05-01T00:00:00Z'));
      writeFileSync(join(gitDir, 'gitdir'), `${join(home, 'dev', 'fresh', '.git')}\n`);
      writeFileSync(join(home, 'dev', 'fresh', '.git'), `gitdir: ${relative(join(home, 'dev', 'fresh'), gitDir)}\n`);
      expect((await git())['/dev/fresh']).toBe(at('2026-05-01T00:00:00Z').getTime());
    });

    it('is unknown for a .git/worktrees directory that does not name this checkout back, however it is named', async () => {
      const foreign = join(base, 'main', '.git', 'worktrees', 'foreign');
      touch(join(foreign, 'HEAD'), at('2026-04-01T00:00:00Z'));
      writeFileSync(join(foreign, 'gitdir'), `${join(base, 'somewhere', 'else', '.git')}\n`);
      writeFileSync(join(home, 'dev', 'fresh', '.git'), `gitdir: ${foreign}\n`);
      expect((await git())['/dev/fresh']).toBeNull();
    });

    it('is unknown when a component of the git directory is a symlink', async () => {
      const target = join(base, 'real', '.git', 'worktrees', 'fresh');
      touch(join(target, 'HEAD'), at('2026-04-01T00:00:00Z'));
      writeFileSync(join(target, 'gitdir'), `${join(home, 'dev', 'fresh', '.git')}\n`);
      symlinkSync(join(base, 'real'), join(base, 'link'));
      const viaLink = join(base, 'link', '.git', 'worktrees', 'fresh');
      writeFileSync(join(home, 'dev', 'fresh', '.git'), `gitdir: ${viaLink}\n`);
      expect((await git())['/dev/fresh']).toBeNull();
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

  describe('finds whose validity could not be established', () => {
    it('are kept as unchecked with their earlier measurement and age, and make the census retry within the hour', async () => {
      const { census: first } = await run(t0);
      expect(first?.pending).toBe(false);
      const scanRules = await import('../workspace/scan-rules.ts');
      const real = scanRules.scanEntryValid;
      vi.spyOn(scanRules, 'scanEntryValid').mockImplementation(async (path, options) =>
        path.endsWith(join('dev', 'fresh')) || path.endsWith('.mytool') ? 'pending' : real(path, options),
      );
      const { census } = await run(t0 + day);
      const unchecked = census?.finds.filter(({ kind }) => kind === 'unchecked') ?? [];
      expect(unchecked.map(({ path }) => path.slice(home.length)).toSorted()).toEqual(['/.mytool', '/dev/fresh']);
      for (const find of unchecked) expect(find).toMatchObject({ evaluatedAt: t0, measuredDirs: 1 });
      expect(census?.pending).toBe(true);
      expect(census?.finds.some(({ path }) => path.endsWith('/dev/old'))).toBe(true);
    });

    it('list a find whose metadata read was denied as unchecked, keep the census pending, and never print that everything is managed', async () => {
      const { REAL_RECOGNITION_IO } = await import('../workspace/scan-rules.ts');
      const real = REAL_RECOGNITION_IO.lstat;
      vi.spyOn(REAL_RECOGNITION_IO, 'lstat').mockImplementation(async (path) => {
        if (path.endsWith('.mytool') || path.endsWith(join('dev', 'fresh')))
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return real(path);
      });
      const { census } = await run(t0);
      expect(
        census?.finds
          .filter(({ kind }) => kind === 'unchecked')
          .map(({ path }) => path.slice(home.length))
          .toSorted(),
      ).toEqual(['/.mytool', '/dev/fresh']);
      expect(census?.pending).toBe(true);
      const report = discoveryReport({
        scan: readDiscoveryScanFile(),
        census: readDiscoveryCensusFile(),
        setting: { value: [join(home, 'dev', 'tools')], error: null },
        home,
        canonical: null,
      });
      expect(report.groups.filter(({ kind }) => kind === 'unchecked').map(({ command }) => command)).toEqual([
        null,
        null,
      ]);
      expect(report.complete).toBe(false);
    });

    it('list a find whose manifest no longer parses as unchecked, keep the census pending, and never print that everything is managed', async () => {
      writeFileSync(join(home, 'dev', 'fresh', 'package.json'), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> main\n');
      const { census } = await run(t0);
      expect(
        census?.finds.filter(({ kind }) => kind === 'unchecked').map(({ path }) => path.slice(home.length)),
      ).toEqual(['/dev/fresh']);
      expect(census?.pending).toBe(true);
      const report = discoveryReport({
        scan: readDiscoveryScanFile(),
        census: readDiscoveryCensusFile(),
        setting: { value: [join(home, 'dev', 'tools')], error: null },
        home,
        canonical: null,
      });
      expect(report.complete).toBe(false);
    });

    it('drop a find that is no longer a project, as only that proves it gone', async () => {
      writeFileSync(join(home, 'dev', 'fresh', 'package.json'), JSON.stringify({ dependencies: {} }));
      const { census } = await run(t0);
      expect(census?.finds.some(({ path }) => path.endsWith('/dev/fresh'))).toBe(false);
    });

    it('keep a find whose manifest stops parsing at the next full scan, record its folder unreadable, and list it as unchecked', async () => {
      writeFileSync(join(home, 'dev', 'fresh', 'package.json'), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> main\n');
      await scanAt(t0 + 8 * day);
      const scanned = readDiscoveryScanFile();
      const fresh = join(home, 'dev', 'fresh');
      expect(scanned.status === 'read' && scanned.scan?.found).toContain(fresh);
      expect(scanned.status === 'read' && scanned.scan?.unreadable).toContain(fresh);
      const { census } = await run(t0 + 8 * day);
      expect(census?.finds.find(({ path }) => path === fresh)).toMatchObject({ kind: 'unchecked' });
      expect(census?.pending).toBe(true);
      expect(
        discoveryReport({
          scan: scanned,
          census: readDiscoveryCensusFile(),
          setting: { value: [join(home, 'dev', 'tools')], error: null },
          home,
          canonical: null,
        }).complete,
      ).toBe(false);
    });

    it('make a checkout whose layout could not be read retried within the hour, not the day', async () => {
      const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const { census } = await run(t0, {
        io: {
          readNames: async (path) => {
            if (path.endsWith(join('dev', 'old', 'android'))) throw denied;
            return readdir(path);
          },
          isDirectory: async (path) => (await lstat(path)).isDirectory(),
          realpath: (path) => realpath(path),
          lstat: async (path) => {
            const info = await lstat(path);
            return { kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', mtimeMs: info.mtimeMs };
          },
          head: async () => null,
        },
      });
      expect(census?.finds.find(({ path }) => path.endsWith('/dev/old'))?.unreadable).toBe(true);
      expect(census?.pending).toBe(true);
      expect(censusDue(census, census?.scanRanAt ?? 0, census?.roots ?? [], t0 + hour)).toBe(true);
    });
  });

  describe('a walk whose du exited with status 1', () => {
    afterEach(() => resetExecutor());

    it('is recorded as measured with a lower bound, read back as partial, and worded as at least', async () => {
      const real = getExecutor();
      setExecutor({
        ...real,
        runFileAsync: async (file, args, options) => {
          if (file === 'du' || args.includes('du'))
            throw Object.assign(new Error('du: Permission denied'), { status: 1, stdout: '12\t/walked\n' });
          return real.runFileAsync(file, args, options);
        },
      });
      const { census } = await run(t0);
      const find = census?.finds.find(({ path }) => path.endsWith('/dev/old'));
      expect(find).toMatchObject({ measuredDirs: 1, failedDirs: 0, partialDirs: 1, bytes: 12 * 1024 });
      const dir = join(home, 'dev', 'old', 'android', 'build');
      expect(
        await diskUsage.refreshMeasure(dir, { timeoutMs: 1000, maxAgeMs: 86_400_000, knownToExist: true }),
      ).toMatchObject({
        outcome: 'fresh',
        partial: true,
      });
      expect(readDiskUsage(dir)).not.toHaveProperty('partial');
      const report = discoveryReport({
        scan: readDiscoveryScanFile(),
        census: readDiscoveryCensusFile(),
        setting: { value: [join(home, 'dev', 'tools')], error: null },
        home,
        canonical: null,
      });
      expect(report.groups[0]).toMatchObject({ partial: 2 });
      expect(discoveryLines(report, home).join('\n')).toContain('at least');
      expect(lowDiskLine(report, home)).toContain('at least');
    });
  });

  describe('below a configured root', () => {
    const under = (root: string) =>
      saveConfig({ version: 2, projects: {}, repos: {}, maintenance: { discoverRoots: [root] } });
    const reportOf = (root: string) =>
      discoveryReport({
        scan: readDiscoveryScanFile(),
        census: readDiscoveryCensusFile(),
        setting: { value: [root], error: null },
        home,
        canonical: null,
      });

    it('lists a find two levels down with an adopt command for its own parent, and not a direct child discovery selected', async () => {
      const root = join(home, '.exact');
      checkout(join(root, 'direct'));
      await scanAt(t0 + hour);
      under(root);
      const { census } = await run(t0 + hour);
      const names = (census?.finds ?? []).map(({ path }) => path.slice(home.length)).toSorted();
      expect(names).toContain('/.exact/exact2/a');
      expect(names).not.toContain('/.exact/direct');
      const group = reportOf(root).groups.find(({ folder }) => folder === join(root, 'exact2'));
      expect(group?.command).toContain(JSON.stringify([root, join(root, 'exact2')]));
    });

    it('keeps a find whose metadata read was denied as unchecked', async () => {
      const root = join(home, '.exact');
      under(root);
      const { REAL_RECOGNITION_IO } = await import('../workspace/scan-rules.ts');
      const real = REAL_RECOGNITION_IO.lstat;
      vi.spyOn(REAL_RECOGNITION_IO, 'lstat').mockImplementation(async (path) => {
        if (path.endsWith(join('exact2', 'b'))) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return real(path);
      });
      const { census } = await run(t0);
      expect(census?.finds.find(({ path }) => path.endsWith(join('exact2', 'b')))).toMatchObject({ kind: 'unchecked' });
      expect(census?.pending).toBe(true);
    });
  });

  describe('errors from measuring', () => {
    it('lets an unverified child cleanup propagate as the same object', async () => {
      const failure = Object.assign(new Error('unverified'), { reportCleanup: true });
      vi.spyOn(diskUsage, 'refreshMeasure').mockRejectedValue(failure);
      await expect(run(t0)).rejects.toBe(failure);
    });

    it('lets an unverified child cleanup propagate even when the operation was aborted, as the same object', async () => {
      const failure = Object.assign(new Error('unverified'), { reportCleanup: true });
      const controller = new AbortController();
      vi.spyOn(diskUsage, 'refreshMeasure').mockImplementation(async () => {
        controller.abort();
        throw failure;
      });
      await expect(run(t0, {}, testContext({ signal: controller.signal }))).rejects.toBe(failure);
    });

    it('passes every measured directory to refreshMeasure as known to exist, so no synchronous probe runs on it', async () => {
      const refresh = vi.spyOn(diskUsage, 'refreshMeasure');
      await run(t0);
      expect(refresh).toHaveBeenCalled();
      for (const [, options] of refresh.mock.calls) expect(options.knownToExist).toBe(true);
    });

    it('contains any other error, returns its message and writes nothing', async () => {
      vi.spyOn(diskUsage, 'refreshMeasure').mockRejectedValue(new Error('disk exploded'));
      const { result, census } = await run(t0);
      expect(result).toBe('disk exploded');
      expect(census).toBeNull();
    });
  });
});
