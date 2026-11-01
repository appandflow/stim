import 'react-native-unistyles/mocks';
import 'react-native-gesture-handler/jestSetup';

import { act, renderRouter, screen } from 'expo-router/testing-library';
import { AppState } from 'react-native';
import { router } from 'expo-router';

import '@/design/unistyles';

import { statusViews } from '@stim-cli/core/phone-protocol';
import statusFixture from '../mock-server/fixtures/status.json';

// expo-router/testing-library mocks Reanimated with `react-native-reanimated/mock`, which throws while loading under
// Reanimated 4.7 and leaves an empty module, so the mock it loads is replaced.
jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));

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
jest.mock('@/lib/socket', () => ({ createSocket: () => new MockSocket() }));

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
      getBoolean: (key: string) => (store.has(key) ? store.get(key) === 'true' : undefined),
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

/** Answers `hello` and the status feeds like stim-server, with the mock server's captured status. */
class MockSocket {
  static sent: string[] = [];
  static features = ['status-views'];
  static fullStatus: object = statusFixture.payload;
  static viewStatus = statusFixture.payload;
  static homeId: string | undefined;
  static holdWorkspaces = false;
  static latest: MockSocket | null = null;
  onopen: ((serverKey: string) => void) | null = null;
  onmessage: ((text: string) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readyState = 0;
  feed: ReturnType<typeof setInterval> | undefined;

  constructor() {
    MockSocket.latest = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.('server-key');
    }, 0);
  }

  send(raw: string) {
    const { id, method } = JSON.parse(raw) as { id: number; method: string };
    MockSocket.sent.push(method);
    const reply = (message: object) => setTimeout(() => this.onmessage?.(JSON.stringify(message)), 0);
    if (method === 'hello') {
      reply({
        id,
        result: {
          protocol: 1,
          server: {
            id: MockSocket.homeId,
            name: 'Mock Mac',
            version: '0.0.0-mock',
            stim: statusFixture.stimVersion,
            home: statusFixture.home,
          },
          capabilities: ['read', 'control'],
          actions: ['reload', 'stop'],
          device: { id: 'phone', name: 'Phone' },
          features: MockSocket.features,
        },
      });
    } else if (method === 'status.subscribe') {
      reply({ id, result: { subscription: 's0' } });
      this.feed = setInterval(
        () => reply({ event: 'status', subscription: 's0', payload: MockSocket.fullStatus }),
        1000,
      );
    } else if (method === 'workspaces.subscribe' || method === 'machine.subscribe') {
      const views = statusViews(MockSocket.viewStatus as Parameters<typeof statusViews>[0]);
      const subscription = method === 'workspaces.subscribe' ? 's1' : 's2';
      reply({ id, result: { subscription } });
      const { workspaces, worktrees, archived, machine } = views;
      if (method === 'workspaces.subscribe' && MockSocket.holdWorkspaces) return;
      reply(
        method === 'workspaces.subscribe'
          ? { event: 'workspaces', subscription, seq: 0, snapshot: { workspaces, worktrees, archived } }
          : { event: 'machine', subscription, seq: 0, machine },
      );
    } else if (method === 'archived.list') {
      const archivedList = statusFixture.payload.archived ?? [];
      reply({ id, result: { archived: archivedList, usage: statusFixture.payload.archivedUsage, next: null } });
    } else {
      reply({ id, error: { code: 'not-implemented', message: `The boot test does not serve ${method}.` } });
    }
  }

  close() {
    clearInterval(this.feed);
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
    JSON.stringify([
      {
        id: MAC_ID,
        name: 'Mock Mac',
        endpoint: ENDPOINT,
        pairedAt: '2026-09-01T00:00:00.000Z',
        serverKey: 'server-key',
      },
    ]),
  );
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
  seedPreviousInstall();
  const activate = launchInactive();
  const errors: string[] = [];
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation((...args) => void errors.push(args.map(String).join(' ')));
  const info = jest.spyOn(console, 'info').mockImplementation(() => {});
  const readyLogs = () => info.mock.calls.filter(([message]) => message === '[stim:readiness] ready').length;

  await renderRouter('./src/app', { initialUrl: '/' });
  expect(screen.getByTestId('splash-overlay')).toBeTruthy();
  await act(() => jest.advanceTimersByTimeAsync(0));
  expect(readyLogs()).toBe(0);
  await act(() => jest.advanceTimersByTimeAsync(400));
  expect(screen.getByTestId('splash-overlay')).toBeTruthy();
  expect(readyLogs()).toBe(1);
  await act(() => jest.advanceTimersByTimeAsync(600));
  expect(MockSocket.sent).toContain('workspaces.subscribe');
  await act(async () => {
    activate();
    await jest.advanceTimersByTimeAsync(1000);
  });
  consoleError.mockRestore();

  expect(errors).toEqual([]);
  expect(screen.queryByTestId('splash-overlay')).toBeNull();
  expect(readyLogs()).toBe(1);
  expect(screen.getAllByText('Mock Mac').length).toBeGreaterThan(0);
  expect(mockStore('stim.app').get('marker')).not.toBe(PREVIOUS_MARKER);
  expect(mockStore('stim.status').has(`status:${MAC_ID}`)).toBe(false);
  expect(JSON.parse(mockStore('stim.notifications').get('prefs')!)).toMatchObject({ enabled: true });
  const state = JSON.parse(mockStore('stim.notifications').get('state')!) as Record<string, { workspaces?: object }>;
  expect(state[`status:${MAC_ID}`]?.workspaces).toBeDefined();
}, 60_000);

