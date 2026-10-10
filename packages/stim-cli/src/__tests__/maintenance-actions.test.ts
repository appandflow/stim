import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildCacheRoot, metroCacheRoot } from '@stim-cli/core';
import {
  maintenanceNdjsonFile,
  readMaintenanceState,
  sharedCompilationCache,
  type MaintenanceAction,
  type MaintenanceRecord,
} from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { register, readManifest } from '../cache/cache-manifest.ts';
import { pruneCache } from '../cache/caches.ts';
import * as buildLocks from '../engine/build-lock.ts';
import { executeAction, type ActContext } from '../maintenance/act.ts';
import * as measurements from '../maintenance/measure.ts';
import { cacheEntryProtection } from '../maintenance/protect.ts';
import { runMaintenance } from '../maintenance/run.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import * as inUse from '../workspace/in-use.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { recordWorkspaceUse, workspaceLastUsed, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { liveClaimOwner, plantClaim } from './_factories.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

let home: string;
let projects: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-maintenance-actions-')));
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-maintenance-projects-')));
  process.env.STIM_HOME = home;
  process.env.STIM_MAINTENANCE = 'on';
  process.env.STIM_GC_WORKTREE_GRACE_MINUTES = '0';
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const real = getExecutor();
  setExecutor({
    ...real,
    run: () => '',
    runQuiet: () => null,
    runFile: (file, args, opts) => (file === 'du' || file === 'git' ? real.runFile(file, args, opts) : ''),
    runFileQuiet: (file, args, opts) => (file === 'git' ? real.runFileQuiet(file, args, opts) : null),
    findExecutable: (name) => (name === 'gh' ? null : real.findExecutable(name)),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
  vi.spyOn(measurements, 'measurePressure').mockReturnValue({
    disk: [{ volume: '/', freeMb: 500 * 1024 }],
    memory: { level: 'normal', availableBytes: null, pressured: false },
    warningSince: null,
  });
  vi.spyOn(measurements, 'sizeScanDeferred').mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (key.startsWith('STIM_MAINTENANCE') || key.startsWith('STIM_CACHES_') || key.startsWith('STIM_BUDGET_'))
      delete process.env[key];
  delete process.env.STIM_HOME;
  delete process.env.STIM_GC_WORKTREE_GRACE_MINUTES;
  process.exitCode = 0;
});

function ago(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function cacheEntry(root: string, platform: string, key: string, daysAgo: number): string {
  const dir = join(root, platform, key);
  mkdirSync(join(dir, 'App.app'), { recursive: true });
  writeFileSync(join(dir, 'App.app', 'blob'), 'x'.repeat(MB));
  utimesSync(dir, new Date(), ago(daysAgo));
  return dir;
}

const OUTPUTS = ['derived-data', 'gradle-build'];

function workspace(name: string, { usedDaysAgo = 0, kb = 256 }: { usedDaysAgo?: number; kb?: number } = {}) {
  const root = join(projects, name);
  mkdirSync(root, { recursive: true });
  const dir = ensureWorkspaceStorage(root);
  for (const output of OUTPUTS) {
    mkdirSync(join(dir, output), { recursive: true });
    writeFileSync(join(dir, output, 'blob'), 'x'.repeat(kb * 1024));
  }
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'build-ios.ndjson'), '{}\n');
  utimesSync(join(dir, 'logs', 'build-ios.ndjson'), ago(usedDaysAgo), ago(usedDaysAgo));
  recordWorkspaceUse(root, ago(usedDaysAgo));
  upsertProject(root, { metroPort: 8100 });
  return { root, dir };
}

const hasOutputs = (dir: string) => OUTPUTS.some((output) => existsSync(join(dir, output)));

function records(): MaintenanceRecord[] {
  try {
    return readFileSync(maintenanceNdjsonFile(), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MaintenanceRecord);
  } catch {
    return [];
  }
}

function actionKinds(): string[] {
  return records()
    .filter((record) => record.event === 'maintenance_action')
    .map((record) => String((record.action as { kind: string }).kind));
}

