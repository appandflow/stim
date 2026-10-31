import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type HostedMacosPlacement,
  type HostedNativePlacement,
  type HostedIosDevice,
  type HostedAndroidDevice,
} from '@stim-cli/core/state';
import {
  connectHost,
  settle,
  POLL_MS,
  PREPARE_TIMEOUT_MS,
  IMAGE_INSTALL_TIMEOUT_MS,
  type HostConnection,
} from '../device-host/hosted-client.ts';
import { placeHostedMacos } from '../device-host/hosted-macos.ts';
import { placeHostedNative, prepareHostedNative } from '../device-host/hosted-native.ts';
import { BuildConnection } from '../offload/client.ts';
import { operationState } from '../engine/operation-state.ts';
import { withAmbientContext } from '@stim-cli/core';
import { testContext } from './_context.ts';

const run = vi.hoisted((): { signal?: AbortSignal } => ({}));
vi.mock('../engine/native-run.ts', async (original) => ({
  ...(await original<typeof import('../engine/native-run.ts')>()),
  runCancellationSignal: () => run.signal,
}));
vi.mock('../device-host/hosted-client.ts', async (original) => ({
  ...(await original<typeof import('../device-host/hosted-client.ts')>()),
  connectHost: vi.fn<typeof connectHost>(),
}));

const session = '12345678-1234-1234-1234-123456789abc';
const devices = {
  ios: {
    udid: 'abcdef12-1234-1234-1234-123456789abc',
    name: 'stim-hosted',
    deviceType: 'iPhone 17 Pro',
    deviceTypeId: 'iphone',
    runtime: '27.0',
    runtimeId: 'ios27',
    architecture: 'arm64',
  },
  android: {
    avdName: 'stim-hosted',
    serial: 'emulator-5554',
    consolePort: 5554,
    systemImage: 'system-images;android-34;google_apis;arm64-v8a',
    deviceProfile: 'pixel_7',
    architecture: 'arm64-v8a',
  },
  macos: { appSlot: 1, architecture: 'arm64', macosVersion: '27.0' },
} as const;
type Placement = HostedMacosPlacement | HostedNativePlacement<HostedIosDevice | HostedAndroidDevice>;

