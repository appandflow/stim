import { act, renderHook } from '@testing-library/react-native';

import type { StimConnection } from '@/lib/connection';
import type { createMachineStore } from '@/lib/machine-store';

import { useDeviceControl } from './device-control';

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'm1' }) }));
jest.mock('@/storage', () => ({ statusStorage: {} }));
jest.mock('@/lib/machine-store', () => {
  const actual = jest.requireActual<typeof import('@/lib/machine-store')>('@/lib/machine-store');
  const created: ReturnType<typeof actual.createMachineStore>[] = [];
  return {
    ...actual,
    created,
    createMachineStore: () => {
      const machines = actual.createMachineStore();
      created.push(machines);
      return machines;
    },
  };
});

const machines = (jest.requireMock('@/lib/machine-store') as { created: ReturnType<typeof createMachineStore>[] })
  .created[0]!;

test('ends a control session that begins after the screen unmounted', async () => {
  const begins: ((result: unknown) => void)[] = [];
  const request = jest.fn((method: string) =>
    method === 'control.begin' ? new Promise((resolve) => begins.push(resolve)) : Promise.resolve({}),
  );
  const connection = { request, onControlEnded: () => () => {}, reconnect: () => {} };
  machines.setMacs([{ id: 'm1', name: 'Mac', endpoint: 'ws://mac', pairedAt: '2026-09-30T00:00:00Z' }], false);
  machines.patchLink('m1', {
    connection: connection as unknown as StimConnection,
    state: {
      kind: 'open',
      server: { name: 'stim-server', version: '1', stim: '1' },
      actions: null,
      capabilities: ['control'],
      features: [],
      deviceId: null,
    },
  });

  const { result, unmount } = await renderHook(() => useDeviceControl('/app', 'ios', 'default'));
  await act(async () => result.current.begin());
  await unmount();
  await act(async () => begins[0]!({ session: 'c1', lease: null, postures: [] }));

  expect(request.mock.calls).toEqual([
    ['control.begin', { workspace: '/app', platform: 'ios', slot: 'default' }],
    ['control.end', { session: 'c1' }],
  ]);
});
