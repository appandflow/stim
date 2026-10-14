import { execSync } from 'node:child_process';
import {
  existsSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceDir, maintenanceStateFile, readMaintenanceState } from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import * as measurements from '../maintenance/measure.ts';
import { diskPressureLevel, levelStillShort } from '../maintenance/pressure.ts';
import { runMaintenance } from '../maintenance/run.ts';
import { triggerMaintenance } from '../maintenance/trigger.ts';
import { ensureWorkspaceStorage, workspaceStateFile } from '../workspace/paths.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';

const GB = 1024;
const MINUTE_MS = 60_000;

let home: string;
let projects: string;

function freeDisk(gb: number, after = gb) {
  vi.spyOn(measurements, 'measurePressure').mockReturnValue({
    disk: [{ volume: '/', freeMb: gb * GB }],
    memory: { level: 'normal', availableBytes: null, pressured: false },
    warningSince: null,
  });
  vi.spyOn(measurements, 'measureDisk').mockReturnValue([{ volume: '/', freeMb: after * GB }]);
}

async function pass() {
  rmSync(maintenanceStateFile(), { force: true });
  await runMaintenance('test');
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-maintenance-levels-')));
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-maintenance-levels-projects-')));
  process.env.STIM_HOME = home;
  process.env.STIM_MAINTENANCE = 'on';
  process.env.STIM_BUDGET_MIN_FREE_DISK_GB = '20';
  process.env.STIM_BUDGET_HARD_FLOOR_DISK_GB = '5';
  process.env.STIM_MAINTENANCE_SWEEP_HOURS = '0';
  process.env.STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES = 'false';
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
  vi.spyOn(measurements, 'sizeScanDeferred').mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (key.startsWith('STIM_MAINTENANCE') || key.startsWith('STIM_BUDGET_')) delete process.env[key];
  delete process.env.STIM_HOME;
  delete process.env.STIM_GC_WORKTREE_GRACE_MINUTES;
  process.exitCode = 0;
});

function age(path: string, at: Date) {
  utimesSync(path, at, at);
}

function ageTree(path: string, at: Date) {
  let entries: string[] = [];
  try {
    entries = readdirSync(path);
  } catch {}
  for (const name of entries) ageTree(join(path, name), at);
  utimesSync(path, at, at);
}

function outputsWorkspace(name: string, usedMinutesAgo: number) {
  const root = join(projects, name);
  mkdirSync(root, { recursive: true });
  const dir = ensureWorkspaceStorage(root);
  mkdirSync(join(dir, 'derived-data'), { recursive: true });
  writeFileSync(join(dir, 'derived-data', 'blob'), 'x'.repeat(4096));
  upsertProject(root, { metroPort: 8100 });
  recordWorkspaceUse(root, new Date(Date.now() - usedMinutesAgo * MINUTE_MS));
  return { root, outputs: join(dir, 'derived-data') };
}

test('pressure levels follow the floors, and level 2 runs until free disk is back above the budget floor', () => {
  const budget = { minFreeDiskMb: 20 * GB, hardFloorDiskMb: 5 * GB };
  const settings = { urgentFreeDiskGb: 12, criticalFreeDiskGb: 6 };
  expect([25, 19, 11, 5.5, 4].map((gb) => diskPressureLevel(gb * GB, budget, settings))).toEqual([0, 1, 2, 3, 3]);
  expect(diskPressureLevel(7 * GB, { ...budget, hardFloorDiskMb: 8 * GB }, settings)).toBe(3);
  expect(levelStillShort({ level: 2 }, 15 * GB, budget, settings)).toBe(true);
  expect(levelStillShort({ level: 2 }, 21 * GB, budget, settings)).toBe(false);
  expect(levelStillShort({ level: 3 }, 7 * GB, budget, settings)).toBe(false);
  expect(levelStillShort({ level: 3 }, 5.5 * GB, budget, settings)).toBe(true);
});

test('when level 1 cannot get back above the floor, level 2 clears outputs older than the short window', async () => {
  const halfHour = outputsWorkspace('half-hour', 30);
  const justNow = outputsWorkspace('just-now', 1);
  freeDisk(15);

  await pass();

  expect(existsSync(halfHour.outputs)).toBe(false);
  expect(existsSync(justNow.outputs)).toBe(true);
  expect(readMaintenanceState()?.pressure?.diskLevel).toBe(1);
});

test('level 2 actions stop once free disk is back above the floor', async () => {
  const halfHour = outputsWorkspace('half-hour', 30);
  freeDisk(15, 25);

  await pass();

  expect(existsSync(halfHour.outputs)).toBe(true);
});

