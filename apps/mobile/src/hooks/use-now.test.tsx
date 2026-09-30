import { act, renderHook } from '@testing-library/react-native';

import { useNow } from './use-now';

// Rendering schedules unrelated timers, so count the clock's own by their delay: the time left to the next wall-clock multiple.
const FAST = 600;
const SLOW = 29_600;

let scheduled: jest.SpyInstance;
const armed = (delay: number) => scheduled.mock.calls.filter((call) => call[1] === delay).length;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00.400Z'));
  scheduled = jest.spyOn(globalThis, 'setTimeout');
});
afterEach(() => {
  scheduled.mockRestore();
  jest.useRealTimers();
});

test('subscribers of one interval share a single timer and tick together', async () => {
  const a = await renderHook(() => useNow(1000));
  const b = await renderHook(() => useNow(1000));
  const c = await renderHook(() => useNow(1000));
  expect(armed(FAST)).toBe(1);

  await act(async () => jest.advanceTimersByTime(FAST));
  const at = Date.parse('2026-01-01T00:00:01.000Z');
  expect([a.result.current, b.result.current, c.result.current]).toEqual([at, at, at]);
  expect(armed(1000)).toBe(1);
});

test('each interval has its own timer, and the last unsubscribe clears it', async () => {
  const fast = await renderHook(() => useNow(1000));
  const slowA = await renderHook(() => useNow(30_000));
  const slowB = await renderHook(() => useNow(30_000));
  expect(armed(FAST)).toBe(1);
  expect(armed(SLOW)).toBe(1);

  await slowA.unmount();
  await fast.unmount();
  await slowB.unmount();
  scheduled.mockClear();
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(armed(1000)).toBe(0);
  expect(armed(30_000)).toBe(0);
});

test('a mount after the clock stopped reads the current time', async () => {
  await (await renderHook(() => useNow(1000))).unmount();
  jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
  const { result } = await renderHook(() => useNow(1000));
  expect(result.current).toBe(Date.parse('2026-01-01T01:00:00.000Z'));
});
