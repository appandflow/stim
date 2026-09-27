import 'react-native-unistyles/mocks';
import 'react-native-gesture-handler/jestSetup';

import { act, renderRouter, screen } from 'expo-router/testing-library';
import { AppState } from 'react-native';

import '@/design/unistyles';

import statusFixture from '../mock-server/fixtures/status.json';

// expo-router/testing-library mocks Reanimated with `react-native-reanimated/mock`, which throws while loading under
// Reanimated 4.7 and leaves an empty module, so the mock it loads is replaced.
jest.mock('react-native-reanimated/mock', () => {
  const inert: () => unknown = () =>
    new Proxy(() => {}, { get: (_, key) => (key === 'value' ? 0 : inert()), apply: () => inert() });
  const STYLE = {};
  const sharedValue = (value: unknown) => ({
    value,
    get: () => value,
    set: () => {},
    modify: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  const named: Record<string, unknown> = {
    __esModule: true,
    interpolate: () => 0,
    isSharedValue: () => false,
    useAnimatedStyle: () => STYLE,
    useReducedMotion: () => true,
    useSharedValue: (value: unknown) => jest.requireActual('react').useState(() => sharedValue(value))[0],
    withTiming: (value: unknown) => value,
    withSpring: (value: unknown) => value,
  };
  const animated = new Proxy(
    { createAnimatedComponent: (component: unknown) => component, call: () => {} },
    {
      get: (target, key) =>
        key in target
          ? target[key as keyof typeof target]
          : (jest.requireActual('react-native') as Record<string, unknown>)[key as string],
    },
  );
  return new Proxy(named, {
    get: (target, key) => (key === 'default' ? animated : key in target ? target[key as string] : inert()),
  });
});

jest.mock('react-native-drawer-layout', () => ({
  Drawer: ({
    children,
    renderDrawerContent,
  }: {
    children: React.ReactNode;
    renderDrawerContent: () => React.ReactNode;
  }) => {
    const { GestureHandlerRootView } = jest.requireActual('react-native-gesture-handler');
    return (
      <GestureHandlerRootView>
        {renderDrawerContent()}
        {children}
      </GestureHandlerRootView>
    );
  },
  useDrawerProgress: () => ({ value: 0 }),
}));

jest.mock('lottie-react-native', () => () => null);

const mockStores = new Map<string, Map<string, string>>();
const mockStore = (id: string) => {
  let store = mockStores.get(id);
  if (!store) mockStores.set(id, (store = new Map()));
  return store;
};

jest.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const store = mockStore(id);
    return {
      getString: (key: string) => store.get(key),
      set: (key: string, value: unknown) => void store.set(key, String(value)),
      remove: (key: string) => store.delete(key),
      getAllKeys: () => [...store.keys()],
      contains: (key: string) => store.has(key),
    };
  },
}));

jest.mock('expo-secure-store', () => {
  const store = mockStore('secure-store');
  return {
    getItemAsync: async (key: string) => store.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => void store.set(key, value),
    deleteItemAsync: async (key: string) => void store.delete(key),
  };
});

jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4, LOW: 2 },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationHandler: () => {},
  setNotificationChannelAsync: async () => null,
  getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  scheduleNotificationAsync: async () => 'id',
  getExpoPushTokenAsync: async () => ({ type: 'expo', data: 'ExponentPushToken[boot-test]' }),
  addPushTokenListener: () => ({ remove: () => {} }),
  useLastNotificationResponse: () => null,
}));

const MAC_ID = 'mac1';
const ENDPOINT = 'ws://mock-mac:7787';

/** Answers `hello` and `status.subscribe` like stim-server, with the mock server's captured status. */
class FakeSocket {
  static sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;

  constructor() {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  send(raw: string) {
    const { id, method } = JSON.parse(raw) as { id: number; method: string };
    FakeSocket.sent.push(method);
    const reply = (message: object) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(message) }), 0);
    if (method === 'hello') {
      reply({
        id,
        result: {
          protocol: 1,
          server: {
            name: 'Mock Mac',
            version: '0.0.0-mock',
            stim: statusFixture.stimVersion,
            home: statusFixture.home,
          },
          capabilities: ['read', 'control'],
          actions: ['reload', 'stop'],
          device: { id: 'phone', name: 'Phone' },
        },
      });
    } else if (method === 'status.subscribe') {
      reply({ id, result: { subscription: 's1' } });
      reply({ event: 'status', subscription: 's1', payload: statusFixture.payload });
    } else {
      reply({ id, error: { code: 'not-implemented', message: `The boot test does not serve ${method}.` } });
    }
  }

  close() {
    this.readyState = 3;
  }
}