function repoWithFeatureWorktree({ linkIos = false, nested = false }: { linkIos?: boolean; nested?: boolean } = {}) {
  const repo = join(projects, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
  git('init -q -b main');
  git('config user.email test@example.com');
  git('config user.name test');
  mkdirSync(join(repo, 'android', 'build'), { recursive: true });
  writeFileSync(join(repo, 'android', 'build', 'tracked.txt'), 'tracked');
  writeFileSync(join(repo, 'package.json'), '{}');
  git('add -A');
  git('commit -q -m init');
  const feature = nested ? join(repo, '.worktrees', 'feature') : join(projects, 'feature');
  git(`worktree add -q "${feature}" -b feature`);
  for (const base of [repo, feature]) {
    write(join(base, 'ios', 'build', 'App.app', 'binary'));
    write(join(base, 'node_modules', 'pkg', 'index.js'));
    write(join(base, 'apps', 'desktop', '.build', 'debug', 'binary'));
  }
  if (linkIos) {
    write(join(feature, 'shared', 'build', 'keep.txt'));
    git('add shared', feature);
    git('commit -q -m shared', feature);
    rmSync(join(feature, 'ios'), { recursive: true });
    symlinkSync('shared', join(feature, 'ios'));
  }
  const roots = { repo: realpathSync.native(repo), feature: realpathSync.native(feature) };
  for (const root of Object.values(roots)) upsertProject(root, { metroPort: null });
  const yesterday = new Date(Date.now() - 24 * 60 * MINUTE_MS);
  for (const root of Object.values(roots)) {
    recordWorkspaceUse(root, yesterday);
    ageTree(root, yesterday);
    ensureWorkspaceStorage(root);
    age(workspaceStateFile(root), yesterday);
    const gitDir = git('rev-parse --path-format=absolute --git-dir', root);
    for (const file of ['index', 'HEAD', join('logs', 'HEAD')])
      if (existsSync(join(gitDir, file))) age(join(gitDir, file), yesterday);
  }
  return roots;
}

test('level 2 clears only untracked build directories of idle worktrees, and level 3 deletes linked dependencies', async () => {
  const { repo, feature } = repoWithFeatureWorktree();
  write(join(feature, 'android', 'app', 'build', 'fresh.dex'));
  freeDisk(15);

  await pass();

  for (const root of [repo, feature]) {
    expect(existsSync(join(root, 'ios', 'build'))).toBe(false);
    expect(existsSync(join(root, 'apps', 'desktop', '.build'))).toBe(false);
    expect(existsSync(join(root, 'node_modules'))).toBe(true);
  }
  expect(existsSync(join(repo, 'android', 'build', 'tracked.txt'))).toBe(true);
  expect(existsSync(join(feature, 'android', 'app', 'build', 'fresh.dex'))).toBe(true);

  freeDisk(4);
  await pass();

  expect(existsSync(join(feature, 'node_modules'))).toBe(false);
  expect(existsSync(join(repo, 'node_modules'))).toBe(true);
  expect(readMaintenanceState()?.lastPass?.blocked).toEqual(
    expect.arrayContaining([expect.stringContaining('disk pressure level 3')]),
  );
}, 60_000);

test('a build directory reached through a linked parent is kept', async () => {
  const { feature } = repoWithFeatureWorktree({ linkIos: true });
  freeDisk(15);

  await pass();

  expect(existsSync(join(feature, 'shared', 'build', 'keep.txt'))).toBe(true);
  expect(existsSync(join(feature, 'apps', 'desktop', '.build'))).toBe(false);
}, 60_000);

test('a worktree nested inside another is judged from its own git checkout', async () => {
  const { feature } = repoWithFeatureWorktree({ nested: true });
  freeDisk(15);

  await pass();

  expect(existsSync(join(feature, 'android', 'build', 'tracked.txt'))).toBe(true);
  expect(existsSync(join(feature, 'ios', 'build'))).toBe(false);
}, 60_000);

function write(path: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
}

test('a pass that cannot write its state or log still frees space', async () => {
  const old = outputsWorkspace('old', 3 * 24 * 60);
  mkdirSync(maintenanceDir(), { recursive: true });
  writeFileSync(join(maintenanceDir(), 'state.lock.claims'), 'not a directory');
  freeDisk(15);

  await runMaintenance('test');

  expect(existsSync(old.outputs)).toBe(false);
});

test('the next command warns on stderr while disk pressure is at level 3, and status --watch does not', () => {
  mkdirSync(maintenanceDir(), { recursive: true });
  writeFileSync(
    maintenanceStateFile(),
    JSON.stringify({
      version: 1,
      lastAt: { pressure: Date.now() },
      pressure: {
        disk: [{ volume: '/', freeMb: 4 * GB }],
        memory: { level: 'normal', availableBytes: null, pressured: false },
        warningSince: null,
        diskLevel: 3,
      },
      sizes: [],
      lastPass: null,
      recent: [],
      plan: [],
    }),
  );
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
  delete process.env.STIM_MAINTENANCE;

  triggerMaintenance('status-watch', { argv: ['status', '--watch'], warn: false });
  expect(errors).toEqual([]);
  triggerMaintenance('ios', { argv: ['ios'] });
  expect(errors).toEqual([expect.stringContaining('disk pressure level 3 (4.0 GB free on /)')]);
});
