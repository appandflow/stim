import { execSync, spawn } from 'node:child_process';
import {
  existsSync,
  symlinkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isJsonObject,
  maintenanceDir,
  maintenanceNdjsonFile,
  maintenanceStateFile,
  readJsonObject,
  readMaintenanceState,
  workspaceLightenedFile,
} from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import * as measurements from '../maintenance/measure.ts';
import { diskPressureLevel, levelStillShort } from '../maintenance/pressure.ts';
import { executeAction } from '../maintenance/act.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';
import { runMaintenance } from '../maintenance/run.ts';
import { liveClaimOwner, plantClaim } from './_factories.ts';
import { triggerMaintenance } from '../maintenance/trigger.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceStateFile } from '../workspace/paths.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import * as memory from '../commands/gc/memory.ts';
import { recordGcResult } from '../commands/gc/results.ts';

function recordedDirs(root: string): unknown {
  return readJsonObject(workspaceLightenedFile(root))?.dirs ?? [];
}

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

function iosRan(minutesAgo: number) {
  return {
    lastIosBuild: {
      platform: 'ios',
      status: 'success',
      startedAt: new Date(Date.now() - minutesAgo * MINUTE_MS).toISOString(),
      durationMs: 0,
    },
  };
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

test('when level 1 cannot get back above the floor, level 2 clears outputs of workspaces that did not run ios, android or macos in the last 15 minutes, dev server or not', async () => {
  const hourAgo = outputsWorkspace('hour-ago', 1);
  writeWorkspaceState(hourAgo.root, { supervisor: { ...liveClaimOwner(), port: 8100 }, ...iosRan(60) });
  expect(workspaceInUse(hourAgo.root).join('\n')).toMatch(/supervisor \(pid \d+\) is running/);
  const twelveMinutes = outputsWorkspace('twelve-minutes', 30);
  writeWorkspaceState(twelveMinutes.root, iosRan(12));
  freeDisk(15);

  await pass();

  expect(existsSync(hourAgo.outputs)).toBe(false);
  expect(existsSync(twelveMinutes.outputs)).toBe(true);
  expect(readMaintenanceState()?.pressure?.diskLevel).toBe(1);
});

test('level 2 keeps the outputs of a workspace that is building', async () => {
  const building = outputsWorkspace('building', 120);
  plantClaim(join(workspaceDir(building.root), 'native-run.lock'), 'exclusive', liveClaimOwner());
  freeDisk(15);

  await pass();

  expect(existsSync(building.outputs)).toBe(true);
});

test('level 2 actions stop once free disk is back above the floor', async () => {
  const halfHour = outputsWorkspace('half-hour', 30);
  freeDisk(15, 25);

  await pass();

  expect(existsSync(halfHour.outputs)).toBe(true);
});

function repoWithFeatureWorktree({
  linkAndroid = false,
  nested = false,
  locked = false,
  iosRanMinutesAgo,
}: {
  linkAndroid?: boolean;
  nested?: boolean;
  locked?: boolean;
  iosRanMinutesAgo?: { repo?: number; feature?: number };
} = {}) {
  const repo = join(projects, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
  git('init -q -b main');
  git('config user.email test@example.com');
  git('config user.name test');
  mkdirSync(join(repo, 'android', 'build'), { recursive: true });
  writeFileSync(join(repo, 'android', 'build', 'tracked.txt'), 'tracked');
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git('add -A');
  git('commit -q -m init');
  const feature = nested ? join(repo, '.worktrees', 'feature') : join(projects, 'feature');
  git(`worktree add -q "${feature}" -b feature`);
  if (locked) git(`worktree lock --reason rollback "${feature}"`);
  for (const base of [repo, feature]) {
    write(join(base, 'ios', 'build', 'App.app', 'binary'));
    write(join(base, 'node_modules', 'pkg', 'index.js'));
    write(join(base, 'apps', 'desktop', '.build', 'debug', 'binary'));
  }
  if (linkAndroid) {
    write(join(feature, 'shared', 'app', 'build', 'keep.txt'));
    git('add shared', feature);
    git('commit -q -m shared', feature);
    rmSync(join(feature, 'android'), { recursive: true });
    symlinkSync('shared', join(feature, 'android'));
  }
  const roots = { repo: realpathSync.native(repo), feature: realpathSync.native(feature) };
  for (const root of Object.values(roots)) upsertProject(root, { metroPort: null });
  const names: ('repo' | 'feature')[] = ['repo', 'feature'];
  for (const name of names) {
    const minutes = iosRanMinutesAgo?.[name];
    if (minutes !== undefined) writeWorkspaceState(roots[name], iosRan(minutes));
  }
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

test('level 2 clears untracked build directories of worktrees whose workspaces did not run native in 15 minutes, never ios/build, and level 3 deletes linked dependencies', async () => {
  const { repo, feature } = repoWithFeatureWorktree({ iosRanMinutesAgo: { feature: 5 } });
  freeDisk(15);

  await pass();

  for (const root of [repo, feature]) {
    expect(existsSync(join(root, 'ios', 'build', 'App.app', 'binary'))).toBe(true);
    expect(existsSync(join(root, 'node_modules'))).toBe(true);
  }
  expect(existsSync(join(repo, 'apps', 'desktop', '.build'))).toBe(false);
  expect(existsSync(join(repo, 'android', 'build', 'tracked.txt'))).toBe(true);
  expect(existsSync(join(feature, 'apps', 'desktop', '.build'))).toBe(true);

  freeDisk(4);
  await pass();

  expect(existsSync(join(feature, 'node_modules'))).toBe(process.platform === 'win32');
  expect(existsSync(join(repo, 'node_modules'))).toBe(true);
  expect(recordedDirs(feature)).toEqual(process.platform === 'win32' ? [] : [join(feature, 'node_modules')]);
  expect(readMaintenanceState()?.lastPass?.blocked).toEqual(
    expect.arrayContaining([expect.stringContaining('disk pressure level 3')]),
  );
}, 60_000);

test.skipIf(process.platform === 'win32')(
  'level 3 keeps the dependencies of a linked worktree a live process works in',
  async () => {
    const { feature } = repoWithFeatureWorktree();
    const child = spawn('sleep', ['60'], { cwd: feature, stdio: 'ignore' });
    try {
      freeDisk(4);
      await pass();
      expect(existsSync(join(feature, 'node_modules', 'pkg', 'index.js'))).toBe(true);
      expect(readFileSync(maintenanceNdjsonFile(), 'utf8')).toContain(`process ${child.pid} works in it`);
    } finally {
      child.kill('SIGKILL');
    }
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'level 3 deletes the dependencies of a worktree whose lockfile drifted without promising a restore',
  async () => {
    const { feature } = repoWithFeatureWorktree();
    writeFileSync(join(feature, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    freeDisk(4);
    await pass();
    expect(existsSync(join(feature, 'node_modules'))).toBe(false);
    expect(recordedDirs(feature)).toEqual([]);
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'levels 2 and 3 never lighten a git-locked worktree, and the log says it is locked',
  async () => {
    const { repo, feature } = repoWithFeatureWorktree({ locked: true, iosRanMinutesAgo: { repo: 60, feature: 60 } });
    const outputs = join(workspaceDir(feature), 'derived-data', 'blob');
    const repoOutputs = join(workspaceDir(repo), 'derived-data', 'blob');
    write(outputs);
    write(repoOutputs);
    freeDisk(15);

    await pass();

    expect(existsSync(repoOutputs)).toBe(false);
    expect(existsSync(join(repo, 'apps', 'desktop', '.build'))).toBe(false);
    expect(existsSync(outputs)).toBe(true);
    expect(existsSync(join(feature, 'apps', 'desktop', '.build'))).toBe(true);

    freeDisk(4);
    await pass();

    expect(existsSync(join(feature, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(recordedDirs(feature)).toEqual([]);
    const log = readFileSync(maintenanceNdjsonFile(), 'utf8');
    for (const kept of [feature, join(feature, 'apps', 'desktop', '.build'), join(feature, 'node_modules')])
      expect(log).toContain(`Kept ${kept}: locked with git worktree lock`);
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'execution rechecks the git lock when the worktree snapshot says unlocked',
  async () => {
    const { feature } = repoWithFeatureWorktree({ locked: true, iosRanMinutesAgo: { feature: 60 } });
    freeDisk(15);
    const clear = (kind: 'would-clear-build-dirs' | 'would-delete-dependencies', target: string) =>
      executeAction({ kind, target, bytes: 0, reason: 'test', level: 2 }, actContext(feature));

    const build = await clear('would-clear-build-dirs', join(feature, 'apps', 'desktop', '.build'));
    const dependencies = await clear('would-delete-dependencies', join(feature, 'node_modules'));

    expect([build.status, dependencies.status]).toEqual(['kept', 'kept']);
    expect(dependencies.detail).toBe('locked with git worktree lock');
    expect(existsSync(join(feature, 'apps', 'desktop', '.build'))).toBe(true);
    expect(existsSync(join(feature, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  },
  60_000,
);

test('a build directory reached through a linked parent is kept', async () => {
  const { feature } = repoWithFeatureWorktree({ linkAndroid: true });
  freeDisk(15);

  await pass();

  expect(existsSync(join(feature, 'shared', 'app', 'build', 'keep.txt'))).toBe(true);
  expect(existsSync(join(feature, 'apps', 'desktop', '.build'))).toBe(false);
}, 60_000);

test('a worktree nested inside another is judged from its own git checkout', async () => {
  const { feature } = repoWithFeatureWorktree({ nested: true });
  freeDisk(15);

  await pass();

  expect(existsSync(join(feature, 'android', 'build', 'tracked.txt'))).toBe(true);
  expect(existsSync(join(feature, 'apps', 'desktop', '.build'))).toBe(false);
}, 60_000);

const actContext = (feature: string) => ({
  settings: resolveMaintenanceSettings(),
  budget: { minFreeDiskMb: 20 * GB, hardFloorDiskMb: 5 * GB, maxCommittedMemoryMb: 0, maxLiveWorkspaces: 0 },
  protectedRoot: '/nowhere',
  worktrees: [{ path: feature, linked: true, locked: false, keys: [feature] }],
});

test('a nested worktree holding its native-run lock keeps its build directory at execution', async () => {
  const { feature } = repoWithFeatureWorktree({ nested: true });
  plantClaim(join(workspaceDir(feature), 'native-run.lock'), 'exclusive', liveClaimOwner());
  freeDisk(15);

  const outcome = await executeAction(
    {
      kind: 'would-clear-build-dirs',
      target: join(feature, 'apps', 'desktop', '.build'),
      bytes: 0,
      reason: 'test',
      level: 2,
    },
    actContext(feature),
  );

  expect(outcome.status).toBe('kept');
  expect(existsSync(join(feature, 'apps', 'desktop', '.build'))).toBe(true);
}, 60_000);

test('level 2 keeps the build directory of a worktree that ran ios 5 minutes ago at execution, and ios/build whatever its age', async () => {
  const { feature } = repoWithFeatureWorktree({ iosRanMinutesAgo: { feature: 5 } });
  freeDisk(15);
  const clear = (target: string) =>
    executeAction({ kind: 'would-clear-build-dirs', target, bytes: 0, reason: 'test', level: 2 }, actContext(feature));

  const recent = await clear(join(feature, 'apps', 'desktop', '.build'));
  writeWorkspaceState(feature, iosRan(60));
  const podInstallOutput = await clear(join(feature, 'ios', 'build'));

  expect(recent.detail).toMatch(/ran ios, android or macos within the last 15 minutes/);
  expect(podInstallOutput.status).toBe('kept');
  expect(existsSync(join(feature, 'apps', 'desktop', '.build'))).toBe(true);
  expect(existsSync(join(feature, 'ios', 'build', 'App.app', 'binary'))).toBe(true);
}, 60_000);

test('level 2 keeps the build directories of a worktree with no Stim workspace state at execution', async () => {
  const { feature } = repoWithFeatureWorktree();
  rmSync(workspaceStateFile(feature), { force: true });
  freeDisk(15);

  const outcome = await executeAction(
    {
      kind: 'would-clear-build-dirs',
      target: join(feature, 'apps', 'desktop', '.build'),
      bytes: 0,
      reason: 'test',
      level: 2,
    },
    actContext(feature),
  );

  expect(outcome.status).toBe('kept');
  expect(existsSync(join(feature, 'apps', 'desktop', '.build'))).toBe(true);
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

test('the next command, report-only gc included, warns on stderr at disk pressure level 3, and status --watch and gc --delete do not', () => {
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
  triggerMaintenance('gc', { argv: ['gc', '--delete'] });
  expect(errors).toEqual([]);
  triggerMaintenance('gc', { argv: ['gc', '--json'] });
  expect(errors).toEqual([expect.stringContaining('disk pressure level 3 (4.0 GB free on /)')]);
  errors.length = 0;
  triggerMaintenance('ios', { argv: ['ios'] });
  expect(errors).toEqual([expect.stringContaining('disk pressure level 3 (4.0 GB free on /)')]);
});

test('level 3 deletes Gradle versions no project pins once idle for gradleVersionIdleDays, never shared caches', async () => {
  vi.stubEnv('GRADLE_USER_HOME', '');
  const current = getExecutor();
  setExecutor({
    ...current,
    runFileAsync: async (file, args, opts) => (file === 'ps' ? '' : current.runFileAsync(file, args, opts)),
  });
  const caches = join(home, '.gradle', 'caches');
  const old = new Date(Date.now() - 10 * 24 * 60 * MINUTE_MS);
  for (const dir of ['9.3.1', '9.4.1', 'modules-2', 'jdks']) write(join(caches, dir, 'keep'));
  write(join(home, '.gradle', 'wrapper', 'dists', 'gradle-9.3.1-bin', 'hash', 'gradle-9.3.1-bin.zip.lck'));
  ageTree(join(home, '.gradle'), old);
  write(join(caches, '9.4.1', 'fresh'));

  process.env.STIM_MAINTENANCE_GRADLE_VERSION_IDLE_DAYS = '0';
  freeDisk(4);
  await pass();
  expect(existsSync(join(caches, '9.3.1'))).toBe(true);

  delete process.env.STIM_MAINTENANCE_GRADLE_VERSION_IDLE_DAYS;
  await pass();
  expect(existsSync(join(caches, '9.3.1'))).toBe(false);
  expect(existsSync(join(home, '.gradle', 'wrapper', 'dists', 'gradle-9.3.1-bin'))).toBe(false);
  expect(existsSync(join(caches, '9.4.1'))).toBe(true);
  expect(existsSync(join(caches, 'modules-2', 'keep'))).toBe(true);
  expect(existsSync(join(caches, 'jdks', 'keep'))).toBe(true);
});

const DAEMON_ROW =
  '  101 /opt/jdk/bin/java -cp /opt/gradle-9.4.1/lib/gradle-daemon-main-9.4.1.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.4.1\n';
const WRAPPER_ROW = '  202 /opt/jdk/bin/java -jar /app/gradle/wrapper/gradle-wrapper.jar assembleDebug\n';

function idleUnpinnedVersion(processes: () => string) {
  vi.stubEnv('GRADLE_USER_HOME', '');
  const current = getExecutor();
  setExecutor({
    ...current,
    runFileAsync: async (file, args, opts) => (file === 'ps' ? processes() : current.runFileAsync(file, args, opts)),
  });
  const version = join(home, '.gradle', 'caches', '9.3.1');
  write(join(version, 'keep'));
  ageTree(join(home, '.gradle'), new Date(Date.now() - 10 * 24 * 60 * MINUTE_MS));
  freeDisk(4);
  return version;
}

function daemonPlan(status: { state: string } | { unknown: string }, buildRunning: string | null = null) {
  vi.spyOn(memory, 'memorySweepIsScoped').mockReturnValue(false);
  vi.spyOn(memory, 'collectMemoryReport').mockResolvedValue({
    processes: memory.planDaemons({
      gradle: [
        {
          pid: 101,
          startedAt: '2026-10-14T00:00:00.000Z',
          bytes: 1024,
          measure: 'rss',
          command: { version: '9.4.1', javaHome: '/opt/jdk', distribution: '/opt/gradle-9.4.1' },
          gradleHome: join(home, '.gradle'),
          offloadClient: null,
          status,
        },
      ],
      kotlin: [],
      buildRunning,
      stimServerRunning: false,
    }),
    watchmanRoots: [],
    notices: [],
  });
}

function stopsDaemon(onStop: () => void = () => {}) {
  return vi.spyOn(memory, 'stopIdleGradleDaemons').mockImplementation(async () => {
    onStop();
    recordGcResult('gradleDaemon', 'done', 'Gradle 9.4.1 daemon pid 101', { id: '101' });
    return 0;
  });
}

const actionKinds = () =>
  (readMaintenanceState()?.recent ?? []).flatMap((entry) => {
    const action = entry.action;
    return entry.event === 'maintenance_action' && isJsonObject(action) && typeof action.kind === 'string'
      ? [action.kind]
      : [];
  });

test('level 3 stops an idle Gradle daemon, then deletes the version it was blocking, as two records', async () => {
  let running = true;
  const version = idleUnpinnedVersion(() => (running ? DAEMON_ROW : ''));
  daemonPlan({ state: 'idle' });
  const stop = stopsDaemon(() => (running = false));
  await pass();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledWith([101]);
  expect(existsSync(version)).toBe(false);
  expect(actionKinds()).toEqual(expect.arrayContaining(['stop-gradle-daemons', 'delete-gradle-version']));
});

test('a stopped daemon that lingers for two more ps calls is waited for, so the version goes in the same pass', async () => {
  let calls = 0;
  let stopped = false;
  const version = idleUnpinnedVersion(() => {
    if (!stopped) return DAEMON_ROW;
    calls += 1;
    return calls <= 2 ? DAEMON_ROW : '';
  });
  daemonPlan({ state: 'idle' });
  stopsDaemon(() => (stopped = true));
  await pass();
  expect(calls).toBeGreaterThan(2);
  expect(existsSync(version)).toBe(false);
});

test('a daemon that does not exit after the stop still keeps the version', async () => {
  const version = idleUnpinnedVersion(() => DAEMON_ROW);
  daemonPlan({ state: 'idle' });
  stopsDaemon();
  await pass();
  expect(existsSync(join(version, 'keep'))).toBe(true);
  expect(actionKinds()).toContain('stop-gradle-daemons');
  expect(actionKinds()).not.toContain('delete-gradle-version');
}, 20_000);

test.each([
  ['a busy daemon', () => daemonPlan({ state: 'busy' })],
  [
    'an idle daemon during a live Android build',
    () => daemonPlan({ state: 'idle' }, 'a running Android build holds x'),
  ],
  ['a daemon whose state is unknown', () => daemonPlan({ unknown: 'gradle --status failed' })],
  ['a Gradle wrapper, which is no daemon', () => daemonPlan({ state: 'idle' })],
])('%s stops nothing and keeps the version', async (name, arrange) => {
  const version = idleUnpinnedVersion(() =>
    name.startsWith('a Gradle wrapper') ? DAEMON_ROW + WRAPPER_ROW : DAEMON_ROW,
  );
  arrange();
  const stop = stopsDaemon();
  await pass();
  expect(stop).not.toHaveBeenCalled();
  expect(existsSync(join(version, 'keep'))).toBe(true);
  expect(actionKinds()).not.toContain('delete-gradle-version');
});

test('a scoped STIM_HOME plans no daemon stop and says why', async () => {
  const version = idleUnpinnedVersion(() => DAEMON_ROW);
  const stop = stopsDaemon();
  await pass();
  expect(stop).not.toHaveBeenCalled();
  expect(existsSync(join(version, 'keep'))).toBe(true);
  expect(readFileSync(maintenanceNdjsonFile(), 'utf8')).toContain('STIM_HOME scopes this config');
});

test('a version kept for its own reason keeps that reason when the daemon stop is not possible', async () => {
  const version = idleUnpinnedVersion(() => DAEMON_ROW);
  write(join(home, '.gradle', 'caches', '9.2', 'fresh'));
  daemonPlan({ state: 'busy' });
  await pass();
  const log = readFileSync(maintenanceNdjsonFile(), 'utf8');
  expect(log).toMatch(/Kept Gradle 9\.2: modified within the last 7 days/);
  expect(log).toMatch(/Kept Gradle 9\.3\.1: Gradle pid 101 keeps it/);
  expect(existsSync(join(version, 'keep'))).toBe(true);
});

test('a non-daemon blocker with no daemon running stops nothing and is named as no daemon', async () => {
  const version = idleUnpinnedVersion(() => WRAPPER_ROW);
  vi.spyOn(memory, 'memorySweepIsScoped').mockReturnValue(false);
  vi.spyOn(memory, 'collectMemoryReport').mockResolvedValue({
    processes: [],
    watchmanRoots: [],
    notices: ['no Gradle or Kotlin daemon is running'],
  });
  const stop = stopsDaemon();
  await pass();
  expect(stop).not.toHaveBeenCalled();
  expect(readFileSync(maintenanceNdjsonFile(), 'utf8')).toContain('Gradle pid 202 keeps it: it is not a daemon');
  expect(existsSync(join(version, 'keep'))).toBe(true);
});
