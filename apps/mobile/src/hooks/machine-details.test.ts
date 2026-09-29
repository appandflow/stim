import { act, renderHook } from '@testing-library/react-native';

import type { StimConnection } from '@/lib/connection';
import type { MachineDetails } from '@/protocol/types';

import { useMachineDetails } from './machine-details';

function fakeConnection(replies: MachineDetails[]) {
  const request = jest.fn(() => Promise.resolve(replies.shift()!));
  return { request } as unknown as StimConnection;
}

const READY: MachineDetails = { gc: {}, stats: {}, buildMachines: [], measuredAt: 'now' };
const PENDING: MachineDetails = {
  gc: {},
  stats: {},
  buildMachines: null,
  buildMachinesPending: true,
  measuredAt: 'now',
};
const SETTLED: MachineDetails = {
  gc: {},
  stats: {},
  buildMachines: [{ machine: 'mini', state: 'approved' }],
  buildMachinesAt: 'now',
  measuredAt: 'now',
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('re-asks shortly while build machines are pending, and stops once they settle', async () => {
  const connection = fakeConnection([PENDING, PENDING, SETTLED]);
  const { result } = await renderHook(() => useMachineDetails(connection, true));
  await act(async () => {});
  expect(connection.request).toHaveBeenCalledTimes(1);
  expect(result.current).toEqual({ kind: 'ready', details: PENDING });

  await act(async () => jest.advanceTimersByTime(2_000));
  expect(connection.request).toHaveBeenCalledTimes(2);

  await act(async () => jest.advanceTimersByTime(2_000));
  expect(connection.request).toHaveBeenCalledTimes(3);
  expect(result.current).toEqual({ kind: 'ready', details: SETTLED });

  // Settled: no more short re-polls, only the normal 60s refresh.
  await act(async () => jest.advanceTimersByTime(2_000));
  expect(connection.request).toHaveBeenCalledTimes(3);
});

test('gives up short re-polling after the cap and falls back to the normal refresh', async () => {
  const replies = Array.from({ length: 40 }, () => PENDING);
  const connection = fakeConnection(replies);
  await renderHook(() => useMachineDetails(connection, true));
  await act(async () => {});
  expect(connection.request).toHaveBeenCalledTimes(1);

  await act(async () => jest.advanceTimersByTime(30_000));
  const callsWhilePending = (connection.request as jest.Mock).mock.calls.length;
  expect(callsWhilePending).toBeGreaterThan(1);
  expect(callsWhilePending).toBeLessThan(20);

  // No calls until the next 60s tick once the short-poll cap is spent.
  await act(async () => jest.advanceTimersByTime(29_000));
  expect(connection.request).toHaveBeenCalledTimes(callsWhilePending);
  await act(async () => jest.advanceTimersByTime(1_000));
  expect(connection.request).toHaveBeenCalledTimes(callsWhilePending + 1);
});

test('ready on the first reply', async () => {
  const connection = fakeConnection([READY]);
  const { result } = await renderHook(() => useMachineDetails(connection, true));
  await act(async () => {});
  expect(result.current).toEqual({ kind: 'ready', details: READY });
  await act(async () => jest.advanceTimersByTime(2_000));
  expect(connection.request).toHaveBeenCalledTimes(1);
});
