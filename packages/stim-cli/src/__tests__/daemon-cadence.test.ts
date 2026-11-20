import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonNdjsonFile,
  maintenanceStateFile,
  workspaceStateFile,
  readDaemonSnapshot,
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
import * as idlePass from '../daemon/idle.ts';
import * as ladder from '../daemon/ladder.ts';
import * as measure from '../daemon/measure.ts';
import * as reclaim from '../daemon/reclaim.ts';
import { ensureStimd } from '../daemon/client.ts';
import { admitStep, createDormantGate, noteDiskLevel, releaseStep } from '../daemon/dormant-gate.ts';
import { createMaintenanceLane, runHomePasses } from '../daemon/passes.ts';
import { runStimd } from '../stimd/main.ts';
import * as stages from '../daemon/stages.ts';
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

describe('the dormant step and the disk ladder', () => {
  const normal: DaemonPressure = {
    level: 'normal',
    disk: 'normal',
    memory: 'normal',
    reasons: [],
    memoryWarningSince: null,
  };

  async function laneInput() {
    return {
      config: loadConfig(),
      measured: await measure.measureTick(null, Date.now()),
      operation: testContext(),
      workspaces: [],
      pressure: normal,
    };
  }

  function quietTick() {
    saveConfig({ version: 2, projects: {}, repos: {} });
    freeMb = 10 * 1024;
    vi.spyOn(idlePass, 'runIdlePass').mockResolvedValue([]);
    vi.spyOn(stages, 'runDormantPass').mockResolvedValue([]);
  }

  test('the lane starts no dormant step while the disk the tick last measured is above normal, whatever pressure it was started with', async () => {
    const step = vi.spyOn(dependencies, 'runDormantDependencies').mockResolvedValue([]);
    const gate = createDormantGate();
    const lane = createMaintenanceLane(() => {}, { run: async () => {} }, new BigInt64Array(1), gate);
    for (const disk of [2, 0]) {
      noteDiskLevel(gate, disk);
      lane.start(await laneInput(), true);
      await lane.settled();
      expect(step).toHaveBeenCalledTimes(disk ? 0 : 1);
    }
  });

  test('a lane whose precompute outlasts a critical tick starts no dormant step beside its ladder, and the tick runs the step after the ladder', async () => {
    quietTick();
    const order: string[] = [];
    let ladderRuns = false;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const gate = createDormantGate();
    const cadence = new BigInt64Array(1);
    const lane = createMaintenanceLane(() => {}, { run: () => blocked }, cadence, gate);
    vi.spyOn(dependencies, 'runDormantDependencies').mockImplementation(async () => {
      order.push(ladderRuns ? 'step during the ladder' : 'step');
      return [];
    });
    vi.spyOn(ladder, 'runLadder').mockImplementation(async (input, pressure) => {
      await input.beforeDiskRung?.();
      ladderRuns = true;
      order.push('ladder');
      release();
      await lane.settled();
      ladderRuns = false;
      return { actions: [], pressure };
    });
    lane.start(await laneInput(), true);

    await runHomePasses({ act: true, log: () => {}, dormant: { cadence, gate, yieldLane: async () => {} } });

    expect(order).toEqual(['ladder', 'step']);
  });

  test('a tick that starts on memory pressure takes the turn once a fresh measurement admits a disk rung', async () => {
    quietTick();
    const order: string[] = [];
    const gate = createDormantGate();
    const cadence = new BigInt64Array(1);
    expect(admitStep(gate)).toBe(true);
    const yieldLane = vi.fn<() => Promise<void>>(async () => {
      order.push('lane stopped');
      releaseStep(gate);
    });
    const tick = await measure.measureTick(null, Date.now());
    vi.spyOn(measure, 'measureTick').mockResolvedValue({
      ...tick,
      measurement: {
        ...tick.measurement,
        disk: [{ volume: '/', freeMb: 500_000 }],
        memory: { level: 'critical', availableBytes: null, totalBytes: 16 * 1024 ** 3 },
      },
    });
    vi.spyOn(measure, 'measureDisk').mockResolvedValue([{ volume: '/', freeMb: 1024 }]);
    vi.spyOn(dependencies, 'runDormantDependencies').mockImplementation(async () => {
      order.push('step');
      return [];
    });

    await runHomePasses({ act: true, log: () => {}, dormant: { cadence, gate, yieldLane } });

    expect(order).toEqual(['lane stopped', 'step']);
  });

  test('a critical tick stops a dormant step the lane runs, gives its hour back and runs it after the ladder', async () => {
    quietTick();
    const order: string[] = [];
    const gate = createDormantGate();
    const cadence = new BigInt64Array([BigInt(Date.now())]);
    expect(admitStep(gate)).toBe(true);
    const yieldLane = vi.fn<() => Promise<void>>(async () => {
      order.push('lane stopped');
      releaseStep(gate);
    });
    vi.spyOn(ladder, 'runLadder').mockImplementation(async (input, pressure) => {
      await input.beforeDiskRung?.();
      order.push('ladder');
      return { actions: [], pressure };
    });
    vi.spyOn(dependencies, 'runDormantDependencies').mockImplementation(async (input) => {
      order.push(`step, clock ${input.cadence ? Atomics.load(input.cadence, 0) : 'none'}`);
      return [];
    });

    await runHomePasses({ act: true, log: () => {}, dormant: { cadence, gate, yieldLane } });

    expect(order).toEqual(['lane stopped', 'ladder', 'step, clock 0']);
  });
});

describe.skipIf(process.platform === 'win32')(
  'a running stim-daemon (skipped on win32, where Stim runs no daemon)',
  () => {
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
