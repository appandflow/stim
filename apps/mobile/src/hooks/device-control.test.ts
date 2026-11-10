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

function openLink(connection: object, hostCapabilities: string[] = []) {
  machines.patchLink('m1', {
    connection: connection as unknown as StimConnection,
    state: {
      kind: 'open',
      protocol: 1,
      server: { name: 'stim-server', version: '1', stim: '1' },
      actions: null,
      capabilities: ['control'],
      hostCapabilities,
      deviceId: null,
      deviceName: null,
    },
  });
}

test('ends a control session that begins after the screen unmounted', async () => {
  const begins: ((result: unknown) => void)[] = [];
  const request = jest.fn((method: string) =>
    method === 'control.begin' ? new Promise((resolve) => begins.push(resolve)) : Promise.resolve({}),
  );
  const connection = { request, onControlEnded: () => () => {}, reconnect: () => {} };
  machines.setMacs(
    [{ id: 'm1', name: 'Mac', endpoint: 'ws://mac', pairedAt: '2026-09-30T00:00:00Z', serverKey: 'k' }],
    false,
  );
  openLink(connection);

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
    hostCapabilities: [],
    deviceId: null,
    deviceName: null,
  };
  machines.setMacs(
    [{ id: 'm1', name: 'Mac', endpoint: 'ws://mac', pairedAt: '2026-09-30T00:00:00Z', serverKey: 'k' }],
    false,
  );
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
    hostCapabilities: ['macos-window'],
    deviceId: null,
    deviceName: null,
  };
  machines.setMacs(
    [{ id: 'm1', name: 'Mac', endpoint: 'ws://mac', pairedAt: '2026-09-30T00:00:00Z', serverKey: 'k' }],
    false,
  );
  machines.patchLink('m1', { connection: connection as unknown as StimConnection, state });
  const { result, unmount } = await renderHook(() => useDeviceControl('/app', 'macos', 'default'));
  await act(async () => result.current.begin());
  expect(request).not.toHaveBeenCalled();
  await act(async () =>
    machines.patchLink('m1', { state: { ...state, hostCapabilities: ['macos-window', 'macos-window-control'] } }),
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
    machines.setMacs(
      [{ id: 'm1', name: 'Mac', endpoint: 'ws://mac', pairedAt: '2026-09-27T12:00:00Z', serverKey: 'k' }],
      false,
    );
    machines.patchLink('m1', {
      connection: connection as unknown as StimConnection,
      state: {
        kind: 'open',
        protocol: 1,
        server: { name: 'Mac', version: '1', stim: '1' },
        actions: null,
        capabilities: ['control'],
        hostCapabilities: [],
        deviceId: null,
        deviceName: null,
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

test('sends the clipboard methods on the control session and returns the device text', async () => {
  const request = jest.fn((method: string) => {
    if (method === 'control.begin')
      return Promise.resolve({ session: 'c2', platform: 'ios', lease: null, postures: [] });
    if (method === 'input.clipboard.get') return Promise.resolve({ text: 'device text' });
    return Promise.resolve({});
  });
  const connection = { request, onControlEnded: () => () => {}, reconnect: () => {} };
  openLink(connection, ['device-clipboard']);

  const { result } = await renderHook(() => useDeviceControl('/app', 'ios', 'default'));
  await act(async () => result.current.begin());
  await act(async () => {
    await result.current.clipboardSet('pasted', true);
    await result.current.clipboardSet('copied only', false);
  });
  let text = '';
  await act(async () => {
    text = await result.current.clipboardGet();
  });

  expect(text).toBe('device text');
  expect(request.mock.calls.filter(([method]) => String(method).startsWith('input.clipboard'))).toEqual([
    ['input.clipboard.set', { session: 'c2', text: 'pasted', paste: true }],
    ['input.clipboard.set', { session: 'c2', text: 'copied only' }],
    ['input.clipboard.get', { session: 'c2' }],
  ]);
});

test('begins control again, without taking over, when the connection that held it is replaced', async () => {
  let sessions = 0;
  const makeConnection = () => ({
    request: jest.fn((method: string) =>
      Promise.resolve(
        method === 'control.begin' ? { session: `c${++sessions}`, platform: 'ios', lease: null, postures: [] } : {},
      ),
    ),
    onControlEnded: () => () => {},
    reconnect: () => {},
  });
  machines.setMacs(
    [{ id: 'm1', name: 'Mac', endpoint: 'ws://mac', pairedAt: '2026-09-30T00:00:00Z', serverKey: 'k' }],
    false,
  );
  const first = makeConnection();
  openLink(first);
  const { result } = await renderHook(() => useDeviceControl('/app', 'ios', 'default'));
  await act(async () => result.current.begin());
  expect(result.current.state).toMatchObject({ kind: 'on', session: 'c1' });

  await act(async () => machines.patchLink('m1', { state: { kind: 'connecting' } }));
  expect(result.current.state.kind).toBe('off');
  expect(first.request.mock.calls.filter(([method]) => method === 'control.begin')).toHaveLength(1);

  const second = makeConnection();
  await act(async () => openLink(second));
  expect(second.request.mock.calls).toContainEqual([
    'control.begin',
    { workspace: '/app', platform: 'ios', slot: 'default' },
  ]);
  expect(result.current.state).toMatchObject({ kind: 'on', session: 'c2' });
});

test('leaves a session the person ended off when the connection is replaced', async () => {
  const makeConnection = () => ({
    request: jest.fn((method: string) =>
      Promise.resolve(method === 'control.begin' ? { session: 'c1', platform: 'ios', lease: null, postures: [] } : {}),
    ),
    onControlEnded: () => () => {},
    reconnect: () => {},
  });
  machines.setMacs(
    [{ id: 'm1', name: 'Mac', endpoint: 'ws://mac', pairedAt: '2026-09-30T00:00:00Z', serverKey: 'k' }],
    false,
  );
  openLink(makeConnection());
  const { result } = await renderHook(() => useDeviceControl('/app', 'ios', 'default'));
  await act(async () => result.current.begin());
  await act(async () => result.current.end());
  const second = makeConnection();
  await act(async () => openLink(second));
  expect(second.request).not.toHaveBeenCalled();
  expect(result.current.state.kind).toBe('off');
});