function capFixture() {
  const root = buildCacheRoot();
  const entries = {
    oldest: cacheEntry(root, 'ios', 'k-oldest', 3),
    middle: cacheEntry(root, 'ios', 'k-middle', 2),
    pinnedKey: cacheEntry(root, 'ios', 'k-last-build', 5),
    recent: cacheEntry(root, 'ios', 'k-recent', 0),
  };
  const keeper = join(projects, 'keeper');
  mkdirSync(keeper, { recursive: true });
  upsertProject(keeper, { metroPort: 8100 });
  writeWorkspaceState(keeper, { lastIosBuild: { platform: 'ios', cacheKey: 'k-last-build' } });
  const pinned = workspace('pinned', { usedDaysAgo: 15 });
  writeFileSync(join(pinned.root, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
  const spaces = {
    old: workspace('old', { usedDaysAgo: 30 }),
    busy: workspace('busy', { usedDaysAgo: 20 }),
    pinned,
    fresh: workspace('fresh', { usedDaysAgo: 0 }),
  };
  plantClaim(join(workspaceDir(spaces.busy.root), 'native-run.lock'), 'exclusive', liveClaimOwner());
  process.env.STIM_CACHES_BUILD_CACHE_MAX_GB = String(3 / 1024);
  process.env.STIM_MAINTENANCE_WORKSPACE_OUTPUTS_MAX_GB = String(0.4 / 1024);
  process.env.STIM_MAINTENANCE_SWEEP_HOURS = '0';
  process.env.STIM_MAINTENANCE_WORKTREE_CHECK_MINUTES = '1000000';
  process.env.STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES = 'false';
  return { entries, spaces };
}

test('on mode trims over-cap caches oldest first and clears only idle, unpinned, unlocked workspaces', async () => {
  const { entries, spaces } = capFixture();

  await runMaintenance('test');

  expect(existsSync(entries.oldest)).toBe(false);
  expect(existsSync(entries.middle)).toBe(false);
  expect(existsSync(entries.pinnedKey)).toBe(true);
  expect(existsSync(entries.recent)).toBe(true);
  expect(hasOutputs(spaces.old.dir)).toBe(false);
  expect(hasOutputs(spaces.busy.dir)).toBe(true);
  expect(hasOutputs(spaces.pinned.dir)).toBe(true);
  expect(hasOutputs(spaces.fresh.dir)).toBe(true);

  expect(actionKinds().toSorted()).toEqual(['clear-outputs', 'trim-cache']);
  const skipped = records().filter((record) => record.event === 'maintenance_skip');
  expect(skipped.map((record) => String(record.reason ?? ''))).toEqual(
    expect.arrayContaining([expect.stringContaining('pinned by maintenance.keep')]),
  );
  expect(
    skipped.some((record) => String(record.target).includes('busy') || record.workspace === spaces.busy.root),
  ).toBe(true);
  const state = readMaintenanceState()!;
  expect(state.lastPass).toMatchObject({ mode: 'on', actions: 2, stopped: 0 });
  expect(state.lastPass!.freedBytes).toBeGreaterThan(MB);
  expect(records().every((record) => record.mode === 'on')).toBe(true);
  expect(readFileSync(join(workspaceDir(spaces.old.root), 'logs', 'maintenance.ndjson'), 'utf8')).toContain(
    'Cleared build outputs',
  );
});

test('report mode plans the same actions and deletes nothing', async () => {
  process.env.STIM_MAINTENANCE = 'report';
  const { entries, spaces } = capFixture();

  await runMaintenance('test');

  for (const dir of Object.values(entries)) expect(existsSync(dir)).toBe(true);
  for (const space of Object.values(spaces)) expect(hasOutputs(space.dir)).toBe(true);
  const state = readMaintenanceState()!;
  expect(state.lastPass).toMatchObject({ mode: 'report', freedBytes: 0 });
  expect(state.plan.map((action) => action.kind)).toEqual(
    expect.arrayContaining(['would-trim-cache', 'would-clear-outputs']),
  );
  expect(actionKinds()).toEqual(expect.arrayContaining(['would-trim-cache', 'would-clear-outputs']));
  expect(records().every((record) => record.mode === 'report')).toBe(true);
});

test('the age sweep removes only what is provably stale', async () => {
  process.env.STIM_MAINTENANCE_WORKTREE_CHECK_MINUTES = '1000000';
  process.env.STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES = 'false';
  const idle = workspace('idle-ten', { usedDaysAgo: 10 });
  const young = workspace('young-three', { usedDaysAgo: 3 });
  const lockedOld = workspace('old-locked', { usedDaysAgo: 40 });
  plantClaim(join(workspaceDir(lockedOld.root), 'native-run.lock'), 'exclusive', liveClaimOwner());
  const orphan = join(projects, 'deleted-worktree');
  const orphanDir = ensureWorkspaceStorage(orphan);
  writeFileSync(join(orphanDir, 'state.json'), '{}');
  const busyOrphan = join(projects, 'deleted-building');
  const busyOrphanDir = ensureWorkspaceStorage(busyOrphan);
  plantClaim(join(workspaceDir(busyOrphan), 'native-run.lock'), 'exclusive', liveClaimOwner());
  const cache = join(projects, 'shared-cache');
  const oldEntry = join(cache, 'old-entry');
  const newEntry = join(cache, 'new-entry');
  for (const entry of [oldEntry, newEntry]) {
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'blob'), 'x'.repeat(4096));
  }
  utimesSync(oldEntry, new Date(), ago(20));
  register({ dir: cache, name: 'Shared cache' });
  const gone = join(projects, 'removed-cache');
  mkdirSync(gone);
  register({ dir: gone, name: 'Removed cache' });
  rmSync(gone, { recursive: true });

  await runMaintenance('test');

  expect(hasOutputs(idle.dir)).toBe(false);
  expect(hasOutputs(young.dir)).toBe(true);
  expect(hasOutputs(lockedOld.dir)).toBe(true);
  expect(existsSync(orphanDir)).toBe(false);
  expect(existsSync(busyOrphanDir)).toBe(true);
  expect(existsSync(oldEntry)).toBe(false);
  expect(existsSync(newEntry)).toBe(true);
  expect(readManifest().caches.map((entry) => entry.dir)).toEqual([cache]);
  expect(actionKinds().toSorted()).toEqual(['clear-outputs', 'remove-orphan', 'trim-cache', 'unregister-cache']);
});

