import { act, renderHook } from '@testing-library/react-native';

import { useAction } from './workspace-actions';

const mockRequest = jest.fn();
const mockConnection = { request: mockRequest };
jest.mock('./machines', () => ({
  useMacConnection: () => ({ connection: mockConnection, state: { kind: 'open', actions: ['stop', 'reload'] } }),
}));

it('blocks concurrent actions through the whole stop-all sequence and still stops apps after a failure', async () => {
  let finish: () => void = () => {};
  mockRequest.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  mockRequest.mockRejectedValueOnce(new Error('second app failed'));
  mockRequest.mockResolvedValueOnce({});
  const { result } = await renderHook(() => useAction('/w/a'));
  let stopping: Promise<string | null>;
  await act(async () => {
    stopping = result.current.run('stop', { workspace: ['/w/a', '/w/b', '/w/c'] });
  });
  expect(result.current.pending).toBe('stop');
  await act(async () => {
    await result.current.run('reload', { workspace: '/w/c', platform: 'ios' });
  });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
    expect(await stopping).toBe('second app failed');
  });
  expect(mockRequest.mock.calls.map((call) => call[1])).toEqual([
    { action: 'stop', workspace: '/w/a' },
    { action: 'stop', workspace: '/w/b' },
    { action: 'stop', workspace: '/w/c' },
  ]);
  expect(result.current.pending).toBeNull();
});
