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
import { dirname, join } from 'node:path';
import { configDir } from '@stim-cli/core';
import {
  archiveDir,
  diskUsageCacheFile,
  gitMergeCacheFile,
  gcLogFile,
  maintenanceStateFile,
  pullRequestCacheFile,
  worktreeArchiveRoot,
} from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { listMountedVolumes } from '../fs-util.ts';
import { deviceLeasePath, LEASE_VERSION } from '../engine/device-lease.ts';
import { executeAction, type ActContext } from '../stimd/passes/act.ts';
import * as measurements from '../stimd/passes/measure.ts';
import { planPrune } from '../stimd/passes/prune.ts';
import { planRecords } from '../stimd/passes/records.ts';
import { runMaintenance } from '../stimd/passes/run.ts';
import { testContext } from './_context.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import * as inUse from '../workspace/in-use.ts';
import { liveClaimOwner, plantClaim } from './_factories.ts';

const DAY_MS = 86_400_000;

let home: string;
let projects: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-maintenance-prune-')));
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-maintenance-prune-projects-')));
  process.env.STIM_HOME = home;
  process.env.STIM_DAEMON = 'on';
  process.env.STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES = 'false';
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const real = getExecutor();
  setExecutor({
    ...real,
    run: () => '',
    runQuiet: () => null,
    runFile: (file, args, opts) => (file === 'du' || file === 'git' ? real.runFile(file, args, opts) : ''),
    runFileQuiet: (file, args, opts) =>
      ['git', 'ps', 'lsof'].includes(file) ? real.runFileQuiet(file, args, opts) : null,
    findExecutable: (name) => (name === 'gh' ? null : real.findExecutable(name)),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
  vi.spyOn(measurements, 'sizeScanDeferred').mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (key.startsWith('STIM_MAINTENANCE') || key.startsWith('STIM_DISK_')) delete process.env[key];
  delete process.env.STIM_HOME;
  process.env.STIM_DAEMON = 'off';
  process.exitCode = 0;
});

const context: ActContext = { settings: resolveMaintenanceSettings(), protectedRoot: '' };

function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('nothing was planned');
  return item;
}

const plan = () => planPrune({ now: Date.now(), mounted: listMountedVolumes() });

function seedStatusCache(file: string, path: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ path }));
  return file;
}

function seedLease(id: string, holder: string, expiresInMs: number): string {
  const path = deviceLeasePath('android', id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: LEASE_VERSION,
      platform: 'android',
      id,
      deviceName: null,
      holder,
      token: 'token',
      grantedAt: null,
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    }),
  );
  return path;
}

function seedArchive(id: string, ageDays: number, logBytes = 5): string {
  const dir = archiveDir(id);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'logs', 'metro.ndjson'), 'bytes');
  writeFileSync(
    join(dir, 'archive.json'),
    JSON.stringify({
      id,
      projectRoot: '/gone',
      project: 'gone',
      workspace: 'gone',
      removedAt: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
      removedBy: 'gc',
      lastUsedAt: null,
      worktree: { repository: null, branch: null, head: null, subject: null, merged: null, pullRequest: null },
      builds: { count: 0, last: null, lastErrorCount: 0 },
      agents: [],
      bytes: { logs: logBytes, recordings: 0, agentActions: 0, record: 500, total: 500 + logBytes },
      expires: { logs: null, recordings: null, agentActions: null, record: null },
      version: 1,
    }),
  );
  return dir;
}

function seedWorktreeArchive(name: string, ageDays: number): string {
  const dir = join(worktreeArchiveRoot(), 'repo', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ createdAt: new Date(Date.now() - ageDays * DAY_MS) }));
  return dir;
}

