import { runStop } from '../commands/stop.ts';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceHostMachinesFile, type HostedAndroidPlacement } from '@stim-cli/core/state';
import { BuildConnection } from '../offload/client.ts';
import { getConfigPath, getProject, upsertProject } from '../workspace/config.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { prepareHostedAndroid, placeHostedAndroid, stopHostedAndroid } from '../device-host/hosted-android.ts';
import { readHostedAndroid, writeHostedAndroid } from '../device-host/ios-state.ts';
import { applyHostedAndroidProbe } from '../device-host/hosted-android-status.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { runReload } from '../commands/reload.ts';

vi.mock('../offload/tailnet.ts', async (original) => ({
  ...(await original<typeof import('../offload/tailnet.ts')>()),
  pinnedEndpoint: () => ({ url: 'ws://127.0.0.1:12345', host: 'mini', servername: 'mini' }),
}));
const session = '12345678-1234-1234-1234-123456789abc';
const device = {
  avdName: 'stim-private-host',
  serial: 'emulator-5554',
  consolePort: 5554,
  systemImage: 'system-images;android-30;google_apis;x86_64',
  deviceProfile: 'pixel_7',
  architecture: 'x86_64' as const,
};
const placement: HostedAndroidPlacement = {
  machine: 'mini',
  selected: 'mini',
  session,
  appAttempt: 'app',
  device,
  agent: { driver: 'none', setting: 'hosting.agentDriver' },
};
let home: string;
let root: string;
let state: string;
let failure: string;
let declined: string | null;
let methods: { method: string; params: Record<string, unknown> }[];
let manifest: Buffer;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-android-host-'));
  process.env.STIM_HOME = home;
  mkdirSync(join(home, 'app'));
  root = realpathSync(join(home, 'app'));
  writeFileSync(join(root, 'App.apk'), 'fixture APK');
  writeFileSync(getConfigPath(), JSON.stringify({ hosting: { machines: ['mini'] } }));
  writeFileSync(
    deviceHostMachinesFile(),
    JSON.stringify({
      version: 1,
      machines: [
        {
          machine: 'mini',
          nodeId: 'node',
          dnsName: 'mini.tail.ts.net',
          deviceToken: 'fixture-token',
          deviceId: 'client',
          state: 'approved',
          requestedAt: '2026-10-07T12:00:00Z',
        },
      ],
    }),
  );
  state = 'ready';
  failure = '';
  declined = null;
  methods = [];
  manifest = Buffer.alloc(0);
  const connection = Object.create(BuildConnection.prototype) as BuildConnection;
  connection.close = () => {};
  connection.supports = () => true;
  connection.request = async (method, raw) => {
    const params = raw as Record<string, unknown>;
    methods.push({ method, params });
    if (failure) return { error: { code: failure, message: 'host refused' } };
    if (method === 'device-host.offer')
      return {
        result: {
          platform: 'android',
          choice: device,
          declined,
          capacity: { available: 1 },
          resources: {
            cpus: 4,
            loadPerCore: 0,
            memoryFreeBytes: 1000,
            memoryPressure: 'normal',
            workerDiskFreeBytes: null,
          },
        },
      };
    if (method === 'device-host.reserve' || method === 'device-host.attach' || method === 'device-host.stop')
      return {
        result: { id: session, platform: 'android', state: method === 'device-host.stop' ? 'stopped' : state, device },
      };
    if (method === 'device-host.app.offer')
      return {
        result: {
          missing: manifest.length
            ? JSON.parse(manifest.toString()).map((file: { sha256: string; size: number }) => ({
                sha256: file.sha256,
                size: file.size,
                offset: 0,
              }))
            : [{ ...(params.manifest as object), offset: 0 }],
        },
      };
    if (method === 'device-host.app.chunk') {
      const bytes = Buffer.from(params.data as string, 'base64');
      if (!manifest.length) manifest = bytes;
      return { result: { offset: (params.offset as number) + bytes.length } };
    }
    if (method === 'device-host.app.launch') return { result: { state: 'installed', launched: true } };
    return { result: {} };
  };
  vi.spyOn(BuildConnection, 'open').mockResolvedValue(connection);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('offers before reserving, records the owner, and sends one APK and the client Metro port', async () => {
  const target = await prepareHostedAndroid('mini', { deviceProfile: 'pixel_7' });
  const run = await placeHostedAndroid(target, {
    root,
    slot: 'tablet',
    bundle: join(root, 'App.apk'),
    bundleId: 'dev.fixture',
    selectors: {},
    release: false,
    metroPort: 8082,
    reserved: (value) => writeHostedAndroid(root, 'tablet', value),
    note: () => {},
    metro: async () => ({ gatewayPort: 9090, secret: 'a'.repeat(64) }),
  });
  expect(run.launched).toBe('unverified');
  expect(methods.find((entry) => entry.method === 'device-host.reserve')?.params).toMatchObject({
    platform: 'android',
    systemImage: device.systemImage,
    deviceProfile: 'pixel_7',
    slot: 'tablet',
  });
  expect(methods.findIndex((entry) => entry.method === 'device-host.offer')).toBeLessThan(
    methods.findIndex((entry) => entry.method === 'device-host.reserve'),
  );
  expect(JSON.parse(manifest.toString())).toEqual([
    { path: 'App.apk', kind: 'file', size: 11, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
  ]);
  expect(methods.find((entry) => entry.method === 'device-host.metro.open')?.params).toMatchObject({
    session,
    clientMetroPort: 8082,
    gatewayPort: 9090,
  });
  expect(readHostedAndroid(root, 'tablet').tablet?.session).toBe(session);
  expect(getProject(root)?.platforms?.android).toBeUndefined();
});

test.each(['declined', 'closed', 'forbidden'])('strict %s refusal reserves no local or hosted device', async (kind) => {
  if (kind === 'declined') declined = 'No compatible image';
  else failure = kind;
  await expect(prepareHostedAndroid('mini', {})).rejects.toMatchObject({ code: 'STIM_HOSTING_REFUSED' });
  expect(methods.some((entry) => entry.method === 'device-host.reserve')).toBe(false);
});

test('an unreachable stop keeps its owner for retry', async () => {
  writeHostedAndroid(root, 'default', placement);
  failure = 'closed';
  await expect(stopHostedAndroid(root)).rejects.toThrow('placement is kept');
  expect(readHostedAndroid(root).default?.session).toBe(session);
});

test.each(['unknown-session', 'forbidden'])('stop clears a %s session', async (kind) => {
  writeHostedAndroid(root, 'default', placement);
  failure = kind;
  await stopHostedAndroid(root);
  expect(readHostedAndroid(root)).toEqual({});
});

test('pending and unreadable slots remain in use and only the unreadable slot refuses', () => {
  writeHostedAndroid(root, 'default', { ...placement, device: null });
  writeWorkspaceState(root, { deviceSlots: { tablet: { android: { host: { machine: 'mini', session: '' } } } } });
  expect(readHostedAndroid(root, 'default').default?.session).toBe(session);
  expect(() => readHostedAndroid(root, 'tablet')).toThrow('deviceSlots.tablet.android.host');
  expect(workspaceInUse(root, { supervisor: false, managedLocks: false, nativeRun: false })).toEqual(
    expect.arrayContaining([
      'its Android emulator runs on mini',
      expect.stringContaining('deviceSlots.tablet.android.host'),
    ]),
  );
});

test.each(['ready', 'stopped', 'unknown', 'unreachable'] as const)(
  'status maps %s without exposing a local device target',
  (probeState) => {
    const result = applyHostedAndroidProbe(
      placement,
      probeState === 'unreachable' ? { state: probeState, reason: 'offline' } : { state: probeState },
      'tablet',
    );
    expect(result.android.state).toBe(probeState === 'ready' || probeState === 'stopped' ? probeState : 'unverified');
    expect(result.android.host?.device?.name).toBe('pixel_7 (API 30)');
    expect(result.android.serial).toBeNull();
    expect(JSON.stringify(result)).not.toContain(device.serial);
    expect(JSON.stringify(result)).not.toContain(device.avdName);
  },
);

test('hosted Android reload restores the host bridge before Metro without local adb', async () => {
  writeHostedAndroid(root, 'default', placement);
  upsertProject(root, { metroPort: 8082 });
  const order: string[] = [];
  const native = () => {
    throw new Error('local adb must not run');
  };
  const result = await runReload({
    root,
    platform: 'android',
    deps: {
      readLaunches: () => ({
        android: { appId: 'dev.fixture', deviceId: session, metroPort: 8082, release: false, launchedAt: 'now' },
      }),
      resolveAndroid: native,
      androidProcess: native,
      ensureReverse: native,
      resolveMetro: async () => ({ metro: { pid: 1, leader: 1, cwd: root } }),
      reopenHostedMetro: async (_root, owner, port) => {
        expect(owner.session).toBe(session);
        expect(port).toBe(8082);
        order.push('host');
      },
      reloadMetro: async (_port, opts) => {
        if (!opts?.peersOnly) order.push('reload');
        return { ok: true, targets: 1, peers: 1 };
      },
      sleep: async () => {},
    },
  });
  expect(result.ok).toBe(true);
  expect(order).toEqual(['host', 'reload']);
});

test('stop clears a hosted slot and keeps successful siblings when another placement is unreadable', async () => {
  writeHostedAndroid(root, 'default', placement);
  writeWorkspaceState(root, { deviceSlots: { tablet: { android: { host: { machine: 'mini', session: '' } } } } });
  const result = await runStop({ root, report: () => {} });
  expect(result.ok).toBe(false);
  expect(result.outcomes.device['android:host:default']).toMatchObject({
    status: 'shut-down',
    label: 'pixel_7 (API 30) on mini',
  });
  expect(result.outcomes.device['android:host:tablet']).toMatchObject({
    status: 'failed',
    reason: expect.stringContaining('deviceSlots.tablet.android.host'),
  });
  expect(readHostedAndroid(root, 'default')).toEqual({});
  expect(() => readHostedAndroid(root, 'tablet')).toThrow('deviceSlots.tablet.android.host');
});
