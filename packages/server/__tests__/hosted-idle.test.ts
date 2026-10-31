import { HOSTED_IDLE_SWEEP_MS, planHostedIdleStops } from '../src/hosted-idle.ts';

const HOUR_MS = 3_600_000;

function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, client: `client-${id}`, state: 'ready' as const, ...extra };
}

function plan(
  sessions: ReturnType<typeof session>[],
  options: Partial<Parameters<typeof planHostedIdleStops>[0]> = {},
) {
  return planHostedIdleStops({
    sessions,
    connected: () => false,
    active: new Set(),
    elapsedMs: HOSTED_IDLE_SWEEP_MS,
    windowMs: 6 * HOUR_MS,
    unresolved: () => null,
    foreign: () => false,
    ...options,
  });
}

test('an agent request for one session keeps every session of that client', () => {
  const sessions = [
    session('a', { client: 'shared', clientAbsentMs: 5 * HOUR_MS }),
    session('b', { client: 'shared', clientAbsentMs: 5 * HOUR_MS }),
  ];

  const result = plan(sessions, { active: new Set(['a']) });

  expect(result.updates).toEqual([
    { id: 'a', absentMs: null },
    { id: 'b', absentMs: null },
  ]);
});

test('time the server was down or asleep is not counted, and a stored absence survives a restart', () => {
  const afterOutage = plan([session('a', { clientAbsentMs: HOUR_MS })], { elapsedMs: 9 * HOUR_MS });
  expect(afterOutage.updates).toEqual([{ id: 'a', absentMs: HOUR_MS + 2 * HOSTED_IDLE_SWEEP_MS }]);
  expect(afterOutage.stops).toEqual([]);

  const firstSweepAfterRestart = plan([session('a', { clientAbsentMs: 6 * HOUR_MS })], { elapsedMs: 0 });
  expect(firstSweepAfterRestart.stops.map(({ id }) => id)).toEqual(['a']);

  const freshSession = plan([session('b')], { elapsedMs: 0 });
  expect(freshSession.updates).toEqual([{ id: 'b', absentMs: 0 }]);
  expect(freshSession.stops).toEqual([]);
});

test('a session that is not ready, or is parked, is never tracked or stopped', () => {
  const result = plan(
    ['preparing', 'stopping', 'stopped', 'unknown']
      .map((state) => session(state, { state, clientAbsentMs: 7 * HOUR_MS }))
      .concat(session('parked', { parked: { at: new Date().toISOString() }, clientAbsentMs: 7 * HOUR_MS })),
  );

  expect(result.stops).toEqual([]);
  expect(result.kept).toEqual([]);
  expect(result.updates.map(({ absentMs }) => absentMs)).toEqual([null, null, null, null, null]);
});

test('a session another live server owns is neither counted nor stopped', () => {
  const result = plan([session('a', { clientAbsentMs: 7 * HOUR_MS })], { foreign: () => true });

  expect(result).toEqual({ updates: [], stops: [], kept: [] });
});

test('a window of 0 stops nothing and forgets recorded absence, so enabling it later counts from nothing', () => {
  const result = plan([session('a', { clientAbsentMs: 99 * HOUR_MS }), session('b')], { windowMs: 0 });

  expect(result.stops).toEqual([]);
  expect(result.kept).toEqual([]);
  expect(result.updates).toEqual([{ id: 'a', absentMs: null }]);
});
