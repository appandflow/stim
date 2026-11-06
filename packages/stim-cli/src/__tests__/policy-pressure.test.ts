import type { DaemonPressure, PressureLevel } from '@stim-cli/core/state';
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
    ]);
  });

  test('normal pressure stops the ladder, and a rung that relieves no raised cause is skipped', () => {
    expect(rungsFrom().map(({ relieves }) => rungDecision(pressure('normal', 'normal'), relieves))).toEqual(
      Array(7).fill('stop'),
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