describe.each(['ios', 'android', 'macos'] as const)('hosted %s preparation deadline', (platform) => {
  let home: string;
  let root: string;
  let host: HostConnection;
  let methods: { method: string; at: number; params: unknown }[];
  let pendingState: string;
  let readyAt: number;
  let readyDevice: unknown;
  let installing: boolean;
  let notice: string | undefined;
  let recorded: Placement | undefined;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-hosted-preparation-')));
    vi.stubEnv('STIM_HOME', home);
    root = join(home, 'app');
    mkdirSync(join(root, 'Fixture.app'), { recursive: true });
    writeFileSync(join(root, 'Fixture.app', 'Info.plist'), 'fixture');
    writeFileSync(join(root, 'App.apk'), 'fixture');
    methods = [];
    pendingState = 'preparing';
    readyAt = 240_000;
    readyDevice = devices[platform];
    installing = false;
    run.signal = undefined;
    notice = undefined;
    recorded = undefined;
    const connection = Object.create(BuildConnection.prototype) as BuildConnection;
    connection.close = vi.fn<() => void>();
    connection.supports = () => true;
    connection.request = async (method, params) => {
      methods.push({ method, params, at: Date.now() });
      if (method === 'device-host.offer')
        return {
          result: {
            platform,
            choice: devices[platform],
            declined: null,
            capacity: { available: 1 },
            resources: {
              cpus: 4,
              loadPerCore: 0,
              memoryFreeBytes: 1000,
              workerDiskFreeBytes: null,
              memoryPressure: 'normal',
            },
          },
        };
      if (method === 'device-host.reserve' || method === 'device-host.attach') {
        const state = Date.now() >= readyAt ? 'ready' : pendingState;
        return {
          result: {
            id: session,
            platform,
            appSlot: 1,
            state,
            device: state === 'ready' ? readyDevice : null,
            ...(notice ? { notice } : {}),
          },
        };
      }
      if (method === 'device-host.metro.close') return { result: {} };
      if (method === 'device-host.app.offer') return { result: { missing: [] } };
      if (method === 'device-host.app.launch' || method === 'device-host.app.attach')
        return { result: installing ? { state: 'installing' } : { state: 'installed', launched: true } };
      throw new Error(`Unexpected fixture request ${method}`);
    };
    host = {
      machine: 'mini',
      credential: {
        machine: 'mini',
        transport: 'tailscale',
        address: 'mini.tail.ts.net',
        deviceId: 'client',
        serverKey: 'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKA',
        state: 'approved',
        requestedAt: '2026-10-09T00:00:00Z',
      },
      connection,
    };
    vi.mocked(connectHost).mockResolvedValue(host);
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  function resume() {
    const common = {
      machine: 'mini',
      session,
      appAttempt: 'previous',
      agent: { driver: 'none', setting: 'hosting.agentDriver' },
    } as const;
    recorded =
      platform === 'macos'
        ? { ...common, appSlot: 1, bundleId: 'dev.fixture.hosted1' }
        : { ...common, selected: 'mini', device: null };
  }

  async function place() {
    if (platform === 'macos')
      return placeHostedMacos(host, {
        root,
        bundle: join(root, 'Fixture.app'),
        bundleId: 'dev.fixture',
        arguments: [],
        recorded: recorded as HostedMacosPlacement | undefined,
        reserved: (value) => {
          recorded = value;
        },
        note: () => {},
      });
    const target = await prepareHostedNative(
      'mini',
      {},
      recorded as HostedNativePlacement<HostedIosDevice | HostedAndroidDevice> | undefined,
      platform,
    );
    return placeHostedNative(target, {
      root,
      slot: 'default',
      bundle: join(root, platform === 'android' ? 'App.apk' : 'Fixture.app'),
      bundleId: 'dev.fixture',
      selectors: {},
      release: true,
      platform,
      reserved: (value) => {
        recorded = value;
      },
      note: () => {},
    });
  }

  test.each([false])('bounds unresolved preparation and retains its owner (resumed: %s)', async (resumed) => {
    if (resumed) resume();
    readyAt = Infinity;
    let settled = false;
    const result = place().catch((error: unknown) => {
      settled = true;
      return error;
    });
    const waitsForImage = resumed && platform === 'android';
    await vi.advanceTimersByTimeAsync(356_000);
    expect(settled).toBe(!waitsForImage);
    await vi.advanceTimersByTimeAsync(waitsForImage ? IMAGE_INSTALL_TIMEOUT_MS : 0);
    expect(await result).toBeInstanceOf(Error);
    expect(String(await result)).toContain('stayed preparing');
    expect(recorded?.session).toBe(session);
    expect(methods.some(({ method }) => method.startsWith('device-host.app.'))).toBe(false);
    expect(methods.filter(({ method }) => method === 'device-host.reserve')).toHaveLength(resumed ? 0 : 1);
  });

  test('stops waiting for the app installation when the run is cancelled', async () => {
    readyAt = 0;
    installing = true;
    const controller = new AbortController();
    run.signal = controller.signal;
    let outcome: string | undefined;
    void place().then(
      () => (outcome = 'placed'),
      (error: unknown) => (outcome = String(error)),
    );
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect(outcome).toBeUndefined();
    expect(methods.some(({ method }) => method === 'device-host.app.attach')).toBe(true);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toContain('hosted app installation was cancelled');
  });

  test.skipIf(platform === 'macos')(
    'Ctrl-C while the app is delivered drains the run and closes the host connection',
    async () => {
      readyAt = 0;
      const runAbort = new AbortController();
      run.signal = runAbort.signal;
      const context = testContext();
      const request = host.connection.request.bind(host.connection);
      let release: ((reply: Awaited<ReturnType<typeof request>>) => void) | undefined;
      host.connection.request = (method, params) =>
        method === 'device-host.app.offer'
          ? new Promise((resolve) => {
              release = resolve;
            })
          : request(method, params);
      host.connection.close = vi.fn<() => void>(() =>
        release?.({ error: { code: 'closed', message: 'the connection was closed by this client' } }),
      );
      let outcome: string | undefined;
      void withAmbientContext(context, place).then(
        () => (outcome = 'placed'),
        (error: unknown) => (outcome = String(error)),
      );
      await vi.advanceTimersByTimeAsync(10 * POLL_MS);
      expect(release).toBeDefined();
      expect(outcome).toBeUndefined();
      runAbort.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(operationState(context).draining).toBe(true);
      expect(host.connection.close).toHaveBeenCalled();
      expect(outcome).toContain('closed by this client');
    },
  );

  test('still refuses a ready reply without the reserved device identity', async () => {
    readyDevice = null;
    const result = place().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(241_000);
    expect(await result).toBeInstanceOf(Error);
    expect(String(await result)).toMatch(/reserved architecture|offered architecture|reserved macOS app slot/);
    expect(recorded?.session).toBe(session);
    expect(methods.some(({ method }) => method.startsWith('device-host.app.'))).toBe(false);
  });
});

describe('hosted session settle cancellation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a cancelled run stops waiting within one poll interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const connection: BuildConnection = Object.create(BuildConnection.prototype);
    connection.request = async () => ({ result: { id: session, platform: 'ios', state: 'preparing', device: null } });
    const host: HostConnection = {
      machine: 'mini',
      credential: {
        machine: 'mini',
        transport: 'tailscale',
        address: 'mini.tail.ts.net',
        deviceId: 'client',
        serverKey: 'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKA',
        state: 'approved',
        requestedAt: '2026-10-09T00:00:00Z',
      },
      connection,
    };
    const controller = new AbortController();
    let outcome: unknown;
    void settle(
      host,
      { id: session, state: 'preparing', device: null },
      ['preparing'],
      PREPARE_TIMEOUT_MS,
      'ios',
      controller.signal,
    ).then(
      (value) => (outcome = { value }),
      (error: unknown) => (outcome = { error }),
    );
    await vi.advanceTimersByTimeAsync(10 * POLL_MS + 1);
    expect(outcome).toBeUndefined();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ error: { code: 'STIM_CANCELLED' } });
  });
});