it('opens a workspace directly without relying on Home to provide the gesture root', async () => {
  jest.restoreAllMocks();
  mockStores.clear();
  seedPreviousInstall();
  const activate = launchInactive();
  const errors: string[] = [];
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation((...args) => void errors.push(args.map(String).join(' ')));
  const path = statusFixture.payload.environments[0]!.path;

  await renderRouter('./src/app', { initialUrl: `/mac/${MAC_ID}/workspace?path=${encodeURIComponent(path)}` });
  await act(() => jest.advanceTimersByTimeAsync(1000));
  await act(async () => {
    activate();
    await jest.advanceTimersByTimeAsync(1000);
  });
  consoleError.mockRestore();

  expect(errors).toEqual([]);
  expect(screen.getByText('Work')).toBeTruthy();
}, 60_000);

afterEach(() => {
  MockSocket.features = ['status-views'];
  MockSocket.fullStatus = statusFixture.payload;
  MockSocket.viewStatus = statusFixture.payload;
  MockSocket.homeId = undefined;
  MockSocket.holdWorkspaces = false;
});

it('follows the full status feed of a Mac whose server does not serve the status views', async () => {
  jest.restoreAllMocks();
  mockStores.clear();
  MockSocket.sent = [];
  MockSocket.features = [];
  const [first, ...rest] = statusFixture.payload.environments;
  if (!first) throw new Error('the captured status lists a workspace');
  MockSocket.fullStatus = { ...statusFixture.payload, environments: [{ ...first, memoryMb: 9216 }, ...rest] };
  seedPreviousInstall();
  const activate = launchInactive();

  await renderRouter('./src/app', {
    initialUrl: `/mac/${MAC_ID}/workspace?path=${encodeURIComponent(first.path)}`,
  });
  await act(() => jest.advanceTimersByTimeAsync(1000));
  await act(async () => {
    activate();
    await jest.advanceTimersByTimeAsync(1000);
  });

  expect(MockSocket.sent).toContain('status.subscribe');
  expect(MockSocket.sent).not.toContain('workspaces.subscribe');
  await act(() => jest.advanceTimersByTimeAsync(1000));
  expect(screen.getByText(/^9\.0\sGB$/)).toBeTruthy();
}, 60_000);

it('does not resolve a shared link from previous workspace views after reconnect', async () => {
  jest.restoreAllMocks();
  mockStores.clear();
  MockSocket.homeId = '871c7262-f6bc-469a-b822-15da928350ee';
  const workspace = '0123456789abcdef';
  const [first, ...rest] = statusFixture.payload.environments;
  if (!first) throw new Error('the captured status lists a workspace');
  const identified = { ...first, workspaceId: workspace };
  MockSocket.viewStatus = { ...statusFixture.payload, environments: [identified, ...rest] };
  seedPreviousInstall();
  const activate = launchInactive();
  const result = renderRouter('./src/app', { initialUrl: '/' });
  await result;
  await act(async () => {
    activate();
    await jest.advanceTimersByTimeAsync(2000);
  });
  const previous = MockSocket.latest;
  if (!previous) throw new Error('the paired Mac connected');
  MockSocket.holdWorkspaces = true;
  MockSocket.viewStatus = { ...statusFixture.payload, environments: [] };
  await act(async () => {
    previous.close();
    previous.onclose?.({ code: 1006, reason: 'reconnect' });
    router.push(`/open?v=1&machine=${MockSocket.homeId}&workspace=${workspace}`);
    await jest.advanceTimersByTimeAsync(100);
  });
  expect(screen.getByText('Reconnect')).toBeTruthy();
  await act(async () => {
    router.replace('/');
    await jest.advanceTimersByTimeAsync(4900);
    router.push(`/open?v=1&machine=${MockSocket.homeId}&workspace=${workspace}`);
    await jest.advanceTimersByTimeAsync(1000);
  });
  expect(result.getPathname()).toBe('/open');
  const current = MockSocket.latest;
  if (!current || current === previous) throw new Error('the paired Mac reconnected');
  await act(async () => {
    current.onmessage?.(
      JSON.stringify({
        event: 'workspaces',
        subscription: 's1',
        seq: 0,
        snapshot: { workspaces: [], worktrees: [], archived: null },
      }),
    );
    await jest.advanceTimersByTimeAsync(1000);
  });
  expect(result.getPathname()).toBe('/open');
}, 60_000);