describe('status caches', () => {
  test('a file whose folder is provably gone is planned, and every file Stim cannot show stale is kept with its reason', async () => {
    const live = join(projects, 'live');
    mkdirSync(live);
    const gone = join(projects, 'gone');
    const stale = [
      seedStatusCache(diskUsageCacheFile(gone), gone),
      seedStatusCache(gitMergeCacheFile(gone), gone),
      seedStatusCache(pullRequestCacheFile(gone), gone),
    ];
    const present = seedStatusCache(gitMergeCacheFile(live), live);
    const unmounted = seedStatusCache(diskUsageCacheFile('/Volumes/never-mounted/app'), '/Volumes/never-mounted/app');
    const foreign = join(dirname(gitMergeCacheFile(live)), `${'0'.repeat(32)}.json`);
    writeFileSync(foreign, JSON.stringify({ path: gone }));

    const { actions, skips } = await plan();

    expect(actions.filter((action) => action.kind === 'would-delete-status-caches').map((a) => a.target)).toEqual(
      expect.arrayContaining(stale.map((file) => dirname(file))),
    );
    expect(skips).toContainEqual(
      expect.objectContaining({
        target: dirname(foreign),
        reason: '1 entry kept: the file records no readable path of its own',
        code: 'unreadable',
      }),
    );
    expect(skips).toContainEqual(
      expect.objectContaining({
        target: dirname(unmounted),
        reason: '1 entry kept: the volume of the folder it measures is not mounted',
        code: 'unmounted',
      }),
    );
    for (const file of [present, unmounted, foreign, ...stale]) expect(existsSync(file)).toBe(true);
  });

  test('the action keeps a file whose folder came back after the plan, and deletes the rest', async () => {
    const back = join(projects, 'back');
    const gone = join(projects, 'gone');
    const backFile = seedStatusCache(gitMergeCacheFile(back), back);
    const goneFile = seedStatusCache(gitMergeCacheFile(gone), gone);
    const { actions } = await plan();
    mkdirSync(back);

    const outcome = await executeAction(only(actions), context);

    expect(outcome.status).toBe('done');
    expect(existsSync(goneFile)).toBe(false);
    expect(existsSync(backFile)).toBe(true);
  });
});

describe('process locks', () => {
  test('only a lock directory that holds nothing is planned and deleted', async () => {
    const locks = join(configDir(), 'process-locks');
    mkdirSync(join(locks, 'a'.repeat(64), '.stim'), { recursive: true });
    mkdirSync(join(locks, 'worktrees', 'b'.repeat(64)), { recursive: true });
    mkdirSync(join(locks, 'c'.repeat(64), '.stim', 'claims'), { recursive: true });
    writeFileSync(join(locks, 'c'.repeat(64), '.stim', 'claims', 'claim.json'), '{}');

    const { actions } = await plan();
    expect(actions).toEqual([expect.objectContaining({ kind: 'would-delete-process-locks', target: locks })]);

    expect((await executeAction(only(actions), context)).detail).toBe('2 deleted');
    expect(existsSync(join(locks, 'a'.repeat(64)))).toBe(false);
    expect(existsSync(join(locks, 'worktrees', 'b'.repeat(64)))).toBe(false);
    expect(existsSync(join(locks, 'c'.repeat(64), '.stim', 'claims', 'claim.json'))).toBe(true);
    expect((await plan()).actions).toEqual([]);
  });
});

describe('device leases', () => {
  test("an expired lease is planned; a live, an unparseable and a pinned holder's lease are kept", async () => {
    const expired = seedLease('gone-holder', join(projects, 'removed'), -60_000);
    const live = seedLease('live', join(projects, 'removed'), 600_000);
    const broken = deviceLeasePath('ios', 'broken');
    writeFileSync(broken, 'not json');
    const pinnedRoot = join(projects, 'pinned');
    mkdirSync(pinnedRoot);
    writeFileSync(join(pinnedRoot, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
    const pinned = seedLease('pinned', pinnedRoot, -60_000);

    const { actions, skips } = await plan();

    expect(actions.map((action) => action.target)).toEqual([expired]);
    expect(skips).toContainEqual(
      expect.objectContaining({ target: pinned, reason: expect.stringContaining('pinned by maintenance.keep') }),
    );
    expect(skips).toContainEqual(expect.objectContaining({ target: broken, code: 'lease' }));
    for (const file of [expired, live, broken, pinned]) expect(existsSync(file)).toBe(true);
  });

  test('a workspace in use keeps its expired lease', async () => {
    const holder = join(projects, 'running');
    mkdirSync(holder);
    const lease = seedLease('running', holder, -60_000);
    vi.spyOn(inUse, 'workspaceInUseAsync').mockResolvedValue(['its dev server is running']);

    const { actions, skips } = await plan();

    expect(actions).toEqual([]);
    expect(skips).toContainEqual(
      expect.objectContaining({ target: lease, reason: expect.stringContaining('its dev server is running') }),
    );
  });

  test('a lease renewed after the plan is kept', async () => {
    const lease = seedLease('renewed', join(projects, 'removed'), -60_000);
    const { actions } = await plan();
    seedLease('renewed', join(projects, 'removed'), 600_000);

    const outcome = await executeAction(only(actions), context);

    expect(outcome.status).toBe('kept');
    expect(existsSync(lease)).toBe(true);
  });
});

describe('archives', () => {
  test('an archive past maxAgeDays, an expired part of a kept one and an old worktree archive are planned; fresh ones are kept', async () => {
    const old = seedArchive('old', 40);
    const partlyOld = seedArchive('partly-old', 20);
    const fresh = seedArchive('fresh', 1);
    const oldWorktree = seedWorktreeArchive('old-branch', 40);
    const freshWorktree = seedWorktreeArchive('fresh-branch', 1);

    const { actions } = await plan();
    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'would-delete-expired-archives',
        target: join(configDir(), 'archive'),
        reason:
          '1 archived workspace, 1 archived log, recording or agent action set, 1 worktree archive outlived archive.maxAgeDays, archive.maxCount or their own archive age limit',
      }),
    ]);

    expect((await executeAction(only(actions), context)).status).toBe('done');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldWorktree)).toBe(false);
    expect(existsSync(join(partlyOld, 'archive.json'))).toBe(true);
    expect(existsSync(join(partlyOld, 'logs'))).toBe(false);
    expect(existsSync(join(fresh, 'logs', 'metro.ndjson'))).toBe(true);
    expect(existsSync(freshWorktree)).toBe(true);
    expect((await plan()).actions).toEqual([]);
  });

  test('a worktree archive that a live claim holds is kept', async () => {
    const dir = seedWorktreeArchive('held', 40);
    plantClaim(`${dir}.claims`, 'exclusive', liveClaimOwner());

    expect((await plan()).actions).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test('an invalid archive setting is a kept reason, not a deletion', async () => {
    seedArchive('old', 40);
    process.env.STIM_ARCHIVE_MAX_AGE_DAYS = 'soon';

    const { actions, skips } = await plan();

    expect(actions).toEqual([]);
    expect(skips).toContainEqual(
      expect.objectContaining({ target: join(configDir(), 'archive'), reason: expect.stringContaining('archive') }),
    );
    delete process.env.STIM_ARCHIVE_MAX_AGE_DAYS;
  });

  test('a recording kept by stim-server in its workspace directory is not touched', async () => {
    seedArchive('old', 40);
    const recording = join(configDir(), 'workspaces', 'w1', 'recordings', 'ios-default', '1-2.seg');
    mkdirSync(dirname(recording), { recursive: true });
    writeFileSync(recording, 'bytes');
    utimesSync(recording, new Date(0), new Date(0));

    const { actions } = await plan();
    await executeAction(only(actions.filter((action) => action.kind === 'would-delete-expired-archives')), context);

    expect(existsSync(recording)).toBe(true);
  });
});

