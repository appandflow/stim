import type { ControlEndedEvent } from '@/protocol/types';
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
      protocol: 1,
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
  await act(async () => begins[0]!({ session: 'c1', platform: 'ios', lease: null, postures: [] }));

  expect(request.mock.calls).toEqual([
    ['control.begin', { workspace: '/app', platform: 'ios', slot: 'default' }],
    ['control.end', { session: 'c1' }],
  ]);
});

test('ignores simulator options returned by an ended connection with a reused session id', async () => {
  let finish: (value: unknown) => void = () => {};
  const begun = {
    session: 'c1',
    platform: 'ios',
    lease: null,
    postures: [],
    simulator: { canShake: true, slowAnimations: false },
  };
  const request = jest.fn((method: string) =>
    method === 'control.begin'
      ? Promise.resolve(begun)
      : method === 'input.simulator'
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve({}),
  );
  const first = { request, onControlEnded: () => () => {}, reconnect: () => {} };
  const opened = {
    kind: 'open' as const,
    protocol: 1,
    server: { name: 'stim-server', version: '1', stim: '1' },
    actions: null,
    capabilities: ['control' as const],
    features: [],
    deviceId: null,
  };
  machines.setMacs([{ id: 'm1', name: 'Mac', endpoint: 'ws://mac', pairedAt: '2026-09-30T00:00:00Z' }], false);
  machines.patchLink('m1', { connection: first as unknown as StimConnection, state: opened });
  const { result, unmount } = await renderHook(() => useDeviceControl('/app', 'ios', 'default'));
  await act(async () => result.current.begin());
  let changing: Promise<void>;
  await act(async () => {
    changing = result.current.simulator({ action: 'slow-animations', enabled: true });
  });
  const second = {
    ...first,
    request: jest.fn((method: string) => (method === 'control.begin' ? Promise.resolve(begun) : Promise.resolve({}))),
  };
  await act(async () =>
    machines.patchLink('m1', { connection: second as unknown as StimConnection, state: { ...opened } }),
  );
  await act(async () => result.current.begin());
  await act(async () => {
    finish({ canShake: true, slowAnimations: true });
    await changing!;
  });
  expect(result.current.state).toMatchObject({ kind: 'on', session: 'c1', simulator: { slowAnimations: false } });
  await unmount();
});

test('starts native Control only when the server advertises native window input', async () => {
  const request = jest.fn((method: string) =>
    method === 'control.begin'
      ? Promise.resolve({ session: 'native', platform: 'macos', lease: null, postures: [] })
      : Promise.resolve({}),
  );
  const connection = { request, onControlEnded: () => () => {}, reconnect: () => {} };
  const state = {
    kind: 'open' as const,
    protocol: 1,
    server: { name: 'stim-server', version: '1', stim: '1' },
    actions: null,
    capabilities: ['control' as const],
    features: ['macos-window'],
    deviceId: null,
  };
  machines.setMacs([{ id: 'm1', name: 'Mac', endpoint: 'ws://mac', pairedAt: '2026-09-30T00:00:00Z' }], false);
  machines.patchLink('m1', { connection: connection as unknown as StimConnection, state });
  const { result, unmount } = await renderHook(() => useDeviceControl('/app', 'macos', 'default'));
  await act(async () => result.current.begin());
  expect(request).not.toHaveBeenCalled();
  await act(async () =>
    machines.patchLink('m1', { state: { ...state, features: ['macos-window', 'macos-window-control'] } }),
  );
  await act(async () => result.current.begin());
  expect(result.current.state.kind).toBe('on');
  await act(async () => {
    result.current.scroll(0.5, 0.6, 0, -40);
    result.current.key('a', ['command']);
    result.current.selectWindow(12);
    result.current.selectWindow(null);
  });
  expect(request.mock.calls).toEqual([
    ['control.begin', { workspace: '/app', platform: 'macos', slot: 'default' }],
    ['input.scroll', { session: 'native', x: 0.5, y: 0.6, deltaX: 0, deltaY: -40 }],
    ['input.key', { session: 'native', key: 'a', modifiers: ['command'] }],
    ['input.window', { session: 'native', window: 12 }],
    ['input.window', { session: 'native', window: null }],
  ]);
  await unmount();
});

test.each(['platform', 'postures', 'reason'])(
  'handles future control %s without reconnecting or exposing unsupported input',
  async (field) => {
    let ended: (event: ControlEndedEvent) => void = () => {};
    const request = jest.fn((method: string) =>
      Promise.resolve(
        method === 'control.begin'
          ? {
              session: 'c',
              platform: field === 'platform' ? 'future-kind' : 'ios',
              lease: null,
              postures: ['folded', 'future-kind'],
            }
          : {},
      ),
    );
    const reconnect = jest.fn();
    const connection = {
      request,
      reconnect,
      onControlEnded: (listener: typeof ended) => {
        ended = listener;
        return () => {};
      },
    };
    machines.setMacs([{ id: 'm1', name: 'Mac', endpoint: 'ws://mac', pairedAt: '2026-09-27T12:00:00Z' }], false);
    machines.patchLink('m1', {
      connection: connection as unknown as StimConnection,
      state: {
        kind: 'open',
        protocol: 1,
        server: { name: 'Mac', version: '1', stim: '1' },
        actions: null,
        capabilities: ['control'],
        features: [],
        deviceId: null,
      },
    });
    const { result, unmount } = await renderHook(() => useDeviceControl('/app', 'ios', 'default'));
    await act(async () => result.current.begin());
    if (field === 'platform') {
      expect(result.current.state.kind).toBe('off');
      expect(request).toHaveBeenCalledWith('control.end', { session: 'c' });
    } else if (field === 'postures') {
      expect(result.current.state).toMatchObject({ kind: 'on', postures: ['folded'] });
    } else {
      await act(async () =>
        ended({ event: 'control-ended', session: 'c', reason: 'future-kind', message: 'Control ended' }),
      );
      expect(result.current.state).toEqual({ kind: 'off', ended: 'Control ended' });
    }
    expect(reconnect).not.toHaveBeenCalled();
    await unmount();
  },
);