test('maintenance records in a workspace log do not make the workspace look used', () => {
  const old = workspace('written-by-maintenance', { usedDaysAgo: 30 });
  writeFileSync(join(old.dir, 'logs', 'maintenance.ndjson'), '{}\n');
  expect(Date.now() - workspaceLastUsed(old.root)).toBeGreaterThan(29 * DAY_MS);
});

describe('executing single actions', () => {
  const context = (overrides: Partial<ActContext> = {}): ActContext => ({
    settings: resolveMaintenanceSettings(),
    budget: { minFreeDiskMb: 0, hardFloorDiskMb: 0, maxCommittedMemoryMb: 0, maxLiveWorkspaces: 0 },
    protectedRoot: '/nowhere',
    ...overrides,
  });
  const action = (overrides: Partial<MaintenanceAction>): MaintenanceAction => ({
    kind: 'would-clear-outputs',
    target: '/x',
    bytes: 0,
    reason: 'test',
    ...overrides,
  });

  test('the workspace that started the pass is never cleared', async () => {
    const own = workspace('own', { usedDaysAgo: 30 });
    const outcome = await executeAction(
      action({ target: own.root, workspace: own.root }),
      context({ protectedRoot: own.root }),
    );
    expect(outcome.status).toBe('kept');
    expect(hasOutputs(own.dir)).toBe(true);
  });

  test('the compilation cache is emptied whole only below the hard floor and never beside a live build', async () => {
    const dir = sharedCompilationCache();
    mkdirSync(join(dir, 'objects'), { recursive: true });
    writeFileSync(join(dir, 'objects', 'blob'), 'x'.repeat(4096));
    register({ dir, name: 'Swift compilation cache', prune: 'atomic' });
    const empty = action({ kind: 'would-empty-cache', target: dir, bytes: 4096 });

    vi.spyOn(measurements, 'measureDisk').mockReturnValue([{ volume: '/', freeMb: 10 * 1024 }]);
    const above = await executeAction(empty, context({ budget: { ...context().budget, hardFloorDiskMb: 5 * 1024 } }));
    expect(above.status).toBe('kept');
    expect(existsSync(join(dir, 'objects'))).toBe(true);

    vi.spyOn(measurements, 'measureDisk').mockReturnValue([{ volume: '/', freeMb: 1024 }]);
    const hardFloor = { ...context().budget, hardFloorDiskMb: 5 * 1024 };
    vi.spyOn(buildLocks, 'listBuildLocks').mockReturnValue([
      { alive: true } as ReturnType<typeof buildLocks.listBuildLocks>[number],
    ]);
    expect((await executeAction(empty, context({ budget: hardFloor }))).status).toBe('kept');
    expect(existsSync(join(dir, 'objects'))).toBe(true);

    vi.spyOn(buildLocks, 'listBuildLocks').mockReturnValue([]);
    const emptied = await executeAction(empty, context({ budget: hardFloor }));
    expect(emptied.status).toBe('done');
    expect(existsSync(join(dir, 'objects'))).toBe(false);
  });

  test('a stale registration is kept when its directory exists again', async () => {
    const dir = join(projects, 'back-again');
    mkdirSync(dir);
    register({ dir, name: 'Back again' });
    const outcome = await executeAction(action({ kind: 'would-unregister-cache', target: dir, dir }), context());
    expect(outcome.status).toBe('kept');
    expect(readManifest().caches.map((entry) => entry.dir)).toContain(dir);
  });

  test('Metro entries of a project with a live dev server are not evicted', async () => {
    const live = workspace('live-metro', { usedDaysAgo: 0 });
    writeFileSync(join(live.root, 'package.json'), JSON.stringify({ name: 'live-app' }));
    vi.spyOn(inUse, 'workspaceInUse').mockImplementation((root) =>
      root === live.root ? ['its dev server supervisor (pid 1) is running'] : [],
    );
    const quiet = join(metroCacheRoot(), 'quiet-app');
    const busy = join(metroCacheRoot(), 'live-app');
    for (const store of [quiet, busy]) {
      mkdirSync(join(store, 'ab'), { recursive: true });
      writeFileSync(join(store, 'ab', 'entry'), 'x'.repeat(MB));
      utimesSync(join(store, 'ab', 'entry'), ago(9), ago(9));
    }
    const outcome = await executeAction(
      action({ kind: 'would-trim-cache', target: metroCacheRoot(), dir: metroCacheRoot(), bytes: 2 * MB }),
      context(),
    );
    expect(outcome.status).toBe('done');
    expect(existsSync(join(quiet, 'ab', 'entry'))).toBe(false);
    expect(existsSync(join(busy, 'ab', 'entry'))).toBe(true);
  });
});

