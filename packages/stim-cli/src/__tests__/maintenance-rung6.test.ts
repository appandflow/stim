import {
  existsSync,
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
  maintenanceNdjsonFile,
  maintenanceStateFile,
  readMaintenanceState,
  type DaemonPressure,
} from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import * as measurements from '../maintenance/measure.ts';
import { runMaintenance } from '../maintenance/run.ts';
import { runLadder } from '../daemon/ladder.ts';
import { planRung6 } from '../maintenance/sweep.ts';
import { warnCriticalDisk } from '../maintenance/trigger.ts';
import { loadConfig, saveConfig } from '../workspace/config.ts';
import * as memory from '../commands/gc/memory.ts';
import { recordGcResult } from '../commands/gc/results.ts';

const MINUTE_MS = 60_000;

let home: string;
let projects: string;

async function pass() {
  rmSync(maintenanceStateFile(), { force: true });
  await runMaintenance('test');
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-maintenance-levels-')));
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-maintenance-levels-projects-')));
  process.env.STIM_HOME = home;
  process.env.STIM_DAEMON = 'on';
  process.env.STIM_DISK_MIN_FREE_GB = '20';
  process.env.STIM_DISK_HARD_FLOOR_GB = '5';
  process.env.STIM_MAINTENANCE_SWEEP_HOURS = '24';
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
    if (key.startsWith('STIM_MAINTENANCE') || key.startsWith('STIM_DISK_')) delete process.env[key];
  delete process.env.STIM_HOME;
  delete process.env.STIM_GC_WORKTREE_GRACE_MINUTES;
  process.env.STIM_DAEMON = 'off';
  process.exitCode = 0;
});

function ageTree(path: string, at: Date) {
  let entries: string[] = [];
  try {
    entries = readdirSync(path);
  } catch {}
  for (const name of entries) ageTree(join(path, name), at);
  utimesSync(path, at, at);
}

function write(path: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
}

test('the next command, report-only gc included, warns on stderr while the daemon found the disk critical, and gc --delete does not', () => {
  mkdirSync(join(home, 'daemon'), { recursive: true });
  writeFileSync(
    join(home, 'daemon', 'snapshot.json'),
    JSON.stringify({
      version: 1,
      pid: 1,
      startedAt: new Date().toISOString(),
      mode: 'on',
      tickAt: new Date().toISOString(),
      tickMs: 1,
      intervalMs: 60_000,
      measurement: {},
      workspaces: [],
      pressure: {
        level: 'critical',
        disk: 'critical',
        memory: 'normal',
        reasons: ['4.0 GB free on /, under the 6.0 GB critical floor'],
        memoryWarningSince: null,
      },
    }),
  );
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));

  warnCriticalDisk(['gc', '--delete']);
  expect(errors).toEqual([]);
  warnCriticalDisk(['gc', '--json']);
  expect(errors).toEqual([expect.stringContaining('disk pressure is critical (4.0 GB free on /')]);
  errors.length = 0;
  warnCriticalDisk(['ios']);
  expect(errors).toEqual([expect.stringContaining('disk pressure is critical (4.0 GB free on /')]);
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

test('memory pressure stops idle Gradle daemons on rung 6 and touches nothing else', async () => {
  const memoryHigh: DaemonPressure = {
    level: 'high',
    disk: 'normal',
    memory: 'high',
    reasons: ['macOS memory pressure has been warning for 10 minutes'],
    memoryWarningSince: null,
  };
  let running = true;
  const version = idleUnpinnedVersion(() => (running ? DAEMON_ROW : ''));
  daemonPlan({ state: 'idle' });
  const stop = stopsDaemon(() => (running = false));
  const { actions } = await runLadder(
    {
      config: loadConfig()!,
      act: true,
      log: () => {},
      devices: [],
      simsFailed: false,
      remeasure: async () => memoryHigh,
    },
    memoryHigh,
  );
  expect(stop).toHaveBeenCalledWith([101]);
  expect(actions.map((action) => [action.rung, action.kind, action.outcome])).toEqual([
    [6, 'stop-gradle-daemons', 'done'],
  ]);
  expect(existsSync(join(version, 'keep'))).toBe(true);
});

