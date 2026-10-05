import { act, renderHook } from '@testing-library/react-native';

import { useWorkspaceBuildPlans } from './build-plans';

const mockReplies: ((value: unknown) => void)[] = [];
const mockConnection = {
  request: jest.fn(
    () =>
      new Promise((resolve) => {
        mockReplies.push(resolve);
      }),
  ),
};
jest.mock('./machines', () => ({ useMacConnection: () => ({ connection: mockConnection, state: { kind: 'open' } }) }));

it('checks each app and cancels only the app that starts building, ignoring its late reply', async () => {
  const requests = [
    { workspace: '/a', builds: { ios: 'a' }, building: false },
    { workspace: '/b', builds: { android: 'b' }, building: false },
  ];
  const { result, rerender } = await renderHook(
    ({ requests }: { requests: Parameters<typeof useWorkspaceBuildPlans>[0] }) => useWorkspaceBuildPlans(requests),
    { initialProps: { requests } },
  );
  expect(mockConnection.request.mock.calls).toEqual([
    ['build.plan', { workspace: '/a', platform: 'ios' }],
    ['build.plan', { workspace: '/b', platform: 'android' }],
  ]);
  await rerender({ requests: [requests[0], { ...requests[1], building: true }] });
  await act(async () => {
    mockReplies[0]({ cacheHit: true });
    mockReplies[1]({ cacheHit: false });
  });
  expect(result.current('/a', 'ios')?.kind).toBe('done');
  expect(result.current('/b', 'android')).toBeUndefined();
  expect(mockConnection.request).toHaveBeenCalledTimes(2);
});
