import { classifyPressure, diskThresholds, type DiskThresholds } from '../daemon/pressure.ts';

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-02T12:00:00Z');
const thresholds: DiskThresholds = { highMb: 20 * 1024, criticalMb: 6 * 1024, hardFloorMb: 5 * 1024 };
const calm = { level: 'normal' as const, availableBytes: 8 * GIB, totalBytes: 16 * GIB };

function classify(
  disk: number[],
  memory: Parameters<typeof classifyPressure>[0]['memory'] = calm,
  previousWarningSince: string | null = null,
) {
  return classifyPressure({
    disk: disk.map((gb, index) => ({ volume: `/v${index}`, freeMb: gb * 1024 })),
    memory,
    thresholds,
    previousWarningSince,
    now: NOW,
  });
}

test.each([
  { free: [100], level: 'normal' },
  { free: [19.9], level: 'high' },
  { free: [5.9], level: 'critical' },
  { free: [100, 19], level: 'high' },
  { free: [19, 3], level: 'critical' },
])('free disk $free GB on the volumes is $level', ({ free, level }) => {
  const pressure = classify(free);
  expect(pressure.disk).toBe(level);
  expect(pressure.level).toBe(level);
  expect(pressure.reasons).toHaveLength(free.filter((gb) => gb < 20).length);
});

test('memory warning raises the level only after 10 minutes, and the clock carries across ticks', () => {
  const warning = { ...calm, level: 'warning' as const };
  const first = classify([100], warning);
  expect(first).toMatchObject({ level: 'normal', memoryWarningSince: new Date(NOW).toISOString() });
  const nineMinutes = new Date(NOW - 9 * 60_000).toISOString();
  expect(classify([100], warning, nineMinutes)).toMatchObject({ level: 'normal', memoryWarningSince: nineMinutes });
  const tenMinutes = new Date(NOW - 10 * 60_000).toISOString();
  expect(classify([100], warning, tenMinutes)).toMatchObject({ level: 'high', memory: 'high', disk: 'normal' });
  expect(classify([100], calm, tenMinutes)).toMatchObject({ level: 'normal', memoryWarningSince: null });
});

test('critical memory pressure is critical at once, and low available memory is high', () => {
  expect(classify([100], { ...calm, level: 'critical' })).toMatchObject({ level: 'critical', memory: 'critical' });
  expect(classify([100], { ...calm, availableBytes: 1.5 * GIB })).toMatchObject({ level: 'high', memory: 'high' });
  expect(classify([100], { level: null, availableBytes: null, totalBytes: 16 * GIB }).level).toBe('normal');
});

test('the higher of the disk and memory levels wins', () => {
  expect(classify([19], { ...calm, level: 'critical' }).level).toBe('critical');
  expect(classify([4], { ...calm, availableBytes: GIB }).level).toBe('critical');
});

describe('diskThresholds', () => {
  test('a scoped Stim home applies its configured floors, and the critical floor is never under the hard floor', () => {
    const config = {
      projects: {},
      repos: {},
      budget: { minFreeDiskGb: 1, hardFloorDiskGb: 1 },
      disk: { minFreeGb: 200, hardFloorGb: 8, criticalFreeGb: 6 },
    };
    expect(diskThresholds(config, { STIM_HOME: '/tmp/home' })).toEqual({
      thresholds: { highMb: 200 * 1024, criticalMb: 8 * 1024, hardFloorMb: 8 * 1024 },
      error: null,
    });
  });

  test('the environment overrides the machine config, and an invalid value is an error', () => {
    expect(diskThresholds({ projects: {}, repos: {} }, { STIM_DISK_CRITICAL_FREE_GB: '9' }).thresholds.criticalMb).toBe(
      9 * 1024,
    );
    expect(diskThresholds({ projects: {}, repos: {} }, {}).thresholds).toEqual({
      highMb: 40 * 1024,
      criticalMb: 20 * 1024,
      hardFloorMb: 5 * 1024,
    });
    expect(diskThresholds({ projects: {}, repos: {} }, { STIM_DISK_HARD_FLOOR_GB: 'lots' }).error).toMatch(
      /STIM_DISK_HARD_FLOOR_GB/,
    );
  });
});
