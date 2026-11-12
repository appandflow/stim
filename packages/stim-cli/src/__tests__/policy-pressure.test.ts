import type { DaemonPressure, PressureLevel } from '@stim-cli/core/state';
import { linkedFirst, sourceDependenciesDue } from '../policy/checkout-order.ts';
import { longestIdleFirst, rungDecision, rungsFrom } from '../policy/pressure.ts';

const pressure = (disk: PressureLevel, memory: PressureLevel): DaemonPressure => ({
  level: [disk, memory].includes('critical') ? 'critical' : [disk, memory].includes('high') ? 'high' : 'normal',
  disk,
  memory,
  reasons: [],
  memoryWarningSince: null,
});

const runs = (measured: DaemonPressure, fromRung?: number) =>
  rungsFrom(fromRung).flatMap(({ rung, relieves }) => {
    const decision = rungDecision(measured, relieves);
    return typeof decision === 'string' ? [] : [[rung, decision.level, decision.causes]];
  });

describe('the pressure ladder', () => {
  test('rungs run top-down from the first rung asked, each only for the causes it relieves', () => {
    expect(runs(pressure('high', 'normal'), 2)).toEqual([
      [2, 'high', ['disk']],
      [3, 'high', ['disk']],
      [4, 'high', ['disk']],
      [5, 'high', ['disk']],
      [6, 'high', ['disk']],
      [7, 'high', ['disk']],
      [8, 'high', ['disk']],
      [9, 'high', ['disk']],
    ]);
    expect(runs(pressure('normal', 'high'))).toEqual([
      [0, 'high', ['memory']],
      [6, 'high', ['memory']],
    ]);
  });

  test('a rung runs at critical only when a cause it relieves is critical', () => {
    expect(runs(pressure('high', 'critical'))).toEqual([
      [0, 'critical', ['memory']],
      [1, 'high', ['disk']],
      [2, 'high', ['disk']],
      [3, 'high', ['disk']],
      [4, 'high', ['disk']],
      [5, 'high', ['disk']],
      [6, 'critical', ['disk', 'memory']],
      [7, 'high', ['disk']],
      [8, 'high', ['disk']],
      [9, 'high', ['disk']],
    ]);
  });

  test('normal pressure stops the ladder, and a rung that relieves no raised cause is skipped', () => {
    expect(rungsFrom().map(({ relieves }) => rungDecision(pressure('normal', 'normal'), relieves))).toEqual(
      Array(10).fill('stop'),
    );
    expect(rungDecision(pressure('critical', 'normal'), ['memory'])).toBe('skip');
  });
});

describe('the workspaces a stage takes', () => {
  test('a workspace with a blocker is skipped and the longest-idle comes first', () => {
    expect(
      longestIdleFirst([
        { path: '/recent', idleMs: 5 },
        { path: '/kept', idleMs: null },
        { path: '/oldest', idleMs: 30 },
        { path: '/old', idleMs: 20 },
      ]).map(({ path }) => path),
    ).toEqual(['/oldest', '/old', '/recent']);
  });
});

describe('a source checkout among the workspaces', () => {
  test('linked worktrees come first and each role keeps its longest-idle order', () => {
    const ordered = linkedFirst(
      longestIdleFirst([
        { path: '/main', idleMs: 90, role: 'source' as const },
        { path: '/a', idleMs: 10, role: 'linked' as const },
        { path: '/main-2', idleMs: 40, role: 'source' as const },
        { path: '/b', idleMs: 30, role: 'linked' as const },
      ]),
    );
    expect(ordered.map(({ path }) => path)).toEqual(['/b', '/a', '/main', '/main-2']);
  });
});

describe('when a source checkout loses its dependencies', () => {
  const DAY = 86_400_000;
  const base = { dormantMs: 7 * DAY, criticalIdleMs: 120_000 };

  test('not at high pressure while idle less than idle.sourceDormantDays, but at that age on any level', () => {
    expect(sourceDependenciesDue({ ...base, level: 'high', idleMs: 6 * DAY })).toBeNull();
    expect(sourceDependenciesDue({ ...base, level: 'normal', idleMs: 6 * DAY })).toBeNull();
    expect(sourceDependenciesDue({ ...base, level: 'normal', idleMs: 7 * DAY })).toBe('dormant');
    expect(sourceDependenciesDue({ ...base, level: 'high', idleMs: 7 * DAY })).toBe('dormant');
  });

  test('at critical once idle for the critical threshold, whatever idle.sourceDormantDays says', () => {
    expect(sourceDependenciesDue({ ...base, level: 'critical', idleMs: 60_000 })).toBeNull();
    expect(sourceDependenciesDue({ ...base, level: 'critical', idleMs: 120_000 })).toBe('critical');
    expect(sourceDependenciesDue({ ...base, dormantMs: 0, level: 'critical', idleMs: 120_000 })).toBe('critical');
  });

  test('idle.sourceDormantDays 0 never deletes for idleness', () => {
    expect(sourceDependenciesDue({ ...base, dormantMs: 0, level: 'normal', idleMs: 365 * DAY })).toBeNull();
  });
});
