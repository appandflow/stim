import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintenanceDir } from '@stim-cli/core/state';
import { keepReserve, releaseReserve } from '../disk-reserve.ts';
import type { DaemonPressure } from '@stim-cli/core/state';
import { acquireDisk, HARD_FLOOR, requestGcPass, requestGcItem, CRITICAL } from '../daemon/disk-owner.ts';
import { runDiskPass, type DiskPassInput } from '../daemon/passes.ts';
import * as ladder from '../daemon/ladder.ts';
import * as measure from '../daemon/measure.ts';
import { saveConfig } from '../workspace/config.ts';
import type { GcPassReply } from '../daemon/disk-owner.ts';
import { ladderRun } from '../stimd/passes/ladder-run.ts';
import { testContext } from './_context.ts';

const normal: DaemonPressure = {
  level: 'normal',
  disk: 'normal',
  memory: 'normal',
  reasons: [],
  memoryWarningSince: null,
};
let home: string;
let freeMb: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-pacer-owner-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_DISK_MIN_FREE_GB', '1');
  vi.stubEnv('STIM_DISK_CRITICAL_FREE_GB', '0.75');
  vi.stubEnv('STIM_DISK_HARD_FLOOR_GB', '0');
  saveConfig({ version: 2, projects: {}, repos: {} });
  freeMb = 2 * 1024;
  vi.spyOn(measure, 'measureDisk').mockImplementation(async () => [{ volume: '/', device: 17, freeMb }]);
  vi.spyOn(measure, 'measureMemory').mockResolvedValue({ level: 'normal', availableBytes: null, totalBytes: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const request = (): DiskPassInput => ({
  act: true,
  pressure: normal,
  devices: [],
  sims: [],
  requested: false,
  target: { device: 17, freeMb: 4 * 1024, observedAt: Date.now() },
});

test('first-free elapsed starts before the queue wait and preserves only the first observed sample per device', async () => {
  const held = await acquireDisk(HARD_FLOOR);
  const startedAt = Date.now();
  vi.spyOn(ladder, 'runLadder').mockImplementation(async (input) => {
    vi.advanceTimersByTime(250);
    input.firstFree?.observed(17, Date.now());
    vi.advanceTimersByTime(1000);
    input.firstFree?.observed(17, Date.now());
    return { actions: [], pressure: normal };
  });
  const pass = runDiskPass(request(), () => {}, testContext());
  vi.advanceTimersByTime(1000);
  held.release();
  try {
    expect((await pass).firstFree).toEqual([{ device: 17, startedAt, observedAt: startedAt + 1250 }]);
  } finally {
    held.release();
    await pass;
  }
});

test.each(['target met', 'real critical'] as const)(
  'a queued predictive turn runs no ladder after %s',
  async (change) => {
    const held = await acquireDisk(HARD_FLOOR);
    const run = vi.spyOn(ladder, 'runLadder');
    const pass = runDiskPass(request(), () => {}, testContext());
    freeMb = change === 'target met' ? 5 * 1024 : 512;
    held.release();
    try {
      const result = await pass;
      expect(run).not.toHaveBeenCalled();
      expect(result.pressure.level).toBe(change === 'target met' ? 'normal' : 'critical');
      expect(result.predictive?.admittedAt).toBeUndefined();
    } finally {
      held.release();
      await pass;
    }
  },
);

test('a predictive one-device sweep cannot cover a whole-home normal GC', async () => {
  let start = () => {};
  const started = new Promise<void>((done) => {
    start = done;
  });
  let finish = () => {};
  const working = new Promise<void>((done) => {
    finish = done;
  });
  vi.spyOn(ladder, 'runLadder').mockImplementation(async () => {
    start();
    await working;
    return { actions: [], pressure: normal };
  });
  const pass = runDiskPass(request(), () => {}, testContext());
  await started;
  const own = vi.fn<() => Promise<GcPassReply>>(async () => ({ run: ladderRun('normal', normal, []) }));
  const manual = requestGcPass('normal', 'manual', own, () => {});
  finish();
  try {
    await pass;
    expect(await manual.result).not.toHaveProperty('joined');
    expect(own).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    await Promise.allSettled([pass, manual.result]);
  }
});

test('report mode provides no reclaim observer or admitted predictive evidence', async () => {
  const run = vi.spyOn(ladder, 'runLadder').mockResolvedValue({ actions: [], pressure: normal });
  const result = await runDiskPass({ ...request(), act: false }, () => {}, testContext());
  expect(run.mock.calls[0]?.[0].firstFree).toBeUndefined();
  expect(result.firstFree).toBeUndefined();
  expect(result.predictive?.admittedAt).toBeUndefined();
});

test('a predictive owner restores the reserve after queued manual cleanup is canceled', async () => {
  let start = () => {};
  const started = new Promise<void>((done) => {
    start = done;
  });
  let finish = () => {};
  const working = new Promise<void>((done) => {
    finish = done;
  });
  vi.spyOn(ladder, 'runLadder').mockImplementation(async () => {
    start();
    await working;
    return { actions: [], pressure: normal };
  });
  keepReserve();
  const reserve = join(maintenanceDir(), 'disk-reserve');
  const pass = runDiskPass(request(), () => {}, testContext());
  await started;
  releaseReserve();
  const own = vi.fn<() => Promise<GcPassReply>>(async () => ({ run: ladderRun('normal', normal, []) }));
  const manual = requestGcPass('normal', 'manual', own, () => {});
  const canceled = manual.result.catch(() => {});
  manual.leave();
  expect(existsSync(reserve)).toBe(false);
  finish();
  try {
    await Promise.all([pass, canceled]);
    expect(own).not.toHaveBeenCalled();
    expect(existsSync(reserve)).toBe(true);
  } finally {
    finish();
    await Promise.allSettled([pass, canceled]);
  }
});

test('an expired queued forecast performs no predictive cleanup on grant', async () => {
  const held = await acquireDisk(HARD_FLOOR);
  const run = vi.spyOn(ladder, 'runLadder');
  const pass = runDiskPass(request(), () => {}, testContext());
  vi.advanceTimersByTime(5 * 60_000 + 1);
  held.release();
  try {
    expect((await pass).predictive).not.toHaveProperty('admittedAt');
    expect(run).not.toHaveBeenCalled();
  } finally {
    held.release();
    await pass;
  }
});

test('an expired forecast cannot authorize another candidate after resuming its turn', async () => {
  vi.spyOn(ladder, 'runLadder').mockImplementation(async (input) => {
    expect(input.target?.available()).toBe(freeMb);
    const higher = requestGcItem(async () => {
      vi.advanceTimersByTime(5 * 60_000 + 1);
    }, CRITICAL);
    await input.between?.();
    await higher.result;
    expect(input.target?.available()).toBeNull();
    return { actions: [], pressure: normal };
  });
  await runDiskPass(request(), () => {}, testContext());
});