test('the daily sweep stops an idle Gradle daemon, then deletes the version it was blocking, as two records', async () => {
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

test('a daemon that does not exit after the stop still keeps the version', async () => {
  let stopped = false;
  let observed!: () => void;
  const polled = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const version = idleUnpinnedVersion(() => {
    if (stopped) observed();
    return DAEMON_ROW;
  });
  daemonPlan({ state: 'idle' });
  stopsDaemon(() => {
    stopped = true;
  });
  const pending = pass();
  await polled;
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
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
])('%s stops nothing and keeps the version', async (_name, arrange) => {
  const version = idleUnpinnedVersion(() => DAEMON_ROW);
  arrange();
  const stop = stopsDaemon();
  await pass();
  expect(stop).not.toHaveBeenCalled();
  expect(existsSync(join(version, 'keep'))).toBe(true);
  expect(actionKinds()).not.toContain('delete-gradle-version');
});

test('a running Gradle wrapper keeps the version, while the idle daemon still stops', async () => {
  let running = true;
  const version = idleUnpinnedVersion(() => (running ? DAEMON_ROW + WRAPPER_ROW : WRAPPER_ROW));
  daemonPlan({ state: 'idle' });
  const stop = stopsDaemon(() => (running = false));
  await pass();
  expect(stop).toHaveBeenCalledWith([101]);
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

const GIB = 1024 ** 3;

function watchmanReport(bytes: number, detail: string | null = null) {
  vi.spyOn(memory, 'memorySweepIsScoped').mockReturnValue(false);
  const collect = vi.spyOn(memory, 'collectMemoryReport').mockImplementation(async (scope) => ({
    processes:
      scope.watchman && bytes >= (scope.watchmanMinBytes ?? 0)
        ? [
            {
              kind: 'watchman',
              cacheKind: 'watchman',
              pid: 4242,
              startedAt: '2026-10-11T00:00:00.000Z',
              bytes,
              measure: 'footprint',
              version: null,
              gradleHome: null,
              offloadClient: null,
              state: detail ? 'busy' : 'idle',
              reclaimable: detail === null,
              reason: detail ? 'in-use' : null,
              detail,
            },
          ]
        : [],
    watchmanRoots: [],
    notices: [],
  }));
  return collect;
}

const plan = (options: { memory?: boolean } = {}) =>
  planRung6({ gradleVersionIdleDays: 0 }, { disk: false, ...options });

test('an unused watchman over 2 GiB is planned for a shutdown by the daily sweep', async () => {
  watchmanReport(9 * GIB);
  const { actions, skips } = await plan();
  expect(actions.map((action) => [action.kind, action.target])).toEqual([['would-stop-watchman', 'pid 4242']]);
  expect(skips).toEqual([]);
});

test('a watchman a client uses stays up and the skip names the client', async () => {
  watchmanReport(9 * GIB, 'used by node (pid 77); shutting it down would break their file watching');
  const { actions, skips } = await plan();
  expect(actions).toEqual([]);
  expect(skips).toEqual([
    { target: 'watchman pid 4242', reason: 'used by node (pid 77); shutting it down would break their file watching' },
  ]);
});

test('a watchman between 1 and 2 GiB is shut down only under memory pressure', async () => {
  watchmanReport(1.5 * GIB);
  expect((await plan()).actions).toEqual([]);
  expect((await plan({ memory: true })).actions.map((action) => action.kind)).toEqual(['would-stop-watchman']);
});

test('a watchman under 1 GiB is left alone, pressure or not, without probing its roots', async () => {
  const collect = watchmanReport(0.8 * GIB);
  expect((await plan({ memory: true })).actions).toEqual([]);
  expect(collect).toHaveBeenCalledWith(
    expect.objectContaining({ watchman: true, watchmanMinBytes: GIB }),
    false,
    undefined,
  );
});

test('a scoped STIM_HOME plans no watchman shutdown', async () => {
  const collect = watchmanReport(9 * GIB);
  vi.spyOn(memory, 'memorySweepIsScoped').mockReturnValue(true);
  const { actions } = await plan();
  expect(actions).toEqual([]);
  expect(collect).not.toHaveBeenCalled();
});

test('the daily sweep shuts watchman down and records it', async () => {
  watchmanReport(9 * GIB);
  const stop = vi.spyOn(memory, 'stopUnusedWatchman').mockImplementation(async () => {
    recordGcResult('watchman', 'done', 'watchman pid 4242', { id: '4242', bytes: 9 * GIB });
    return 0;
  });
  await pass();
  expect(stop).toHaveBeenCalledWith(4242);
  expect(actionKinds()).toContain('stop-watchman');
});
