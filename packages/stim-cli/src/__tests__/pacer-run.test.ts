import type { DaemonPressure } from '@stim-cli/core/state';
import type { DiskPassInput, DiskPassResult, HomePasses } from '../daemon/passes.ts';
import { createDiskPacer } from '../daemon/pacer.ts';
import { runDiskPacer } from '../daemon/pacer-run.ts';
import { testContext } from './_context.ts';

const minute = 60_000;
const normal: DaemonPressure = {
  level: 'normal',
  disk: 'normal',
  memory: 'normal',
  reasons: [],
  memoryWarningSince: null,
};

function tick(freeMb = 2 * 1024): HomePasses {
  return {
    config: { version: 2, projects: {}, repos: {} },
    now: Date.now(),
    measured: {
      measurement: {
        disk: [
          { device: 1, volume: '/builds', freeMb },
          { device: 2, volume: '/other', freeMb: 100 * 1024 },
        ],
        memory: { level: 'normal', availableBytes: null, totalBytes: 0 },
        load1: 0,
        cores: 1,
        bootedSimulators: 0,
        runningEmulators: 0,
        interaction: null,
      },
      sims: [],
      simsError: null,
      devices: [],
    },
    workspaces: [],
    pressure: normal,
    actions: [],
    phases: { measureMs: 0, idleMs: 0, dormantMs: 0, ladderMs: 0 },
    operation: testContext({
      env: {
        ...process.env,
        STIM_HOME: '/nonexistent-stim-pacer-home',
        STIM_DISK_MIN_FREE_GB: '1',
        STIM_DISK_CRITICAL_FREE_GB: '0',
        STIM_DISK_HARD_FLOOR_GB: '0',
      },
    }),
    ladder: null,
  };
}

function filling() {
  const pacer = createDiskPacer();
  pacer.observe(
    [
      { device: 1, freeMb: 8 * 1024, level: 'normal' },
      { device: 2, freeMb: 100 * 1024, level: 'normal' },
    ],
    Date.now() - 2 * minute,
  );
  pacer.observe(
    [
      { device: 1, freeMb: 5 * 1024, level: 'normal' },
      { device: 2, freeMb: 100 * 1024, level: 'normal' },
    ],
    Date.now() - minute,
  );
  return pacer;
}

test.each([minute, 5 * minute])(
  'normal measured pressure targets only the filling device using actual cadence %d',
  async (intervalMs) => {
    const pacer = filling();
    const diskPass = vi.fn<(input: DiskPassInput) => Promise<DiskPassResult>>(async () => ({
      actions: [],
      pressure: normal,
    }));
    const result = await runDiskPacer({ pacer, passes: tick(), intervalMs, act: true, diskPass, log: () => {} });
    expect(diskPass).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        pressure: normal,
        requested: false,
        act: true,
        target: { device: 1, freeMb: 1024 + (3 * 1024 * intervalMs) / minute },
      }),
    );
    expect(result.pressure).toEqual(normal);
    expect(result.intervalMs).toBe(intervalMs);
    expect(result.status.find(({ device }) => device === 2)).toMatchObject({ fillMbPerSecond: 0 });
  },
);

test('genuine critical ends prediction and schedules normal ranked admission immediately', async () => {
  const pacer = filling();
  pacer.recordPredictive(1, 2 * 1024, 4 * 1024, Date.now() - minute);
  const critical: DaemonPressure = { ...normal, level: 'critical', disk: 'critical' };
  const diskPass = vi.fn<(input: DiskPassInput) => Promise<DiskPassResult>>(async () => ({
    actions: [],
    pressure: critical,
  }));
  const result = await runDiskPacer({
    pacer,
    passes: tick(),
    intervalMs: 5 * minute,
    act: true,
    diskPass,
    log: () => {},
  });
  expect(diskPass).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ pressure: critical, intervalMs: 0 });
  expect(result.status.every(({ predictive }) => predictive === undefined)).toBe(true);
});

test('only first-free measurements train lead; completed byte estimates do not', async () => {
  const pacer = filling();
  const passes = tick();
  const diskPass = vi.fn<(input: DiskPassInput) => Promise<DiskPassResult>>(async () => ({
    actions: [
      { rung: 3, kind: 'empty-cache', target: '/cache', outcome: 'done', bytes: 100 * 1024 ** 3, detail: 'estimated' },
    ],
    pressure: normal,
  }));
  await runDiskPacer({ pacer, passes, intervalMs: minute, act: true, diskPass, log: () => {} });
  expect(pacer.status().find(({ device }) => device === 1)?.firstFreeMs).toBeNull();
  passes.firstFree = [{ device: 1, startedAt: Date.now() - 30_000, observedAt: Date.now() }];
  await runDiskPacer({ pacer, passes, intervalMs: minute, act: true, log: () => {} });
  expect(pacer.status().find(({ device }) => device === 1)?.firstFreeMs).toBe(30_000);
});

test('admitted predictive evidence persists only until its actual target clears', async () => {
  const pacer = filling();
  const admittedAt = Date.now() - 1000;
  const result: DiskPassResult = {
    actions: [],
    pressure: normal,
    predictive: { device: 1, targetFreeMb: 4 * 1024, admittedAt, freeMb: 2 * 1024, checkedAt: Date.now() },
  };
  const diskPass = vi.fn<(input: DiskPassInput) => Promise<DiskPassResult>>(async () => result);
  const run = () => runDiskPacer({ pacer, passes: tick(), intervalMs: minute, act: true, diskPass, log: () => {} });
  expect((await run()).status.find(({ device }) => device === 1)?.predictive).toMatchObject({
    since: admittedAt,
    targetFreeMb: 4 * 1024,
  });
  result.predictive = {
    ...result.predictive,
    device: 1,
    targetFreeMb: 4 * 1024,
    admittedAt,
    freeMb: 5 * 1024,
    checkedAt: Date.now(),
  };
  expect((await run()).status.find(({ device }) => device === 1)?.predictive).toBeUndefined();
});

test('an unavailable owner provides rates without an inline cleanup or stale admitted episode', async () => {
  const pacer = filling();
  pacer.recordPredictive(1, 2 * 1024, 4 * 1024, Date.now() - minute);
  const passes = tick();
  const result = await runDiskPacer({ pacer, passes, intervalMs: minute, act: true, log: () => {} });
  expect(passes.actions).toEqual([]);
  expect(result.status.find(({ device }) => device === 1)).toMatchObject({ fillMbPerSecond: (3 * 1024) / 60 });
  expect(result.status.every(({ predictive }) => predictive === undefined)).toBe(true);
});
