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
    ...options,
  });
}

test('a client that is connected keeps its session and clears the absence recorded earlier', () => {
  const result = plan([session('a', { clientAbsentMs: 5 * HOUR_MS })], {
    connected: (client) => client === 'client-a',
  });

  expect(result.updates).toEqual([{ id: 'a', absentMs: null }]);
  expect(result.stops).toEqual([]);
});

test('a client that only acted through an agent request counts as present for that sweep', () => {
  const result = plan([session('a', { clientAbsentMs: 5 * HOUR_MS })], { active: new Set(['a']) });

  expect(result.updates).toEqual([{ id: 'a', absentMs: null }]);
  expect(result.stops).toEqual([]);
});

test('an absence under the window accumulates and stops nothing; reaching the window stops with the reason', () => {
  const under = plan([session('a', { clientAbsentMs: 6 * HOUR_MS - 2 * HOSTED_IDLE_SWEEP_MS })]);
  expect(under.updates).toEqual([{ id: 'a', absentMs: 6 * HOUR_MS - HOSTED_IDLE_SWEEP_MS }]);
  expect(under.stops).toEqual([]);

  const over = plan([session('a', { clientAbsentMs: 6 * HOUR_MS - HOSTED_IDLE_SWEEP_MS })]);
  expect(over.stops).toEqual([
    { id: 'a', reason: 'its client had no connection for 6h 0m, over maintenance.idleStopHours' },
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

test('a due session with unresolved work or ownership is kept with the reason, not stopped', () => {
  const result = plan([session('a', { clientAbsentMs: 7 * HOUR_MS })], {
    unresolved: () => 'its native input is not provably finished',
  });

  expect(result.stops).toEqual([]);
  expect(result.kept).toEqual([
    expect.objectContaining({ id: 'a', reason: expect.stringContaining('its native input is not provably finished') }),
  ]);
});

test('a window of 0 stops nothing and forgets recorded absence, so enabling it later counts from nothing', () => {
  const result = plan([session('a', { clientAbsentMs: 99 * HOUR_MS }), session('b')], { windowMs: 0 });

  expect(result.stops).toEqual([]);
  expect(result.kept).toEqual([]);
  expect(result.updates).toEqual([{ id: 'a', absentMs: null }]);
});
