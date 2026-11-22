import { GC_MARK_VERSION, type GcMark } from '@stim-cli/core/state';
import { markHealth } from '../daemon/mark-health.ts';

const minute = 60_000;
const day = 24 * 60 * minute;
const now = Date.now();
const mark = (root: string, elapsed: number, activityAge: number | null, dirty = false): GcMark => ({
  v: GC_MARK_VERSION,
  root,
  device: 1,
  markedAt: new Date(now - elapsed).toISOString(),
  lastActivityAt: activityAge === null ? null : new Date(now - activityAge).toISOString(),
  ...(dirty ? { dirtyAt: new Date(now).toISOString() } : {}),
  candidates: [],
});

test.each([
  { age: 0, interval: 10 * minute, dirty: false },
  { age: null, interval: 10 * minute, dirty: false },
  { age: 2 * day, interval: 60 * minute, dirty: false },
  { age: 8 * day, interval: day, dirty: false },
  { age: 8 * day, interval: 10 * minute, dirty: true },
])('reports stale only after twice the current generation interval: $age, dirty=$dirty', ({ age, interval, dirty }) => {
  expect(markHealth([mark('/app', 2 * interval, age, dirty)], now, 7 * day, true).stale).toEqual([]);
  const stale = mark('/app', 2 * interval + 1, age, dirty);
  expect(markHealth([stale], now, 7 * day, true)).toMatchObject({
    state: 'ready',
    checkedRoots: 1,
    staleCount: 1,
    stale: [{ root: '/app', markedAt: stale.markedAt, intervalMs: interval }],
  });
});

test('bounds root evidence while retaining a complete aggregate', () => {
  const marks = Array.from({ length: 8 }, (_, i) => mark(`/app-${i}`, day, 0));
  const result = markHealth(marks, now, 7 * day, true);
  expect(result).toMatchObject({ state: 'ready', checkedRoots: 8, staleCount: 8 });
  expect(result.stale).toHaveLength(5);
});

test('a partial inventory retains positively authorized stale evidence without total or zero claims', () => {
  const result = markHealth([mark('/proven', day, 0)], now, 7 * day, false);
  expect(result).toMatchObject({ state: 'partial', stale: [{ root: '/proven' }] });
  expect(result).not.toHaveProperty('checkedRoots');
  expect(result).not.toHaveProperty('staleCount');
  expect(markHealth([], now, 7 * day, false)).toEqual({ at: now, state: 'unavailable', stale: [] });
  expect(markHealth([], now, 7 * day, true)).toMatchObject({ state: 'ready', checkedRoots: 0, staleCount: 0 });
});

test('invalid generation time makes coverage partial while preserving independent stale evidence', () => {
  const invalid = { ...mark('/invalid', day, 0), markedAt: 'not a date' };
  const result = markHealth([invalid, mark('/proven', day, 0)], now, 7 * day, true);
  expect(result).toMatchObject({ state: 'partial', stale: [{ root: '/proven' }] });
  expect(result).not.toHaveProperty('checkedRoots');
});

test('a recently active mark with missed ten-minute generations is overdue at twenty-one minutes', () => {
  expect(markHealth([mark('/app', 21 * minute, 0)], now, 7 * day, true)).toMatchObject({
    staleCount: 1,
    stale: [{ root: '/app' }],
  });
});

test.each(['on', 'report'] as const)('uses the effective %s writer cadence for a thirty-minute active mark', (mode) => {
  const observed = markHealth([mark('/active', 30 * minute, 0)], now, 7 * day, true, mode);
  expect(observed.staleCount).toBe(mode === 'on' ? 1 : 0);
});