/** The status an older `stim` reported, before lifecycle phases, the owned Chrome and measured memory. */
function olderStatus() {
  return {
    ...statusFixture.payload,
    environments: statusFixture.payload.environments.map((env) => {
      const older: Record<string, unknown> = { ...env };
      delete older.phase;
      delete older.phaseSince;
      delete older.warmStep;
      delete older.web;
      delete older.memorySource;
      return older;
    }),
  };
}

const PREVIOUS_MARKER = JSON.stringify(['0.1.0', '87cad17f256996c2023667c721a6115c4dcd0015', 'previous-update']);

/** What the previous release left on a phone with a paired machine and notifications on. */
function seedPreviousInstall() {
  mockStore('stim.app').set('marker', PREVIOUS_MARKER);
  const secure = mockStore('secure-store');
  secure.set(
    'stim.macs',
    JSON.stringify([{ id: MAC_ID, name: 'Mock Mac', endpoint: ENDPOINT, pairedAt: '2026-09-01T00:00:00.000Z' }]),
  );
  secure.set(`stim.mac.${MAC_ID}.token`, 'device-token');
  mockStore('stim.status').set(
    `status:${MAC_ID}`,
    JSON.stringify({ v: 1, name: 'Mock Mac', seenAt: Date.now() - 60_000, status: olderStatus() }),
  );
  const path = statusFixture.payload.environments[0]!.path;
  const entry = { occurrence: 'a', since: 0, heldSince: 0, seenAt: Date.now() - 60_000, notifiedAt: null, done: false };
  const notifications = mockStore('stim.notifications');
  notifications.set(
    'prefs',
    JSON.stringify({ enabled: true, events: ['build-failed', 'log-errors', 'offline'], agentOnly: false }),
  );
  notifications.set(
    'state',
    JSON.stringify({ [`link:${MAC_ID}`]: {}, [`status:${MAC_ID}`]: { [`build-failed:${path}`]: entry } }),
  );
}

/**
 * iOS starts the JS while the app is still `inactive` and reports `active` after the pairings load and the machine
 * connects, so the notifier first runs on the stored state with the machine's live status.
 */
function launchInactive() {
  const listeners: ((state: string) => void)[] = [];
  Object.assign(AppState, { currentState: 'inactive' });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'change') listeners.push(listener as (state: string) => void);
    return { remove: () => {} } as ReturnType<typeof AppState.addEventListener>;
  });
  return () => {
    Object.assign(AppState, { currentState: 'active' });
    for (const listener of listeners) listener('active');
  };
}

it("clears the previous release's derived data, keeps the pairing, and renders the live machine", async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  seedPreviousInstall();
  const activate = launchInactive();
  const errors: string[] = [];
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation((...args) => void errors.push(args.map(String).join(' ')));

  await renderRouter('./src/app', { initialUrl: '/' });
  await act(() => jest.advanceTimersByTimeAsync(1000));
  expect(FakeSocket.sent).toContain('status.subscribe');
  await act(async () => {
    activate();
    await jest.advanceTimersByTimeAsync(1000);
  });
  consoleError.mockRestore();

  expect(errors).toEqual([]);
  expect(screen.getAllByText('Mock Mac').length).toBeGreaterThan(0);
  expect(mockStore('stim.app').get('marker')).not.toBe(PREVIOUS_MARKER);
  expect(mockStore('stim.status').has(`status:${MAC_ID}`)).toBe(false);
  expect(JSON.parse(mockStore('stim.notifications').get('prefs')!)).toMatchObject({ enabled: true });
  const state = JSON.parse(mockStore('stim.notifications').get('state')!) as Record<string, { workspaces?: object }>;
  expect(state[`status:${MAC_ID}`]?.workspaces).toBeDefined();
}, 60_000);
