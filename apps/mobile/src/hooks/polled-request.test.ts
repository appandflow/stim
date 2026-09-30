import { act, renderHook } from '@testing-library/react-native';

import { RequestError, type StimConnection } from '@/lib/connection';

import { usePolledRequest } from './polled-request';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function fakeConnection() {
  const pending: Pending[] = [];
  const request = jest.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  return { connection: { request } as unknown as StimConnection, request, pending };
}

const unknownMethod = () => new RequestError({ code: 'unknown-method', message: 'no' });

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const poll = (connection: StimConnection, active = true) =>
  renderHook(
    (props: { active: boolean }) => usePolledRequest(connection, 'machine.get', {}, { intervalMs: 1_000, ...props }),
    { initialProps: { active } },
  );

test('asks at once and on each interval, and returns the latest answer', async () => {
  const { connection, request, pending } = fakeConnection();
  const { result } = await poll(connection);
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => jest.advanceTimersByTime(2_000));
  expect(request).toHaveBeenCalledTimes(3);
  await act(async () => pending[2]!.resolve({ n: 3 }));
  expect(result.current.data).toEqual({ n: 3 });
});

test('drops an answer older than one already delivered', async () => {
  const { connection, pending } = fakeConnection();
  const { result } = await poll(connection);
  await act(async () => jest.advanceTimersByTime(1_000));
  await act(async () => pending[1]!.resolve({ n: 2 }));
  await act(async () => pending[0]!.resolve({ n: 1 }));
  expect(result.current.data).toEqual({ n: 2 });
});

test('stops asking after unknown-method and reports the error', async () => {
  const { connection, request, pending } = fakeConnection();
  const { result } = await poll(connection);
  await act(async () => pending[0]!.reject(unknownMethod()));
  await act(async () => jest.advanceTimersByTime(5_000));
  expect(request).toHaveBeenCalledTimes(1);
  expect(result.current.error).toBeInstanceOf(RequestError);
});

test('keeps asking after another failure and keeps the last answer', async () => {
  const { connection, request, pending } = fakeConnection();
  const { result } = await poll(connection);
  await act(async () => pending[0]!.resolve({ n: 1 }));
  await act(async () => jest.advanceTimersByTime(1_000));
  await act(async () => pending[1]!.reject(new Error('down')));
  expect(request).toHaveBeenCalledTimes(2);
  expect(result.current.data).toEqual({ n: 1 });
  expect(result.current.error?.message).toBe('down');
});

test('stops the interval when it goes inactive and asks again when it returns', async () => {
  const { connection, request } = fakeConnection();
  const { rerender } = await poll(connection);
  await rerender({ active: false });
  await act(async () => jest.advanceTimersByTime(5_000));
  expect(request).toHaveBeenCalledTimes(1);
  await rerender({ active: true });
  expect(request).toHaveBeenCalledTimes(2);
});

test('does not ask without a connection', async () => {
  const { request } = fakeConnection();
  await renderHook(() => usePolledRequest(null, 'machine.get', {}, { intervalMs: 1_000, active: true }));
  await act(async () => jest.advanceTimersByTime(3_000));
  expect(request).not.toHaveBeenCalled();
});

test('sends once without an interval', async () => {
  const { connection, request } = fakeConnection();
  await renderHook(() => usePolledRequest(connection, 'machine.get', {}, { active: true }));
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(request).toHaveBeenCalledTimes(1);
});

test('stops and ignores late answers after unmount', async () => {
  const { connection, request, pending } = fakeConnection();
  const onData = jest.fn();
  const { unmount } = await renderHook(() =>
    usePolledRequest(connection, 'machine.get', {}, { intervalMs: 1_000, active: true, onData }),
  );
  await unmount();
  await act(async () => jest.advanceTimersByTime(5_000));
  await act(async () => pending[0]!.resolve({ n: 1 }));
  expect(request).toHaveBeenCalledTimes(1);
  expect(onData).not.toHaveBeenCalled();
});

test('refetch asks outside the interval', async () => {
  const { connection, request } = fakeConnection();
  const { result } = await poll(connection);
  await act(async () => result.current.refetch());
  expect(request).toHaveBeenCalledTimes(2);
});