describe('pruneCache protection and LRU order', () => {
  test('evictBytes removes the least recently used unprotected entries and stops at the target', () => {
    const root = join(home, 'lru');
    const names = ['a', 'b', 'c', 'd'];
    names.forEach((name, i) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'blob'), 'x'.repeat(1024));
      utimesSync(join(root, name), ago(10 - i), ago(10 - i));
    });
    const result = pruneCache(
      { name: 'lru', dir: root, prune: 'entries', note: '' },
      {
        olderThanDays: 0.01,
        evictBytes: 1,
        protect: (entry) => (basename(entry) === 'a' ? 'in use' : null),
      },
    );
    expect(result.removed).toBe(1);
    expect(result.protectedEntries).toBe(1);
    expect(names.filter((name) => existsSync(join(root, name)))).toEqual(['a', 'c', 'd']);
  });

  test('the newest succeeded build-only artifact of each platform is protected', () => {
    const root = buildCacheRoot();
    const entries = ['k-build-only', 'k-older', 'k-failed'].map((key) => cacheEntry(root, 'ios', key, 9));
    const project = join(projects, 'build-only');
    mkdirSync(project, { recursive: true });
    upsertProject(project, { metroPort: 8100 });
    const run = (cacheKey: string, status: 'ok' | 'failed', startedAt: string) => ({
      platform: 'ios',
      status,
      cacheKey,
      startedAt,
      result: status === 'ok' ? 'succeeded' : 'failed',
    });
    writeWorkspaceState(project, {
      buildHistory: {
        ios: [
          run('k-failed', 'failed', '2026-10-03T00:00:00Z'),
          run('k-build-only', 'ok', '2026-10-02T00:00:00Z'),
          run('k-older', 'ok', '2026-10-01T00:00:00Z'),
        ],
      },
    });
    pruneCache(
      { name: 'builds', dir: join(root, 'ios'), prune: 'entries', note: '' },
      { olderThanDays: 1, byMtime: true, protect: cacheEntryProtection() },
    );
    expect(entries.map((entry) => existsSync(entry))).toEqual([true, false, false]);
  });

  test('without a size target the age cutoff behaves as before', () => {
    const root = join(home, 'age');
    for (const [name, days] of [
      ['old', 9],
      ['new', 1],
    ] as const) {
      mkdirSync(join(root, name), { recursive: true });
      utimesSync(join(root, name), ago(days), ago(days));
    }
    const result = pruneCache({ name: 'age', dir: root, prune: 'entries', note: '' }, { olderThanDays: 7 });
    expect(result.removed).toBe(1);
    expect(existsSync(join(root, 'new'))).toBe(true);
  });
});