test('the daily sweep prunes all four, logs each prune and each keep, and a report pass deletes nothing', async () => {
  const gone = join(projects, 'gone');
  const live = join(projects, 'live');
  mkdirSync(live);
  const stale = seedStatusCache(gitMergeCacheFile(gone), gone);
  const present = seedStatusCache(gitMergeCacheFile(live), live);
  const expired = seedLease('expired', join(projects, 'removed'), -60_000);
  const archive = seedArchive('old', 40);
  const lockDir = join(configDir(), 'process-locks', 'd'.repeat(64));
  mkdirSync(lockDir, { recursive: true });

  process.env.STIM_DAEMON = 'report';
  await runMaintenance('test', { report: true });
  for (const path of [stale, present, expired, archive, lockDir]) expect(existsSync(path)).toBe(true);
  rmSync(maintenanceStateFile(), { force: true });

  process.env.STIM_DAEMON = 'on';
  expect(resolveMaintenanceSettings().mode).toBe('on');
  await runMaintenance('test');

  for (const path of [stale, expired, archive, lockDir]) expect(existsSync(path)).toBe(false);
  expect(existsSync(present)).toBe(true);
  const records = readFileSync(gcLogFile(), 'utf8')
    .trim()
    .split('\n')
    .map((line): { event: string; kind?: string } => JSON.parse(line));
  expect(records.filter((record) => record.event === 'gc_item').map((record) => record.kind)).toEqual(
    expect.arrayContaining(['statusCache', 'deviceLease', 'archive', 'homeEntry']),
  );
});

test('a pass that stimd aborts while it lists devices plans no device action and ends at once', async () => {
  upsertProject(join(projects, 'gone'), {
    platforms: { ios: { deviceUdid: 'U-GONE', owned: true, deviceName: 'stim-gone' } },
  });
  const controller = new AbortController();
  let listing = false;
  setExecutor({
    ...getExecutor(),
    runFileAsync: (file, _args, opts) =>
      new Promise((_resolve, reject) => {
        if (file !== 'xcrun') return reject(new Error(`unexpected ${file}`));
        listing = true;
        opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
      }),
  });
  const operation = testContext({ env: { ...process.env, STIM_HOME: undefined }, signal: controller.signal });

  const planned = planRecords({ devices: true, background: true, operation }).then(
    (result) => result.actions,
    () => [],
  );
  await vi.waitFor(() => expect(listing).toBe(true));
  controller.abort();

  expect((await planned).filter((action) => action.kind === 'would-delete-orphaned-devices')).toEqual([]);
});
