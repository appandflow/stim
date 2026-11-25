import {
  chmodSync,
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
import { join } from 'node:path';
import { buildCacheRoot, metroCacheRoot } from '@stim-cli/core';
import * as toolchain from '@stim-cli/core/toolchain';
import {
  daemonNdjsonFile,
  maintenanceStateFile,
  workspaceStateFile,
  readDaemonSnapshot,
  readGcMark,
  readDormantStage,
  daemonClaimRoot,
  readMaintenanceState,
  readStimdBoots,
  stimdClaimRoot,
  type DaemonMode,
  type DaemonPressure,
} from '@stim-cli/core/state';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import * as engineFollow from '../stimd/engine-follow.ts';
import * as dependencies from '../daemon/dependencies.ts';
import { clearSourceCheckouts, type RankedDependency } from '../daemon/dependencies.ts';
import * as artifacts from '../stimd/passes/artifacts.ts';
import * as idlePass from '../daemon/idle.ts';
import * as ladder from '../daemon/ladder.ts';
import * as measure from '../daemon/measure.ts';
import * as reclaim from '../daemon/reclaim.ts';
import { ensureStimd } from '../daemon/client.ts';
import { acquireDisk, HARD_FLOOR, LADDER, LANE } from '../daemon/disk-owner.ts';
import { createMaintenanceLane, runDiskPass, runHomePasses } from '../daemon/passes.ts';
import * as fsUtil from '../fs-util.ts';
import { measureSizes } from '../stimd/passes/measure.ts';
import { executeAction } from '../stimd/passes/act.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { runStimd } from '../stimd/main.ts';
import * as net from '../stimd/net.ts';
import { invocation, withInvocation } from '../stimd/forwarded.ts';
import * as diskPasses from '../daemon/passes.ts';
import * as stages from '../daemon/stages.ts';
import * as markRefresh from '../daemon/mark-refresh.ts';
import { pendingDormant } from '../daemon/stages.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import * as idleStop from '../stimd/passes/idle-stop.ts';
import * as maintenanceRun from '../stimd/passes/run.ts';
import { loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { testContext } from './_context.ts';

vi.mock('../stimd/threads.ts', () => import('./fixtures/inline-stimd-threads.ts'));
vi.mock('../daemon/fingerprint-precompute.ts', () => ({
  createFingerprintPrecompute: () => ({ run: async () => {} }),
}));
vi.mock('../stimd/logs/writer.ts', () => ({
  createLogWriters: (_failure: unknown, _change: unknown, onOwned: (running: boolean) => void) => ({
    ownedSync: async () => {
      onOwned(false);
    },
    ownedClose: async () => {},
    close: async () => {},
  }),
}));

const MINUTE_MS = 60_000;
let home: string;
let freeMb: number;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cadence-')));
  process.env.STIM_HOME = home;
  freeMb = 500_000;
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileQuiet: (file) => (file === 'ps' ? '' : null),
    runFileQuietAsync: async (file) => (file === 'ps' ? '' : null),
    runFileAsync: async (file) => {
      throw new Error(`${file} does not run in this test`);
    },
  });
  vi.spyOn(maintenanceRun, 'runMaintenance').mockResolvedValue(undefined as never);
  vi.spyOn(measure, 'measureTick').mockImplementation(async () => ({
    measurement: {
      disk: [{ volume: '/', freeMb }],
      memory: { level: 'normal', availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
      load1: 0,
      cores: 8,
      bootedSimulators: 0,
      runningEmulators: null,
      interaction: null,
    },
    sims: [],
    simsError: null,
    devices: [],
  }));
  vi.spyOn(measure, 'measureDisk').mockImplementation(async () => [{ volume: '/', freeMb }]);
  vi.spyOn(measure, 'measureMemory').mockResolvedValue({
    level: 'normal',
    availableBytes: 8 * 1024 ** 3,
    totalBytes: 16 * 1024 ** 3,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function ticks(): { at: number; msg: string }[] {
  return readFileSync(daemonNdjsonFile(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'daemon_tick')
    .map((entry) => ({ at: entry.ts, msg: entry.msg }));
}

function quietWorkspace(usedAgoMs = MINUTE_MS): string {
  const root = join(home, 'app');
  mkdirSync(root, { recursive: true });
  ensureWorkspaceStorage(root);
  upsertProject(root, {});
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  writeFileSync(join(workspaceLogsDir(root), 'device.ndjson'), '{}\n');
  recordWorkspaceUse(root, new Date(Date.now() - usedAgoMs));
  return root;
}

test.skipIf(process.platform === 'win32')(
  'stimd startup fills its bare PATH for background lookup while a CLI invocation keeps its own environment',
  async () => {
    const bin = join(home, '.local', 'bin');
    const agentDevice = join(bin, 'agent-device');
    mkdirSync(bin, { recursive: true });
    writeFileSync(agentDevice, '#!/bin/sh\nexit 0\n');
    chmodSync(agentDevice, 0o755);
    const probe: toolchain.ToolchainProbe = {
      home,
      execPath: '/runtime/bin/node',
      isDir: (path) => path === bin,
      isFile: (path) => path === agentDevice,
      read: () => null,
      list: () => [],
      link: () => null,
    };
    const discover = toolchain.discoverToolchain;
    vi.spyOn(toolchain, 'discoverToolchain').mockImplementation((env) => discover(env, probe));
    const createNetThread = vi.spyOn(net, 'createNetThread');
    const barePath = '/usr/bin:/bin:/usr/sbin:/sbin';
    const cliEnv = { PATH: barePath, JAVA_HOME: '/cli/jdk' };
    const context = invocation(home, cliEnv);
    if ('code' in context) throw new Error(context.message);
    quietWorkspace();
    const savedEnv = { ...process.env };
    let daemon: Promise<boolean> | undefined;
    try {
      Object.assign(process.env, { PATH: barePath, JAVA_HOME: '/custom/jdk', ANDROID_HOME: '/custom/sdk' });
      daemon = runStimd({ mode: 'report' });
      expect(getExecutor().findExecutable('agent-device')).toBe(agentDevice);
      expect(process.env.PATH).toBe(`${barePath}:${bin}`);
      expect(process.env.JAVA_HOME).toBe('/custom/jdk');
      expect(process.env.ANDROID_HOME).toBe('/custom/sdk');
      withInvocation({ ...context, workspace: home }, new AbortController().signal, () => {
        expect(getExecutor().findExecutable('agent-device')).toBeNull();
      });
      await vi.waitFor(() => expect(createNetThread).toHaveBeenCalled());
      const netEnv = createNetThread.mock.calls[0]![4];
      expect(netEnv?.PATH).toBe(barePath);
      expect(netEnv?.PATH).not.toContain(bin);
    } finally {
      try {
        if (daemon) {
          process.emit('SIGTERM', 'SIGTERM');
          await daemon;
        }
      } finally {
        for (const key of Object.keys(process.env)) {
          if (!(key in savedEnv)) delete process.env[key];
        }
        Object.assign(process.env, savedEnv);
      }
    }
  },
);

test('stimd starts with its inherited environment and logs one warning when toolchain discovery throws', async () => {
  const error = Object.assign(new Error('EACCES: permission denied, stat /external/android-sdk'), { code: 'EACCES' });
  const probe: toolchain.ToolchainProbe = {
    home,
    execPath: '/runtime/bin/node',
    isDir: () => {
      throw error;
    },
    isFile: () => false,
    read: () => null,
    list: () => [],
    link: () => null,
  };
  const discover = toolchain.discoverToolchain;
  vi.spyOn(toolchain, 'discoverToolchain').mockImplementation((env) => discover(env, probe));
  quietWorkspace();
  const savedEnv = { ...process.env };
  const inheritedPath = '/usr/bin:/bin:/usr/sbin:/sbin';
  let daemon: Promise<boolean> | undefined;
  try {
    process.env.PATH = inheritedPath;
    daemon = runStimd({ mode: 'report' });
    expect(process.env.PATH).toBe(inheritedPath);
    const records = () =>
      readFileSync(daemonNdjsonFile(), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    await vi.waitFor(() => expect(records()).toContainEqual(expect.objectContaining({ event: 'daemon_started' })));
    expect(records().filter((entry) => entry.event === 'toolchain_discovery_failed')).toEqual([
      expect.objectContaining({ src: 'stimd', level: 'warn', msg: expect.stringContaining(error.message) }),
    ]);
    expect(process.env.PATH).toBe(inheritedPath);
  } finally {
    try {
      if (daemon) {
        process.emit('SIGTERM', 'SIGTERM');
        await daemon;
      }
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
  }
});

test('due output marks refresh on quiet ticks before the next hourly walk', async () => {
  const root = quietWorkspace(0);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  const actualRefresh = markRefresh.refreshKnownMarks;
  let settled = 0;
  vi.spyOn(markRefresh, 'refreshKnownMarks').mockImplementation(async (...args) => {
    await actualRefresh(...args);
    settled++;
  });
  const read = vi.spyOn(stages, 'readCheckout').mockImplementation(async (path) => ({
    path,
    at: Date.now(),
    lastActivityAt: Date.now(),
    kept: null,
  }));
  const daemon = runStimd({ mode: 'on' });
  try {
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await vi.waitFor(() => expect(settled).toBe(1));
    const first = readGcMark(root)?.markedAt;
    expect(first).toBeDefined();
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    await vi.waitFor(() => expect(settled).toBe(2));
    expect(readGcMark(root)?.markedAt).toBe(first);
    for (const count of [3, 4]) {
      await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
      await vi.waitFor(() => expect(settled).toBe(count));
    }
    expect(readGcMark(root)?.markedAt).not.toBe(first);
    expect(read).toHaveBeenCalledTimes(2);
    expect(maintenanceRun.runMaintenance).toHaveBeenCalledTimes(4);
    expect(readDaemonSnapshot()?.gcMarks?.stale).toEqual([]);
  } finally {
    process.emit('SIGTERM', 'SIGTERM');
    await daemon;
  }
});

test('report mode starts no additional mark refresh', async () => {
  quietWorkspace(0);
  const refresh = vi.spyOn(markRefresh, 'refreshKnownMarks');
  const daemon = runStimd({ mode: 'report' });
  try {
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await vi.waitFor(() => expect(ticks()).toHaveLength(1));
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    process.emit('SIGTERM', 'SIGTERM');
    await daemon;
  }
});

test('a pending mark request is unique across ticks and shutdown awaits its cancellation cleanup', async () => {
  quietWorkspace(0);
  let signal: AbortSignal | undefined;
  let finish = () => {};
  const refresh = vi.spyOn(markRefresh, 'refreshKnownMarks').mockImplementation((_input, operation) => {
    signal = operation.signal;
    return new Promise((_resolve, reject) => {
      finish = () => reject(operation.signal.reason);
    });
  });
  let ended = false;
  const daemon = runStimd({ mode: 'on' }).finally(() => {
    ended = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    process.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(ended).toBe(false);
  } finally {
    finish();
    await daemon;
  }
});

describe('the disk owner', () => {
  const critical = (reason: string): DaemonPressure => ({
    level: 'critical',
    disk: 'critical',
    memory: 'normal',
    reasons: [reason],
    memoryWarningSince: null,
  });

  function unitsOfTheStep(order: string[]) {
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const finished = new Promise<void>((resolve) => (finish = resolve));
    vi.spyOn(dependencies, 'runDormantDependencies').mockImplementation(async (input) => {
      order.push('unit 1');
      enter();
      await finished;
      await input.between?.();
      order.push('unit 2');
      await input.between?.();
      order.push('deletions');
      return [];
    });
    vi.spyOn(ladder, 'runLadder').mockImplementation(async (_input, pressure) => {
      order.push(pressure.reasons[0] === 'waiting' ? 'pass waiting' : 'pass hard floor');
      return { actions: [], pressure };
    });
    return { entered, finish };
  }

  async function laneStarted() {
    saveConfig({ version: 2, projects: {}, repos: {} });
    const lane = createMaintenanceLane(() => {}, { run: async () => {} });
    lane.start(
      {
        config: loadConfig(),
        measured: await measure.measureTick(null, Date.now()),
        operation: testContext(),
        workspaces: [],
        pressure: critical('lane'),
      },
      true,
    );
    return lane;
  }

  const pass = (reason: string) =>
    runDiskPass(
      { act: true, pressure: critical(reason), devices: [], sims: [], requested: false },
      () => {},
      testContext(),
    );

  test('a disk pass asked while the dormant step runs waits for its current unit, and the step then goes on to its deletions', async () => {
    const order: string[] = [];
    const { entered, finish } = unitsOfTheStep(order);
    const lane = await laneStarted();
    await entered;

    const asked = pass('waiting');
    order.push('asked');
    finish();
    await asked;
    await lane.settled();

    expect(order).toEqual(['unit 1', 'asked', 'pass waiting', 'unit 2', 'deletions']);
  });

  test('a hard-floor pass goes ahead of a waiting pass, and the tick that asked for it answers only after it', async () => {
    const order: string[] = [];
    const { entered, finish } = unitsOfTheStep(order);
    vi.spyOn(idlePass, 'runIdlePass').mockResolvedValue([]);
    vi.spyOn(stages, 'runDormantPass').mockResolvedValue([]);
    freeMb = 10 * 1024;
    const lane = await laneStarted();
    await entered;

    const waiting = pass('waiting');
    let answered = false;
    const floor = runHomePasses({ act: true, log: () => {}, requested: true }).finally(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    const beforeTheUnitEnded = answered;
    finish();
    await Promise.all([waiting, floor]);
    await lane.settled();

    expect(beforeTheUnitEnded).toBe(false);
    expect(order).toEqual(['unit 1', 'pass hard floor', 'pass waiting', 'unit 2', 'deletions']);
  });

  test('a hard-floor pass asked during the size check runs after the current walk, before the next one', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    mkdirSync(buildCacheRoot(), { recursive: true });
    mkdirSync(metroCacheRoot(), { recursive: true });
    const order: string[] = [];
    let entered!: () => void;
    let finish!: () => void;
    const walking = new Promise<void>((resolve) => (entered = resolve));
    const finished = new Promise<void>((resolve) => (finish = resolve));
    vi.spyOn(fsUtil, 'measuredDirectorySizeAsync').mockImplementation(async (dir) => {
      const walk = dir === buildCacheRoot() ? 'walk build cache' : 'walk Metro cache';
      order.push(walk);
      if (walk === 'walk build cache') {
        entered();
        await finished;
      }
      return 1;
    });
    vi.spyOn(ladder, 'runLadder').mockImplementation(async (_input, pressure) => {
      order.push('pass hard floor');
      return { actions: [], pressure };
    });
    const turn = await acquireDisk(LANE);
    try {
      const sizes = measureSizes(Date.now(), () => {}, testContext(), [], turn.boundary);
      await walking;
      const floor = runDiskPass(
        { act: true, pressure: critical('floor'), devices: [], sims: [], requested: true },
        () => {},
        testContext(),
      );
      finish();
      await Promise.all([sizes, floor]);
    } finally {
      turn.release();
    }

    expect(order).toEqual(['walk build cache', 'pass hard floor', 'walk Metro cache']);
  });

  test('the maintenance pass gives up the turn once it deletes nothing more, before its discovery scan', async () => {
    const order: string[] = [];
    vi.spyOn(dependencies, 'runDormantDependencies').mockResolvedValue([]);
    vi.spyOn(ladder, 'runLadder').mockImplementation(async (_input, pressure) => {
      order.push('pass');
      return { actions: [], pressure };
    });
    let asked: Promise<unknown> = Promise.resolve();
    vi.spyOn(maintenanceRun, 'runMaintenance').mockImplementation(async (_trigger, options) => {
      options?.deleted?.();
      asked = pass('scan');
      await vi.advanceTimersByTimeAsync(0);
      order.push('discovery scan');
    });
    const lane = await laneStarted();
    await lane.settled();
    await asked;

    expect(order).toEqual(['pass', 'discovery scan']);
  });

  test('a disk pass aborted while it waits for the turn stops before its first rung', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    const rungs = vi.spyOn(ladder, 'runLadder');
    const controller = new AbortController();
    const turn = await acquireDisk(LANE);
    const asked = runDiskPass(
      { act: true, pressure: critical('aborted'), devices: [], sims: [], requested: false },
      () => {},
      testContext({ signal: controller.signal }),
    );
    void asked.catch(() => {});
    controller.abort();
    turn.release();

    await expect(asked).rejects.toThrow('aborted');
    expect(rungs).not.toHaveBeenCalled();
  });

  test('a hard-floor pass asked while the first of two source checkouts is cleaned runs before the second', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    const order: string[] = [];
    let entered!: () => void;
    let finish!: () => void;
    const clearing = new Promise<void>((resolve) => (entered = resolve));
    const finished = new Promise<void>((resolve) => (finish = resolve));
    vi.spyOn(artifacts, 'clearSourceTrees').mockImplementation(async (targets) => {
      order.push(`clear ${targets.join(' ')}`);
      if (order.length === 1) {
        entered();
        await finished;
      }
      return new Map(targets.map((target) => [target, { status: 'done' as const, bytes: 1, detail: '' }]));
    });
    vi.spyOn(ladder, 'runLadder').mockImplementation(async (_input, pressure) => {
      order.push('pass hard floor');
      return { actions: [], pressure };
    });
    const tree = (worktree: string): RankedDependency => ({
      candidate: { worktree, path: join(worktree, 'node_modules'), keys: [], locked: false, reduceOnly: false },
      source: true,
      workspace: worktree,
      bytes: 1,
      privateBytes: 1,
    });
    const turn = await acquireDisk(LANE);
    try {
      const cleaned = clearSourceCheckouts(
        [tree('/a'), tree('/b')],
        0,
        '',
        [],
        testContext(),
        'idle.sourceDormantDays is 1',
        'normal',
        turn.boundary,
      );
      await clearing;
      const floor = runDiskPass(
        { act: true, pressure: critical('floor'), devices: [], sims: [], requested: true },
        () => {},
        testContext(),
      );
      finish();
      await Promise.all([cleaned, floor]);
    } finally {
      turn.release();
    }

    expect(order).toEqual([
      `clear ${join('/a', 'node_modules')}`,
      'pass hard floor',
      `clear ${join('/b', 'node_modules')}`,
    ]);
  });

  test('a released disk turn cannot release or yield a different holder', async () => {
    const released = await acquireDisk(LANE);
    released.release();
    const held = await acquireDisk(LADDER);
    expect(() => released.boundary()).toThrow('without its disk turn');
    released.release();
    await held.boundary();
    let granted = false;
    const next = acquireDisk(HARD_FLOOR).then((owner) => {
      granted = true;
      return owner;
    });
    released.release();
    await Promise.resolve();
    expect(granted).toBe(false);
    held.release();
    (await next).release();
  });

  test('a hard-floor pass asked during a maintenance cache trim runs before its next entry', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    const entries = ['a', 'b'].map((name) => join(buildCacheRoot(), 'key', name));
    const old = new Date(Date.now() - 10 * 24 * 60 * MINUTE_MS);
    for (const entry of entries) {
      mkdirSync(entry, { recursive: true });
      utimesSync(entry, old, old);
    }
    const order: string[] = [];
    let entered!: () => void;
    let finish!: () => void;
    const walking = new Promise<void>((resolve) => (entered = resolve));
    const finished = new Promise<void>((resolve) => (finish = resolve));
    vi.spyOn(fsUtil, 'measuredDirectorySizeAsync').mockImplementation(async (dir) => {
      if (!entries.includes(dir)) return 0;
      order.push(`entry ${dir.slice(-1)}`);
      if (order.length === 1) {
        entered();
        await finished;
      }
      return 1;
    });
    vi.spyOn(ladder, 'runLadder').mockImplementation(async (_input, pressure) => {
      order.push('pass hard floor');
      return { actions: [], pressure };
    });
    const turn = await acquireDisk(LANE);
    try {
      const trim = executeAction(
        { kind: 'would-trim-cache', target: 'Build cache', dir: buildCacheRoot(), bytes: 100, reason: 'over its cap' },
        {
          settings: resolveMaintenanceSettings(),
          protectedRoot: '',
          operation: testContext(),
          between: turn.boundary,
        },
      );
      await walking;
      const floor = runDiskPass(
        { act: true, pressure: critical('floor'), devices: [], sims: [], requested: true },
        () => {},
        testContext(),
      );
      finish();
      await Promise.all([trim, floor]);
    } finally {
      turn.release();
    }

    expect(order).toEqual(['entry a', 'pass hard floor', 'entry b']);
  });

  test('walks the lane runs side by side hand the turn over once, and each waits until the lane has it back', async () => {
    const order: string[] = [];
    const turn = await acquireDisk(LANE);
    const floor = acquireDisk(HARD_FLOOR).then((owner) => {
      order.push('pass');
      return owner;
    });
    const walks = Promise.all([
      turn.boundary().then(() => void order.push('walk a')),
      turn.boundary().then(() => void order.push('walk b')),
    ]);
    const floorTurn = await floor;
    order.push('pass done');
    floorTurn.release();
    await walks;
    turn.release();

    expect(order).toEqual(['pass', 'pass done', 'walk a', 'walk b']);
  });

  test('a disk pass that fails is logged and the tick goes on', async () => {
    saveConfig({ version: 2, projects: {}, repos: {} });
    freeMb = 10 * 1024;
    vi.spyOn(idlePass, 'runIdlePass').mockResolvedValue([]);
    vi.spyOn(stages, 'runDormantPass').mockResolvedValue([]);
    const events: string[] = [];

    const passes = await runHomePasses({
      act: true,
      log: (_level, event) => void events.push(event),
      diskPass: async () => {
        throw new Error('the passes thread ended during a disk pass');
      },
    });

    expect(events).toContain('pressure_ladder_failed');
    expect(passes.ladder).toMatchObject({ freed: false });
  });
});

describe.skipIf(process.platform === 'win32')(
  'a running stim-daemon (skipped on win32, where Stim runs no daemon)',
  () => {
    test('predictive cleanup uses the actual quiet cadence while measured pressure remains normal', async () => {
      quietWorkspace();
      vi.stubEnv('STIM_DISK_MIN_FREE_GB', '1');
      vi.stubEnv('STIM_DISK_CRITICAL_FREE_GB', '0');
      vi.stubEnv('STIM_DISK_HARD_FLOOR_GB', '0');
      const read = vi.mocked(measure.measureTick).getMockImplementation();
      if (!read) throw new Error('missing measurement fixture');
      vi.mocked(measure.measureTick).mockImplementation(async (...args) => {
        const measured = await read(...args);
        measured.measurement.disk = [{ volume: '/', device: 1, freeMb }];
        return measured;
      });
      vi.mocked(measure.measureDisk).mockImplementation(async () => [{ volume: '/', device: 1, freeMb }]);
      const disk = vi.spyOn(diskPasses, 'runDiskPass');
      freeMb = 8 * 1024;
      const daemon = runStimd({ mode: 'on' });
      try {
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(1));
        expect(readDaemonSnapshot()?.intervalMs).toBe(5 * MINUTE_MS);
        freeMb = 5 * 1024;
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(2));
        expect(disk).not.toHaveBeenCalled();
        freeMb = 2 * 1024;
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(3));
        const targets = disk.mock.calls.flatMap(([input]) => (input.target ? [input.target] : []));
        expect(targets).toHaveLength(1);
        expect(targets[0]?.device).toBe(1);
        expect(targets[0]?.freeMb).toBeCloseTo(4 * 1024, 0);
        expect(readDaemonSnapshot()).toMatchObject({
          pressure: { level: 'normal', disk: 'normal' },
          intervalMs: 5 * MINUTE_MS,
        });
      } finally {
        process.emit('SIGTERM', 'SIGTERM');
        await daemon;
      }
    });

    test('real critical after predictive admission runs the normal scheduler immediately at critical rank', async () => {
      quietWorkspace();
      vi.stubEnv('STIM_DISK_MIN_FREE_GB', '1');
      vi.stubEnv('STIM_DISK_CRITICAL_FREE_GB', '0.75');
      vi.stubEnv('STIM_DISK_HARD_FLOOR_GB', '0');
      const read = vi.mocked(measure.measureTick).getMockImplementation();
      if (!read) throw new Error('missing measurement fixture');
      vi.mocked(measure.measureTick).mockImplementation(async (...args) => {
        const measured = await read(...args);
        measured.measurement.disk = [{ volume: '/', device: 1, freeMb }];
        return measured;
      });
      vi.mocked(measure.measureDisk).mockImplementation(async () => [{ volume: '/', device: 1, freeMb }]);
      const real = diskPasses.runDiskPass;
      const disk = vi.spyOn(diskPasses, 'runDiskPass').mockImplementation(async (input, ...args) => {
        if (input.target) {
          freeMb = 512;
          return {
            actions: [],
            pressure: {
              level: 'critical',
              disk: 'critical',
              memory: 'normal',
              reasons: ['current device is critical'],
              memoryWarningSince: null,
            },
          };
        }
        return real(input, ...args);
      });
      const owner = await import('../daemon/disk-owner.ts');
      const granted = vi.spyOn(owner, 'acquireDisk');
      freeMb = 8 * 1024;
      const daemon = runStimd({ mode: 'on' });
      try {
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(1));
        freeMb = 5 * 1024;
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(2));
        freeMb = 2 * 1024;
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
        await vi.waitFor(() => expect(ticks().length).toBeGreaterThanOrEqual(4));
        expect(disk.mock.calls.map(([input]) => Boolean(input.target))).toEqual([true, false]);
        expect(granted).toHaveBeenCalledWith(owner.CRITICAL);
        expect((ticks()[3]?.at ?? Infinity) - (ticks()[2]?.at ?? 0)).toBeLessThan(MINUTE_MS);
        expect(readDaemonSnapshot()).toMatchObject({ pressure: { disk: 'critical' }, intervalMs: MINUTE_MS });
      } finally {
        process.emit('SIGTERM', 'SIGTERM');
        await daemon;
      }
    });

    test('real pressure on the second empty tick survives idle shutdown until the critical turn', async () => {
      saveConfig({ version: 2, projects: {}, repos: {}, idle: { dormantDays: 0 } });
      vi.stubEnv('STIM_DISK_MIN_FREE_GB', '1');
      vi.stubEnv('STIM_DISK_CRITICAL_FREE_GB', '0.75');
      vi.stubEnv('STIM_DISK_HARD_FLOOR_GB', '0');
      const read = vi.mocked(measure.measureTick).getMockImplementation();
      if (!read) throw new Error('missing measurement fixture');
      vi.mocked(measure.measureTick).mockImplementation(async (...args) => {
        const measured = await read(...args);
        measured.measurement.disk = [{ volume: '/', device: 1, freeMb }];
        return measured;
      });
      vi.mocked(measure.measureDisk).mockImplementation(async () => [{ volume: '/', device: 1, freeMb }]);
      const real = diskPasses.runDiskPass;
      const disk = vi.spyOn(diskPasses, 'runDiskPass').mockImplementation(async (input, ...args) => {
        if (!input.target) return real(input, ...args);
        freeMb = 512;
        return {
          actions: [],
          pressure: { level: 'critical', disk: 'critical', memory: 'normal', reasons: [], memoryWarningSince: null },
        };
      });
      const owner = await import('../daemon/disk-owner.ts');
      const granted = vi.spyOn(owner, 'acquireDisk');
      freeMb = 5 * 1024;
      const daemon = runStimd({ mode: 'on' });
      try {
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(1));
        freeMb = 2 * 1024;
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
        await vi.waitFor(() => expect(disk.mock.calls.map(([input]) => Boolean(input.target))).toEqual([true, false]));
        expect(granted).toHaveBeenCalledWith(owner.CRITICAL);
      } finally {
        process.emit('SIGTERM', 'SIGTERM');
        await daemon;
      }
    });

    test('a quiet home with a workspace not yet dormant keeps the daemon at the 5-minute cadence until dormancy, then it exits two slow ticks later', async () => {
      saveConfig({ version: 2, projects: {}, repos: {}, idle: { dormantDays: 0.01 } });
      const root = join(home, 'app');
      mkdirSync(root);
      ensureWorkspaceStorage(root);
      upsertProject(root, {});
      mkdirSync(workspaceLogsDir(root), { recursive: true });
      writeFileSync(join(workspaceLogsDir(root), 'device.ndjson'), '{}\n');
      const started = Date.now();
      recordWorkspaceUse(root, new Date(started - MINUTE_MS));

      let exited = false;
      const daemon = (async () => {
        await runStimd({ mode: 'on' });
        exited = true;
      })();
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(1));
      expect(readDaemonSnapshot()).toMatchObject({ intervalMs: 5 * MINUTE_MS });
      expect(ticks()[0]?.msg).toContain('not dormant yet');

      await vi.advanceTimersByTimeAsync(2 * 5 * MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(3));
      expect(readDormantStage(readWorkspaceState(root))).toBeNull();

      await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(4));
      expect(readDormantStage(readWorkspaceState(root))).toMatchObject({ dormantDays: 0.01 });
      expect(exited).toBe(false);

      await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(5));
      expect(exited).toBe(false);
      await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
      await vi.waitFor(() => expect(exited).toBe(true));
      await daemon;
      expect(ticks().map(({ at }) => Math.round((at - started) / MINUTE_MS))).toEqual([1, 6, 11, 16, 21, 26]);
    });

    test('a quiet home ticks every minute while the pressure level is high, and every 5 minutes once it clears', async () => {
      saveConfig({ version: 2, projects: {}, repos: {} });
      const root = join(home, 'app');
      mkdirSync(root);
      ensureWorkspaceStorage(root);
      upsertProject(root, {});
      mkdirSync(workspaceLogsDir(root), { recursive: true });
      writeFileSync(join(workspaceLogsDir(root), 'device.ndjson'), '{}\n');
      recordWorkspaceUse(root, new Date(Date.now() - MINUTE_MS));
      freeMb = 30 * 1024;

      let exited = false;
      const daemon = (async () => {
        await runStimd({ mode: 'on' });
        exited = true;
      })();
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(1));
      expect(readDaemonSnapshot()).toMatchObject({ pressure: { level: 'high' }, intervalMs: MINUTE_MS });
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(2));

      freeMb = 500_000;
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(3));
      expect(readDaemonSnapshot()).toMatchObject({ pressure: { level: 'normal' }, intervalMs: 5 * MINUTE_MS });

      rmSync(workspaceLogsDir(root), { recursive: true, force: true });
      await vi.advanceTimersByTimeAsync(2 * 5 * MINUTE_MS);
      await vi.waitFor(() => expect(exited).toBe(true));
      await daemon;
    });

    function planRemoval({ kept = false }: { kept?: boolean } = {}): void {
      mkdirSync(join(home, 'maintenance'), { recursive: true });
      writeFileSync(
        maintenanceStateFile(),
        JSON.stringify({
          version: 1,
          lastAt: {},
          pressure: null,
          sizes: [],
          lastPass: null,
          recent: [],
          plan: [{ kind: 'would-remove-worktree', target: '/w/merged', bytes: 0, reason: 'merged', check: 'worktree' }],
          ...(kept ? { skipKeys: ['/w/merged'] } : {}),
        }),
      );
      expect(readMaintenanceState()?.plan).toHaveLength(1);
    }

    function awaitRemoval(): void {
      mkdirSync(join(home, 'maintenance'), { recursive: true });
      writeFileSync(
        maintenanceStateFile(),
        JSON.stringify({
          version: 1,
          lastAt: {},
          pressure: null,
          sizes: [],
          lastPass: null,
          recent: [],
          plan: [],
          nextRemoval: { target: '/w/merged', at: Date.now() + 60 * MINUTE_MS },
        }),
      );
      expect(readMaintenanceState()?.nextRemoval?.target).toBe('/w/merged');
    }

    /** Runs a quiet daemon for its first tick and two slow ones; ends one still running and says whether it exited first. */
    async function exitsAfterTwoQuietTicks(mode: DaemonMode = 'on'): Promise<boolean> {
      const before = existsSync(daemonNdjsonFile()) ? ticks().length : 0;
      let exited = false;
      const daemon = (async () => {
        await runStimd({ mode });
        exited = true;
      })();
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(before + 1));
      await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(before + 2));
      await vi.advanceTimersByTimeAsync(10);
      const result = exited;
      saveConfig({ version: 2, projects: {}, repos: {} });
      rmSync(join(home, 'maintenance'), { recursive: true, force: true });
      await vi.advanceTimersByTimeAsync(3 * 5 * MINUTE_MS);
      await vi.waitFor(() => expect(exited).toBe(true));
      await daemon;
      return result;
    }

    describe('what keeps a quiet daemon alive', () => {
      test('a workspace not yet dormant does', async () => {
        quietWorkspace();
        expect(await exitsAfterTwoQuietTicks()).toBe(false);
      });

      test.each([
        [
          'idle.dormantDays 0',
          () => {
            quietWorkspace();
            saveConfig({ version: 2, projects: loadConfig()?.projects ?? {}, repos: {}, idle: { dormantDays: 0 } });
          },
        ],
        [
          'maintenance.keep',
          () => writeFileSync(join(quietWorkspace(), '.stim.json'), JSON.stringify({ maintenance: { keep: true } })),
        ],
        [
          'idle.minutes 0',
          () => writeFileSync(join(quietWorkspace(), '.stim.json'), JSON.stringify({ idle: { minutes: 0 } })),
        ],
        [
          'a hosted placement',
          () => {
            quietWorkspace();
            vi.spyOn(idleStop, 'hostedFacts').mockReturnValue({ placements: [], unreadable: ['hosted.json'] });
          },
        ],
        [
          'a workspace with no activity recorded in its state',
          () => {
            const root = quietWorkspace();
            writeFileSync(workspaceStateFile(root), '{}');
            expect(readWorkspaceState(root)).toEqual({});
          },
        ],
        [
          'an unreadable state.json',
          () => {
            const root = quietWorkspace();
            writeFileSync(workspaceStateFile(root), '{ not json');
            expect(readWorkspaceState(root)).toBeNull();
          },
        ],
        [
          'a workspace past its dormant due time that the dormant pass keeps',
          () => {
            quietWorkspace(4 * 24 * 60 * MINUTE_MS);
            vi.spyOn(idleStop, 'idleStopEvidence').mockResolvedValue({ activity: [], keep: ['a test blocker'] });
          },
        ],
      ])('%s does not', async (_, setup) => {
        setup();
        expect(await exitsAfterTwoQuietTicks()).toBe(true);
      });

      test.each([
        ['in report mode', 'on', 'report', false],
        ['with STIM_DAEMON report', 'report', 'on', false],
        ['once its last outcome was kept', 'on', 'on', true],
        ['whose last execution failed', 'on', 'on', false],
      ] as const)('a planned removal %s does not', async (_, maintenance, mode, kept) => {
        vi.stubEnv('STIM_DAEMON', maintenance);
        planRemoval({ kept });
        expect(await exitsAfterTwoQuietTicks(mode)).toBe(true);
      });

      test('a finished worktree waiting for its grace period keeps it until a maintenance pass clears the record, and the exit tick starts no pass', async () => {
        vi.stubEnv('STIM_DAEMON', 'on');
        awaitRemoval();
        let passes = 0;
        const maintenance = vi.spyOn(maintenanceRun, 'runMaintenance').mockImplementation(async () => {
          passes += 1;
          if (passes !== 2) return;
          const state = readMaintenanceState();
          if (state) writeFileSync(maintenanceStateFile(), JSON.stringify({ ...state, nextRemoval: undefined }));
        });
        const started = Date.now();
        let exited = false;
        const daemon = (async () => {
          await runStimd({ mode: 'on' });
          exited = true;
        })();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(1));
        expect(ticks()[0]?.msg).toContain('the finished worktree /w/merged becomes removable at');
        await vi.advanceTimersByTimeAsync(3 * 5 * MINUTE_MS);
        await vi.waitFor(() => expect(exited).toBe(true));
        await daemon;
        expect(ticks().map(({ at }) => Math.round((at - started) / MINUTE_MS))).toEqual([1, 6, 11, 16]);
        expect(maintenance).toHaveBeenCalledTimes(3);
      });

      test('a finished worktree the last worktree check kept for its grace period does', async () => {
        vi.stubEnv('STIM_DAEMON', 'on');
        awaitRemoval();
        expect(await exitsAfterTwoQuietTicks()).toBe(false);
      });

      test.each([
        ['in report mode', 'on', 'report', 'true'],
        ['with STIM_DAEMON report', 'report', 'on', 'true'],
        ['with maintenance.removeFinishedWorktrees false', 'on', 'on', 'false'],
      ] as const)(
        'a finished worktree waiting for its grace period %s does not',
        async (_, maintenance, mode, removeFinished) => {
          vi.stubEnv('STIM_DAEMON', maintenance);
          vi.stubEnv('STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES', removeFinished);
          awaitRemoval();
          expect(await exitsAfterTwoQuietTicks(mode)).toBe(true);
        },
      );
    });

    test("a command's hello brings a quiet daemon back to the 60 s tick", async () => {
      quietWorkspace();
      let exited = false;
      const daemon = (async () => {
        await runStimd({ mode: 'on' });
        exited = true;
      })();
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(1));
      expect(readDaemonSnapshot()).toMatchObject({ intervalMs: 5 * MINUTE_MS });
      expect(await ensureStimd({ ...process.env, STIM_DAEMON: 'on' })).toBe(true);
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(2));
      saveConfig({ version: 2, projects: {}, repos: {} });
      await vi.advanceTimersByTimeAsync(3 * 5 * MINUTE_MS);
      await vi.waitFor(() => expect(exited).toBe(true));
      await daemon;
    });

    function records(event: string): Record<string, unknown>[] {
      return readFileSync(daemonNdjsonFile(), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === event);
    }

    test('the daemon_tick record carries how long each phase of the tick took, and the daemon_maintenance record the slow passes', async () => {
      saveConfig({ version: 2, projects: {}, repos: {} });
      freeMb = 10 * 1024;
      const measured = await measure.measureTick(null, Date.now());
      const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
      vi.spyOn(measure, 'measureTick').mockImplementation(() => after(7000, measured));
      vi.spyOn(idlePass, 'runIdlePass').mockImplementation(() => after(1000, []));
      vi.spyOn(stages, 'runDormantPass').mockImplementation(() => after(2000, []));
      vi.spyOn(dependencies, 'runDormantDependencies').mockImplementation(() => after(3000, []));
      vi.spyOn(ladder, 'runLadder').mockImplementation(() =>
        after(4000, {
          actions: [],
          pressure: { level: 'normal', disk: 'normal', memory: 'normal', reasons: [], memoryWarningSince: null },
        }),
      );
      vi.spyOn(maintenanceRun, 'runMaintenance').mockImplementation(() => after(5000, undefined));
      vi.spyOn(reclaim, 'reclaimForBootWaiters').mockImplementation(() => after(6000, null));
      const daemon = runStimd({ mode: 'on' });
      await vi.advanceTimersByTimeAsync(MINUTE_MS + 29_000);
      await vi.waitFor(() => expect(records('daemon_maintenance')).toHaveLength(1));
      expect(records('daemon_tick')[0]).toMatchObject({
        tickMs: 20_000,
        phases: { measureMs: 7000, idleMs: 1000, dormantMs: 2000, ladderMs: 4000, reclaimMs: 6000 },
        eventLoopDelay: { maxMs: expect.any(Number), p99Ms: expect.any(Number) },
      });
      expect(records('daemon_maintenance')[0]).toMatchObject({
        tookMs: 8000,
        phases: { fingerprintMs: expect.any(Number), dependenciesMs: 3000, maintenanceMs: 5000 },
      });
      await vi.advanceTimersByTimeAsync(2 * 5 * MINUTE_MS);
      await daemon;
    });

    test('a slow maintenance pass runs beside the ticks: they keep their cadence and serve boot waiters, no second pass starts before it ends, and the daemon outlives it', async () => {
      saveConfig({ version: 2, projects: {}, repos: {} });
      const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
      const maintenance = vi
        .spyOn(maintenanceRun, 'runMaintenance')
        .mockImplementationOnce(() => after(12 * MINUTE_MS, undefined));
      const reclaims = vi.spyOn(reclaim, 'reclaimForBootWaiters').mockResolvedValue(null);
      const started = Date.now();
      let exited = false;
      const daemon = (async () => {
        await runStimd({ mode: 'on' });
        exited = true;
      })();

      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(2 * 5 * MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(3));
      expect(reclaims).toHaveBeenCalledTimes(3);
      expect(maintenance).toHaveBeenCalledTimes(1);
      expect(records('daemon_maintenance')).toEqual([]);
      expect(ticks()[2]?.msg).toContain('nothing running; automatic maintenance runs');

      await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
      await vi.waitFor(() => expect(records('daemon_maintenance')).toHaveLength(1));
      expect(exited).toBe(false);
      await vi.advanceTimersByTimeAsync(3 * 5 * MINUTE_MS);
      await vi.waitFor(() => expect(exited).toBe(true));
      await daemon;
      expect(maintenance).toHaveBeenCalledTimes(2);
      expect(ticks().map(({ at }) => Math.round((at - started) / MINUTE_MS))).toEqual([1, 6, 11, 16, 21]);
    });

    test('a tick serves boot waiters while its disk pass waits behind a long unit of the maintenance lane', async () => {
      saveConfig({ version: 2, projects: {}, repos: {} });
      freeMb = 10 * 1024;
      let finishUnit!: (actions: []) => void;
      const longUnit = new Promise<[]>((resolve) => (finishUnit = resolve));
      vi.spyOn(dependencies, 'runDormantDependencies').mockImplementationOnce(() => longUnit);
      vi.spyOn(ladder, 'runLadder').mockImplementation(async (_input, pressure) => ({ actions: [], pressure }));
      const reclaims = vi.spyOn(reclaim, 'reclaimForBootWaiters').mockResolvedValue(null);
      let exited = false;
      const daemon = (async () => {
        await runStimd({ mode: 'on' });
        exited = true;
      })();

      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.waitFor(() => expect(ticks()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await vi.waitFor(() => expect(reclaims).toHaveBeenCalledTimes(2));
      const ticksWhileWaiting = ticks().length;

      finishUnit([]);
      await vi.waitFor(() => expect(ticks()).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(3 * 5 * MINUTE_MS);
      await vi.waitFor(() => expect(exited).toBe(true));
      await daemon;
      expect(ticksWhileWaiting).toBe(1);
    });

    describe('work that never ends', () => {
      let selfKills: number;

      beforeEach(() => {
        selfKills = 0;
        const kill = process.kill.bind(process);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid !== process.pid || signal !== 'SIGKILL') return kill(pid, signal);
          selfKills += 1;
          return true;
        });
      });

      function never<T>(): { promise: Promise<T>; end: (value: T) => void } {
        let end!: (value: T) => void;
        return { promise: new Promise<T>((resolve) => (end = resolve)), end };
      }

      test('a maintenance pass that never ends is named every 10 minutes and changes nothing else: ticks go on and stimd stays up', async () => {
        quietWorkspace();
        const pass = never<Awaited<ReturnType<typeof maintenanceRun.runMaintenance>>>();
        vi.spyOn(maintenanceRun, 'runMaintenance').mockReturnValue(pass.promise);
        let exited = false;
        const daemon = (async () => {
          await runStimd({ mode: 'on' });
          exited = true;
        })();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(1));

        await vi.advanceTimersByTimeAsync(6 * 60 * MINUTE_MS);
        expect(records('daemon_step_running').map((record) => record.step)).toEqual(Array(36).fill('maintenance'));
        expect(ticks().length).toBeGreaterThanOrEqual(72);
        expect(records('daemon_exited')).toEqual([]);
        expect(exited).toBe(false);

        pass.end(undefined);
        saveConfig({ version: 2, projects: {}, repos: {} });
        await vi.advanceTimersByTimeAsync(3 * 5 * MINUTE_MS);
        await vi.waitFor(() => expect(exited).toBe(true));
        await daemon;
        expect(selfKills).toBe(0);
      });

      test('a tick whose measurement never ends is named every 10 minutes', async () => {
        quietWorkspace();
        const first = await measure.measureTick(null, Date.now());
        const stuck = never<typeof first>();
        vi.spyOn(measure, 'measureTick').mockResolvedValueOnce(first).mockReturnValue(stuck.promise);
        const daemon = runStimd({ mode: 'on' });
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(1));

        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS + 20 * MINUTE_MS);
        expect(records('daemon_step_running').map((record) => record.step)).toEqual(['measure', 'measure']);
        expect(ticks()).toHaveLength(1);
        expect(records('daemon_exited')).toEqual([]);

        stuck.end(first);
        process.emit('SIGTERM', 'SIGTERM');
        await daemon;
      });

      test('a SIGTERM while a maintenance pass never ends is forced at 10 minutes, names the pass and records an abnormal boot', async () => {
        quietWorkspace();
        const pass = never<Awaited<ReturnType<typeof maintenanceRun.runMaintenance>>>();
        vi.spyOn(maintenanceRun, 'runMaintenance').mockReturnValue(pass.promise);
        const daemon = runStimd({ mode: 'on' });
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(1));

        process.emit('SIGTERM', 'SIGTERM');
        await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 1000);
        expect(selfKills).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(records('daemon_shutdown_timeout')).toEqual([
          expect.objectContaining({ waiting: ['the maintenance pass'] }),
        ]);
        expect(selfKills).toBe(1);
        expect(readStimdBoots()).toEqual([
          expect.objectContaining({ pid: process.pid, abnormal: true, reason: expect.stringContaining('forced exit') }),
        ]);

        pass.end(undefined);
        await daemon;
      });

      test('a SIGTERM while a maintenance pass runs ends stimd once the pass stops on the abort, with no kill and its claims released', async () => {
        quietWorkspace();
        vi.spyOn(maintenanceRun, 'runMaintenance').mockImplementation(
          (_trigger, options) =>
            new Promise((resolve) =>
              options?.tick?.operation.signal.addEventListener('abort', () => setTimeout(resolve, 9 * MINUTE_MS), {
                once: true,
              }),
            ),
        );
        let exited = false;
        const daemon = (async () => {
          await runStimd({ mode: 'on' });
          exited = true;
        })();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        await vi.waitFor(() => expect(ticks()).toHaveLength(1));

        process.emit('SIGTERM', 'SIGTERM');
        await vi.advanceTimersByTimeAsync(9 * MINUTE_MS);
        await vi.waitFor(() => expect(exited).toBe(true));
        await daemon;
        await vi.advanceTimersByTimeAsync(20 * MINUTE_MS);
        expect(selfKills).toBe(0);
        expect(records('daemon_shutdown_timeout')).toEqual([]);
        expect(readClaimSet(stimdClaimRoot()).live).toEqual([]);
        expect(readClaimSet(daemonClaimRoot()).live).toEqual([]);
      });

      test('the shutdown deadline does not kill stimd while an engine switch it runs holds the store locks', async () => {
        quietWorkspace();
        const flip = never<null>();
        vi.spyOn(engineFollow, 'followEngine').mockReturnValue({
          engine: { root: join(home, 'engine'), build: 'b0b0b0b0b0b0' },
          record: () => {},
          admit: async () => null,
          check: () => flip.promise,
          selecting: () => flip.promise.then(() => undefined),
          release: () => {},
        });
        let exited = false;
        const daemon = (async () => {
          await runStimd({ mode: 'on' });
          exited = true;
        })();
        await vi.advanceTimersByTimeAsync(MINUTE_MS + 1000);
        process.emit('SIGTERM', 'SIGTERM');

        await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);
        expect(records('daemon_shutdown_waits')).toHaveLength(1);
        expect(selfKills).toBe(0);
        expect(exited).toBe(false);

        flip.end(null);
        await vi.waitFor(() => expect(exited).toBe(true));
        await daemon;
        await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);
        expect(selfKills).toBe(0);
      });
    });
  },
);

test('an owned simulator is not pending dormancy while the simulator listing fails, since the dormant pass keeps it', async () => {
  const root = quietWorkspace();
  const config = loadConfig();
  expect(await pendingDormant(config, { simsFailed: true }, { graceMs: 0 })).toBe(root);
  upsertProject(root, { platforms: { ios: { deviceUdid: 'U1', owned: true } } });
  expect(await pendingDormant(loadConfig(), { simsFailed: false }, { graceMs: 0 })).toBe(root);
  expect(await pendingDormant(loadConfig(), { simsFailed: true }, { graceMs: 0 })).toBeNull();
});