function gitRepoWithWorktrees(names: string[]) {
  const repo = join(projects, 'repo');
  const remote = join(projects, 'repo-remote.git');
  mkdirSync(repo, { recursive: true });
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
  git(`init -q --bare "${remote}"`, projects);
  git('init -q');
  git('config user.email test@example.com');
  git('config user.name test');
  git(`remote add origin "${remote}"`);
  writeFileSync(join(repo, 'package.json'), '{}');
  git('add -A');
  git('commit -q -m init');
  git('push -q -u origin HEAD');
  const worktrees: Record<string, string> = {};
  const heads: Record<string, string> = {};
  for (const name of names) {
    const path = join(projects, name);
    git(`worktree add -q "${path}" -b ${name}`);
    writeFileSync(join(path, `${name}.txt`), name);
    if (name === 'pinned') writeFileSync(join(path, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
    git('add -A', path);
    git(`commit -q -m ${name}`, path);
    git(`push -q origin ${name}`, path);
    heads[name] = git('rev-parse HEAD', path);
    worktrees[name] = realpathSync.native(path);
    upsertProject(path, { metroPort: null });
  }
  return { repo, worktrees, heads };
}

test('finished worktrees are removed, except a pinned one and the one the pass started in', async () => {
  const { worktrees, heads } = gitRepoWithWorktrees(['shipped', 'pinned', 'current', 'open']);
  const merged = (name: string, number: number) => [
    {
      number,
      url: `https://github.com/o/r/pull/${number}`,
      state: 'MERGED',
      headRefOid: heads[name],
      mergedAt: '2026-09-01T00:00:00Z',
    },
  ];
  const pulls: Record<string, object[]> = {
    shipped: merged('shipped', 1),
    pinned: merged('pinned', 2),
    current: merged('current', 3),
    open: [{ number: 4, url: 'https://github.com/o/r/pull/4', state: 'OPEN', headRefOid: heads.open }],
  };
  const real = getExecutor();
  setExecutor({
    ...real,
    findExecutable: (name) => (name === 'gh' ? '/usr/bin/gh' : real.findExecutable(name)),
    runFileAsync: async (file, args: string[], opts) => {
      if (file !== 'gh') return real.runFileAsync(file, args, opts);
      const fields = args.flatMap((arg) => {
        const variable = /^(b\d+)=(.*)$/s.exec(arg);
        return variable ? [[variable[1], { nodes: pulls[variable[2]!] ?? [] }]] : [];
      });
      return JSON.stringify({ data: { repository: Object.fromEntries(fields) } });
    },
  });
  process.env.STIM_MAINTENANCE_SWEEP_HOURS = '0';
  process.env.STIM_MAINTENANCE_PROTECT_RECENT_HOURS = '0';
  vi.spyOn(process, 'cwd').mockReturnValue(worktrees.current!);

  await runMaintenance('test');

  expect(existsSync(worktrees.shipped!)).toBe(false);
  expect(existsSync(worktrees.pinned!)).toBe(true);
  expect(existsSync(worktrees.current!)).toBe(true);
  expect(existsSync(worktrees.open!)).toBe(true);
  expect(actionKinds()).toEqual(['remove-worktree']);
  const removed = records().find((record) => record.event === 'maintenance_action')!;
  expect(removed).toMatchObject({ level: 'warn', mode: 'on' });
  expect(removed.workspace).toBeUndefined();
  expect(
    records()
      .filter((record) => record.event === 'maintenance_skip')
      .map((record) => record.reason),
  ).toEqual(
    expect.arrayContaining(['pinned by maintenance.keep', 'the command that started this pass runs inside it']),
  );
}, 60_000);
