import { automaticDevicePlacement } from '../device-host/auto-placement.ts';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildConnection } from '../offload/client.ts';
import { deviceHostMachinesFile, queryLogs, type HostedIosPlacement, type HostedAppOffer } from '@stim-cli/core/state';
import { iosAgentRemoteConfig, prepareHostedIos, placeHostedIos, stopHostedIos } from '../device-host/hosted-ios.ts';
import { readHostedIos, writeHostedIos } from '../device-host/ios-state.ts';
import { applyHostedIosProbe } from '../device-host/hosted-ios-status.ts';
import { probeHostedSession } from '../device-host/hosted-client.ts';
import { gatewayAddresses, clearHostedMetro } from '../device-host/metro-gateway.ts';
import { reconcileHostedMetro, watchHostedMetro } from '../supervisor/hosted-metro.ts';
import { getConfigPath, getProject, upsertProject, writeConfigSetting } from '../workspace/config.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { pullHostedNativeLogs } from '../device-host/hosted-logs.ts';
import { followHostedMacosLogs, followHostedLogs, syncHostedLogs } from '../device-host/hosted-logs-sync.ts';
import { workspaceLogsDir, workspaceStateFile } from '../workspace/paths.ts';
import { launchSlotScope, siblingPlatformSlots } from '../engine/slot-launch.ts';
import { workspaceIdleProbe } from '../supervisor/idle-stop.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import { runStop } from '../commands/stop.ts';
import { connectIosTarget } from '../commands/ios/remote.ts';
import { DEFAULT_DEPS } from '../commands/ios/dependencies.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { runReload } from '../commands/reload.ts';
import { getExecutor, setExecutor, resetExecutor } from '../exec.ts';
import { agentRemoteConfig } from '../device-host/hosted-macos.ts';

const loopbackAvailable = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
});

const tailnet = vi.hoisted(() => ({ port: 0, changed: false }));
vi.mock('../offload/tailnet.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../offload/tailnet.ts')>()),
  pinnedEndpoint: () =>
    tailnet.changed
      ? 'the pinned node changed; run stim doctor'
      : { url: `ws://127.0.0.1:${tailnet.port}`, host: 'mini', servername: 'mini' },
}));
const sessionId = '12345678-1234-1234-1234-123456789abc';
const device = {
  udid: 'abcdef12-1234-1234-1234-123456789abc',
  name: 'iPhone 17 Pro',
  deviceType: 'iPhone 17 Pro',
  runtime: '27.0',
  deviceTypeId: 'iphone',
  runtimeId: 'ios27',
  architecture: 'x86_64' as const,
};
const credential = {
  machine: 'mini',
  nodeId: 'nMini',
  dnsName: 'mini.tail.ts.net',
  deviceToken: 'fixture-token',
  deviceId: 'client',
  state: 'approved' as const,
  requestedAt: '2026-10-05T12:00:00Z',
};
let home: string;
let root: string;
let open: ReturnType<typeof vi.spyOn>;
let sessionState: string;
let errorMethod: string;
let errorCode: string;
let errorSession: string;
let errorMessage: string;
let declined: string | null;
let capacity: number | null;
let pressure: string;
let methods: { method: string; params: Record<string, unknown> }[];
let blobs: Map<string, Buffer>;
let manifest: { sha256: string; size: number };
let hostFeatures: string[];
let agentGrant: unknown;
let features: boolean;
let appLaunched: true | 'unverified';
let logRecords: Record<string, unknown>[];
let retained: Map<string, Buffer> | null;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'stim-ios-host-'));
  process.env.STIM_HOME = home;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-host-app-')));
  mkdirSync(join(root, 'Fixture.app'));
  writeFileSync(join(root, 'Fixture.app', 'Info.plist'), 'app metadata');
  writeFileSync(getConfigPath(), JSON.stringify({ remote: { machines: ['mini'] } }));
  writeFileSync(deviceHostMachinesFile(), JSON.stringify({ version: 1, machines: [credential] }));
  methods = [];
  blobs = new Map();
  features = true;
  appLaunched = true;
  logRecords = [];
  retained = null;
  sessionState = 'ready';
  errorMethod = '';
  errorCode = 'forbidden';
  errorSession = '';
  errorMessage = 'fixture refusal';
  declined = null;
  capacity = 1;
  pressure = 'normal';
  tailnet.changed = false;
  hostFeatures = [];
  agentGrant = undefined;
  const connection = Object.create(BuildConnection.prototype) as BuildConnection;
  connection.close = vi.fn<() => void>();
  connection.supports = (feature) =>
    feature === 'hosted-ios-agent' || feature === 'hosted-ios-process' ? hostFeatures.includes(feature) : features;
  connection.request = async (method, raw) => {
    const params = raw as Record<string, unknown> & {
      manifest: { sha256: string; size: number };
      sha256: string;
      data: string;
    };
    methods.push({ method, params });
    const reply = (result: unknown) => ({ result });
    if (method === errorMethod && (!errorSession || params.session === errorSession))
      return { error: { code: errorCode, message: errorMessage } };
    if (method === 'hello') return reply({ capabilities: ['device-host'], device: { id: 'client', name: 'laptop' } });
    if (method === 'device-host.offer')
      return reply({
        platform: 'ios',
        choice: device,
        declined,
        capacity: { available: capacity },
        resources: { memoryPressure: pressure },
      });
    if (method === 'device-host.reserve' || method === 'device-host.attach')
      return reply({ id: sessionId, platform: 'ios', state: sessionState, device });
    if (method === 'device-host.logs.query') {
      const cursor = params.cursor as Record<string, number> | undefined;
      const offset = cursor?.['device.ndjson'] ?? 0;
      return reply({
        records: logRecords.slice(offset, offset + 2),
        cursor: { 'device.ndjson': Math.min(logRecords.length, offset + 2) },
        more: offset + 2 < logRecords.length,
      });
    }
    if (method === 'device-host.app.handoff') {
      for (const [digest, bytes] of retained ?? []) blobs.set(digest, bytes);
      return reply({ files: retained?.size ?? 0 });
    }
    if (method === 'device-host.stop') {
      sessionState = 'stopped';
      return reply({ id: sessionId, platform: 'ios', state: 'stopped', device });
    }
    if (method === 'device-host.metro.open' || method === 'device-host.metro.close') return reply({ port: 8123 });
    if (method === 'device-host.app.offer') {
      manifest = params.manifest;
      const files = blobs.has(manifest.sha256) ? JSON.parse(String(blobs.get(manifest.sha256))) : [manifest];
      return reply({
        missing: files
          .filter((file: { sha256: string }) => !blobs.has(file.sha256))
          .map((file: { sha256: string }) => ({ sha256: file.sha256, offset: 0 })),
      });
    }
    if (method === 'device-host.app.chunk') {
      const bytes = Buffer.concat([blobs.get(params.sha256) ?? Buffer.alloc(0), Buffer.from(params.data, 'base64')]);
      blobs.set(params.sha256, bytes);
      return reply({ offset: bytes.length });
    }
    if (method === 'device-host.app.launch' || method === 'device-host.app.attach')
      return reply({ state: 'installed', launched: appLaunched, ...(agentGrant ? { agent: agentGrant } : {}) });
    throw new Error(`Unexpected fixture method ${method}`);
  };
  open = vi.spyOn(BuildConnection, 'open').mockResolvedValue(connection);
});
afterEach(async () => {
  open.mockRestore();
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const placement = (): HostedIosPlacement => ({
  machine: 'mini',
  selected: 'mini',
  session: sessionId,
  appAttempt: 'old',
  device,
  agent: { driver: 'none', setting: 'hosting.agentDriver' },
});
async function deliver(
  release = false,
  slot = 'default',
  mode?: HostedAppOffer['mode'],
  enterPhase?: (phase: 'device' | 'install' | 'launch') => void,
) {
  const target = await prepareHostedIos(
    'mini',
    { deviceType: 'iPhone 17 Pro', runtime: 'iOS 27.0' },
    readHostedIos(root)[slot],
    mode,
  );
  try {
    return await placeHostedIos(target, {
      root,
      slot,
      bundle: join(root, 'Fixture.app'),
      bundleId: 'dev.fixture',
      release,
      mode,
      selectors: { deviceType: 'iPhone 17 Pro', runtime: 'iOS 27.0' },
      devClientScheme: 'exp+fixture',
      reserved: (value) => writeHostedIos(root, slot, value),
      note: () => {},
      enterPhase,
      ...(mode === 'process' ? {} : { metro: async () => ({ gatewayPort: 8111, secret: 'a'.repeat(64) }) }),
    });
  } finally {
    target.host.connection.close();
  }
}

test('offers before reservation, uploads digest-matching bytes, and development launch waits for client evidence', async () => {
  const run = await deliver();
  expect(run.launched).toBe('unverified');
  expect(methods.map((entry) => entry.method).indexOf('device-host.offer')).toBeLessThan(
    methods.map((entry) => entry.method).indexOf('device-host.reserve'),
  );
  const reservation = methods.find((entry) => entry.method === 'device-host.reserve')!.params;
  expect(reservation).toMatchObject({
    platform: 'ios',
    slot: 'default',
    deviceType: 'iPhone 17 Pro',
    runtime: 'iOS 27.0',
  });
  expect(methods.find((entry) => entry.method === 'device-host.app.offer')!.params).toMatchObject({
    mode: 'development',
    devClientScheme: 'exp+fixture',
  });
  expect(readHostedIos(root).default?.device?.udid === device.udid).toBe(true);
  expect(getProject(root)?.platforms?.ios).toBeUndefined();
  for (const [digest, bytes] of blobs) expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
  expect(statSync(workspaceStateFile(root)).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
  expect(workspaceIdleProbe(root).blocker()).toContain('runs on mini');
});

test('placement moves the build to device before reserving, install before delivery and launch before launching', async () => {
  await deliver(false, 'default', undefined, (phase) => methods.push({ method: `phase:${phase}`, params: {} }));
  const order = methods.map((entry) => entry.method);
  expect(order.filter((method) => method.startsWith('phase:'))).toEqual([
    'phase:device',
    'phase:install',
    'phase:launch',
  ]);
  expect(order.indexOf('phase:device')).toBeLessThan(order.indexOf('device-host.reserve'));
  expect(order.indexOf('phase:install')).toBeGreaterThan(order.lastIndexOf('device-host.metro.open'));
  expect(order.indexOf('phase:install')).toBeLessThan(order.indexOf('device-host.app.offer'));
  expect(order.indexOf('phase:launch')).toBeGreaterThan(order.lastIndexOf('device-host.app.chunk'));
  expect(order.indexOf('phase:launch')).toBeLessThan(order.indexOf('device-host.app.launch'));
});

test.each(['declined', 'capacity', 'pressure', 'changed-node'])(
  'strict %s refusal reserves nothing',
  async (reason) => {
    writeFileSync(getConfigPath(), JSON.stringify({ remote: { machines: ['mini', 'other'] } }));
    if (reason === 'declined') declined = 'Installed runtimes: iOS 26.5; iOS 27.0 is unavailable';
    if (reason === 'capacity') capacity = 0;
    if (reason === 'pressure') pressure = 'warning';
    if (reason === 'changed-node') tailnet.changed = true;
    await expect(prepareHostedIos('mini', {})).rejects.toMatchObject({
      code: 'STIM_HOSTING_REFUSED',
      message: expect.stringContaining('mini'),
    });
    expect(methods.some((entry) => entry.method === 'device-host.reserve')).toBe(false);
    expect(readHostedIos(root)).toEqual({});
    expect(open).toHaveBeenCalledTimes(reason === 'changed-node' ? 0 : 1);
  },
);

test('missing configuration and approval keep their existing credential remedies', async () => {
  await expect(prepareHostedIos('other', {})).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
  rmSync(deviceHostMachinesFile());
  await expect(prepareHostedIos('mini', {})).rejects.toThrow('Run stim doctor --fix');
  expect(methods).toEqual([]);
});

test('delivery failure keeps the session available to stop', async () => {
  errorMethod = 'device-host.app.offer';
  await expect(deliver()).rejects.toMatchObject({ code: 'STIM_HOSTING_REFUSED' });
  expect(readHostedIos(root).default?.session).toBe(sessionId);
  await stopHostedIos(root);
  expect(readHostedIos(root)).toEqual({});
});

test('reattaches a ready session without a new reservation, even when capacity is now full', async () => {
  writeHostedIos(root, 'default', placement());
  capacity = 0;
  const run = await deliver(true);
  expect(run.launched).toBe(true);
  expect(methods.some((entry) => entry.method === 'device-host.reserve')).toBe(false);
  expect(run.placement.appAttempt).not.toBe('old');
  expect(methods.some((entry) => entry.method === 'device-host.metro.open')).toBe(false);
  expect(methods.find((entry) => entry.method === 'device-host.app.offer')!.params.mode).toBe('release');
});

test.each(['stopped', 'unknown-session'])('a %s recorded session can be placed again', async (state) => {
  writeHostedIos(root, 'default', placement());
  if (state === 'stopped') sessionState = 'stopped';
  else {
    errorMethod = 'device-host.attach';
    errorCode = 'unknown-session';
  }
  const target = await prepareHostedIos('mini', {}, placement());
  try {
    expect(target.session).toBeNull();
  } finally {
    target.host.connection.close();
  }
});

test('an unknown or unreachable owner refuses replacement, and an unreachable stop retains ownership', async () => {
  writeHostedIos(root, 'default', placement());
  sessionState = 'unknown';
  await expect(prepareHostedIos('mini', {}, placement())).rejects.toMatchObject({ code: 'STIM_HOSTING_REFUSED' });
  tailnet.changed = true;
  await expect(stopHostedIos(root)).rejects.toThrow('placement is kept');
  expect(readHostedIos(root).default?.session).toBe(sessionId);
  expect(methods.some((entry) => entry.method === 'device-host.reserve')).toBe(false);
});

test.each(['unknown-session', 'forbidden'])('stop clears %s placement and its gateway request', async (code) => {
  writeHostedIos(root, 'tablet', placement());
  writeWorkspaceState(root, {
    hostedMetroRequests: {
      [sessionId]: {
        id: 'request',
        machine: 'mini',
        address: '100.64.0.2',
        peer: '100.64.0.7',
        secret: 'a'.repeat(64),
      },
    },
  });
  errorMethod = 'device-host.stop';
  errorCode = code;
  await stopHostedIos(root, 'tablet');
  expect(readHostedIos(root)).toEqual({});
  expect(Object.keys(readWorkspaceState(root)?.hostedMetroRequests ?? {})).toEqual([]);
});

test('probe caches owner evidence and missing sessions become stopped', async () => {
  const pending = placement();
  pending.session = '23456789-1234-1234-1234-123456789abc';
  await probeHostedSession(pending);
  await probeHostedSession(pending);
  expect(methods.filter((entry) => entry.method === 'device-host.attach')).toHaveLength(1);
  errorMethod = 'device-host.attach';
  errorCode = 'unknown-session';
  expect(await probeHostedSession(pending, { ttlMs: 0 })).toEqual({ state: 'stopped' });
});

test.each(['ready', 'stopped', 'unknown', 'unreachable'] as const)(
  'status maps %s evidence without making a local simulator target',
  (state) => {
    const result = applyHostedIosProbe(
      placement(),
      state === 'unreachable' ? { state, reason: 'offline' } : { state },
      'tablet',
    );
    expect(result.ios.state).toBe(state === 'ready' || state === 'stopped' ? state : 'unverified');
    expect(result.ios.udid).toBe('');
    expect(result.ios.host?.device).toEqual({ name: 'iPhone 17 Pro', runtime: '27.0' });
    expect(JSON.stringify(result).includes(device.udid)).toBe(false);
    expect(result.warning?.includes('stim ios --remote mini --slot tablet') ?? false).toBe(state === 'stopped');
  },
);

test('reload uses client Metro for a hosted session without native process or simulator probes', async () => {
  writeHostedIos(root, 'default', placement());
  const native = vi.fn<() => never>(() => {
    throw new Error('local device probe');
  });
  const reload = vi.fn<typeof import('../engine/reload.ts').reloadThroughMetro>(async () => ({
    ok: true,
    broadcast: true,
  }));
  const result = await runReload({
    root,
    platform: 'ios',
    deps: {
      getProject: () => ({ metroPort: 8082 }),
      readLaunches: () => ({
        ios: { appId: 'dev.fixture', deviceId: sessionId, metroPort: 8082, release: false, launchedAt: 'now' },
      }),
      resolveIos: native,
      iosProcess: native,
      resolveMetro: async () => ({ metro: { pid: 1, leader: 1, cwd: root } }),
      reloadMetro: reload,
    },
  });
  expect(result.ok).toBe(true);
  expect(native).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledWith(8082, { role: 'ios', appId: 'dev.fixture' });
});

test('gateway reconciliation closes changed or removed sessions and opens only new requests', () => {
  const a = { id: 'a', machine: 'mini', address: '100.64.0.2', peer: '100.64.0.7', secret: 'a'.repeat(64) };
  expect(
    reconcileHostedMetro({ keep: a, change: { ...a, id: 'b' }, add: a }, { keep: a, change: a, remove: a }),
  ).toEqual({ close: ['change', 'remove'], open: ['change', 'add'] });
});

test('gateway addresses use Self and the pinned peer, refusing a changed node', () => {
  const status = {
    Self: { TailscaleIPs: ['100.64.0.2'] },
    Peer: { mini: { ID: 'nMini', DNSName: 'mini.tail.ts.net.', TailscaleIPs: ['100.64.0.7'] } },
  };
  expect(gatewayAddresses(credential, status)).toEqual({ address: '100.64.0.2', peer: '100.64.0.7' });
  expect(() => gatewayAddresses({ ...credential, nodeId: 'other' }, status)).toThrow('pinned');
  expect(() => gatewayAddresses(credential, { ...status, Self: {} })).toThrow('no Tailscale address');
});

test.skipIf(!loopbackAvailable)(
  'the supervisor binds and recreates a recorded gateway port, then closes it when requested',
  async () => {
    const request = { id: 'fixture', machine: 'mini', address: '127.0.0.1', peer: '127.0.0.1', secret: 'a'.repeat(64) };
    writeHostedIos(root, 'default', placement());
    writeWorkspaceState(root, { supervisor: { processToken: 'first' }, hostedMetroRequests: { [sessionId]: request } });
    const awaitPort = async (token: string) => {
      await vi.waitFor(() =>
        expect(
          (readWorkspaceState(root)?.hostedMetroGateways as Record<string, { processToken: string }>)?.[sessionId]
            ?.processToken,
        ).toBe(token),
      );
      return (readWorkspaceState(root)?.hostedMetroGateways as Record<string, { port: number }> | undefined)?.[
        sessionId
      ]?.port;
    };
    const close = watchHostedMetro(root, 8082, 'first');
    const port = await awaitPort('first');
    await close();
    writeWorkspaceState(root, { supervisor: { processToken: 'second' } });
    const closeAgain = watchHostedMetro(root, 8082, 'second');
    try {
      expect(await awaitPort('second')).toBe(port);
      clearHostedMetro(root, sessionId);
      await vi.waitFor(() => expect(Object.keys(readWorkspaceState(root)?.hostedMetroGateways ?? {})).toEqual([]));
      expect(statSync(workspaceStateFile(root)).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
      expect(readFileSync(workspaceStateFile(root), 'utf8').includes('fixture-token')).toBe(false);
    } finally {
      await closeAgain();
    }
  },
);

test('a ready sticky session refuses a different runtime instead of ignoring it or creating a second device', async () => {
  writeHostedIos(root, 'default', placement());
  await expect(prepareHostedIos('mini', { runtime: '26.5' }, placement())).rejects.toThrow('run stim stop first');
  expect(methods.some((entry) => entry.method === 'device-host.reserve')).toBe(false);
});

test('host refusal messages cannot expose the credential or gateway secret', async () => {
  errorMethod = 'device-host.app.offer';
  errorMessage = `failed with ${credential.deviceToken} and ${'a'.repeat(64)}`;
  const error = await deliver().catch((refusal: Error) => refusal);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain('[redacted]');
  expect(message.includes(credential.deviceToken)).toBe(false);
  expect(message.includes('a'.repeat(64))).toBe(false);
});

test('stop retains an unresolved slot but still stops the sibling session', async () => {
  const sibling = { ...placement(), session: '34567890-1234-1234-1234-123456789abc' };
  writeHostedIos(root, 'default', placement());
  writeHostedIos(root, 'tablet', sibling);
  errorMethod = 'device-host.stop';
  errorCode = 'closed';
  errorSession = sessionId;
  await expect(stopHostedIos(root)).rejects.toThrow('placement is kept');
  expect(readHostedIos(root)).toEqual({ default: placement() });
  expect(methods.filter((entry) => entry.method === 'device-host.stop')).toHaveLength(2);
});

test.each([false, true])('workspace removal preserves an unreachable hosting owner: %s', async (unreachable) => {
  writeHostedIos(root, 'default', placement());
  tailnet.changed = unreachable;
  const result = await reclaimProject(root);
  expect(result.keptEntry).toBe(unreachable);
  expect(result.failedDevices.length > 0).toBe(unreachable);
  expect(Object.keys(readHostedIos(root)).length).toBe(unreachable ? 1 : 0);
});

test.each([
  ['forbidden', true, ''],
  ['capacity', false, 'run stim doctor, restore hosting access, then rerun stim stop'],
  ['unauthorized', false, 'run stim doctor, restore hosting access, then rerun stim stop'],
])('stop handles a hello refusal with host code %s', async (code, cleared, remedy) => {
  writeHostedIos(root, 'default', placement());
  open.mockResolvedValue({ refused: true, code, failure: 'This Mac is refused.' });
  const result = await runStop({ root, report: () => {} });
  const outcome = JSON.stringify(result.outcomes.device);
  expect(result.ok).toBe(cleared);
  expect(readHostedIos(root)).toEqual(cleared ? {} : { default: placement() });
  expect(methods).toEqual([]);
  expect(outcome).toContain(remedy);
  expect(outcome).not.toContain('..');
});

test('worktree removal clears placement when hosting was revoked at hello', async () => {
  writeHostedIos(root, 'default', placement());
  open.mockResolvedValue({ refused: true, code: 'forbidden', failure: 'This Mac is refused.' });
  const result = await reclaimProject(root);
  expect(result.keptEntry).toBe(false);
  expect(result.failedDevices).toEqual([]);
  expect(readHostedIos(root)).toEqual({});
});

test('the stop command reports a hosted stop without sending the host UDID to local teardown', async () => {
  writeHostedIos(root, 'default', placement());
  const local = vi.fn<() => never>(() => {
    throw new Error('host device reached local teardown');
  });
  const result = await runStop({ root, report: () => {}, teardownIos: local });
  expect(result.ok).toBe(true);
  expect(local).not.toHaveBeenCalled();
  expect(readHostedIos(root)).toEqual({});
});

test('hosted sibling slots share Metro evidence even without local collectors or registry devices', () => {
  writeHostedIos(root, 'default', placement());
  writeHostedIos(root, 'tablet', { ...placement(), session: '34567890-1234-1234-1234-123456789abc' });
  expect(launchSlotScope(root)).toBe('default');
  expect(siblingPlatformSlots(root, 'ios')).toEqual(['tablet']);
  expect(siblingPlatformSlots(root, 'ios', 'tablet')).toEqual(['default']);
  expect(siblingPlatformSlots(root, 'android')).toEqual([]);
});

test('a hosting handshake refusal cannot expose the credential', async () => {
  open.mockResolvedValue({ refused: true, code: 'forbidden', failure: `invalid ${credential.deviceToken}.` });
  const error = await prepareHostedIos('mini', {}).catch((refusal: Error) => refusal);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message.includes(credential.deviceToken)).toBe(false);
  expect((error as Error).message).toContain('[redacted]. Run stim doctor.');
  expect((error as Error & { code: string }).code).toBe('STIM_HOSTING_REFUSED');
  expect(methods).toEqual([]);
});

test.each(['missing', 'pending', 'unreadable', 'invalid-config', 'unlisted'])(
  'command target reports coded %s hosting setup failure with recovery guidance',
  async (reason) => {
    if (reason === 'missing') rmSync(deviceHostMachinesFile());
    if (reason === 'pending')
      writeFileSync(
        deviceHostMachinesFile(),
        JSON.stringify({ version: 1, machines: [{ ...credential, state: 'pending' }] }),
      );
    if (reason === 'unreadable') writeFileSync(deviceHostMachinesFile(), '{');
    if (reason === 'invalid-config') writeFileSync(getConfigPath(), JSON.stringify({ remote: { machines: true } }));
    const result = await connectIosTarget(
      { machine: reason === 'unlisted' ? 'other' : 'mini', backend: null },
      {},
      DEFAULT_DEPS,
    );
    expect(result).toMatchObject({
      failure: {
        code: reason === 'unlisted' ? 'STIM_BAD_ARG' : 'STIM_HOSTING_REFUSED',
        message: expect.stringContaining(reason === 'invalid-config' ? 'stim guide settings' : 'stim doctor'),
      },
    });
    expect(result).toMatchObject({
      failure: {
        message: expect.stringContaining(
          reason === 'pending'
            ? 'stim-server devices grant client --device-host'
            : reason === 'invalid-config'
              ? 'remote.machines'
              : 'stim doctor',
        ),
      },
    });
    const expectedRemedy = expect.stringContaining(
      reason === 'pending'
        ? 'stim-server devices grant client --device-host'
        : reason === 'invalid-config'
          ? 'stim guide settings'
          : 'stim doctor',
    );
    expect('failure' in result ? result.failure.remedy : null).toEqual(
      reason === 'unlisted' ? undefined : expectedRemedy,
    );
    expect(open).not.toHaveBeenCalled();
  },
);

test('stop reconciles newer metadata and isolates unreadable slots with exact state keys', async () => {
  const sibling = {
    ...placement(),
    session: '34567890-1234-1234-1234-123456789abc',
    selected: 'auto',
    agent: { driver: 'agent-device' },
    appAttempt: null,
    device: null,
  };
  writeWorkspaceState(root, {
    ios: { host: sibling },
    deviceSlots: { tablet: { ios: { host: { machine: 'mini', session: '' } } } },
  });
  expect(workspaceInUse(root, { supervisor: false, managedLocks: false, nativeRun: false })).toEqual(
    expect.arrayContaining([
      expect.stringContaining('deviceSlots.tablet.ios.host.session'),
      'its iOS simulator runs on mini',
    ]),
  );
  const result = await runStop({ root, report: () => {} });
  expect(result.ok).toBe(false);
  expect(result.outcomes.device['ios:host:default']).toMatchObject({ status: 'shut-down' });
  expect(result.outcomes.device['ios:host:tablet']).toMatchObject({
    status: 'failed',
    label: 'hosted iOS simulator for slot tablet',
    reason: expect.stringContaining('deviceSlots.tablet.ios.host.machine'),
  });
  expect(result.summary).not.toContain('undefined');
  expect(readWorkspaceState(root)?.ios).toEqual({});
  expect(readWorkspaceState(root)?.deviceSlots).toMatchObject({ tablet: { ios: { host: { session: '' } } } });
});

test.each(['missing', 'unreachable'])('stop uses the %s remedy and reports sibling outcomes', async (reason) => {
  writeHostedIos(root, 'default', placement());
  writeHostedIos(root, 'tablet', { ...placement(), session: '34567890-1234-1234-1234-123456789abc' });
  if (reason === 'missing') rmSync(deviceHostMachinesFile());
  else {
    errorMethod = 'device-host.stop';
    errorCode = 'closed';
    errorSession = sessionId;
  }
  const result = await runStop({ root, report: () => {} });
  expect(result.outcomes.device['ios:host:default']).toMatchObject({
    status: 'failed',
    label: expect.stringContaining('mini'),
    reason: expect.stringContaining(reason === 'missing' ? 'stim doctor' : 'when that machine answers'),
  });
  expect(result.outcomes.device['ios:host:tablet']?.status).toBe(reason === 'missing' ? 'failed' : 'shut-down');
  expect(result.outcomes.device['ios:host:default']?.reason?.includes('when that machine answers')).toBe(
    reason === 'unreachable',
  );
});

test('replacing a recorded session removes its old gateway request atomically', () => {
  writeHostedIos(root, 'default', placement());
  writeWorkspaceState(root, {
    hostedMetroRequests: {
      [sessionId]: { id: 'old', machine: 'mini', address: '100.64.0.2', peer: '100.64.0.7', secret: 'a'.repeat(64) },
    },
  });
  writeHostedIos(root, 'default', { ...placement(), session: '34567890-1234-1234-1234-123456789abc' });
  expect(readWorkspaceState(root)?.hostedMetroRequests).toEqual({});
});

test.each([false, true])('missing or older Metro support refuses before reserving: older %s', async (older) => {
  if (older) writeWorkspaceState(root, { supervisor: { pid: process.pid, processToken: 'old' } });
  const target = await prepareHostedIos('mini', {});
  await expect(
    placeHostedIos(target, {
      root,
      slot: 'default',
      bundle: join(root, 'Fixture.app'),
      bundleId: 'dev.fixture',
      release: false,
      selectors: {},
      reserved: (value) => writeHostedIos(root, 'default', value),
      note: () => {},
    }),
  ).rejects.toMatchObject({ code: 'STIM_HOSTING_REFUSED', message: expect.stringContaining('stim stop; stim start') });
  expect(methods.some((entry) => entry.method === 'device-host.reserve')).toBe(false);
  expect(readHostedIos(root)).toEqual({});
});

test('delivery reconnects after the build instead of using the offer connection', async () => {
  const target = await prepareHostedIos('mini', {});
  const previous = target.host.connection;
  const connection = Object.create(BuildConnection.prototype) as BuildConnection;
  connection.close = () => {};
  connection.supports = () => false;
  connection.request = previous.request.bind(previous);
  const stale = vi.spyOn(previous, 'request').mockRejectedValue(new Error('connection dropped during build'));
  open.mockResolvedValue(connection);
  try {
    await placeHostedIos(target, {
      root,
      slot: 'default',
      bundle: join(root, 'Fixture.app'),
      bundleId: 'dev.fixture',
      release: true,
      selectors: {},
      reserved: (value) => writeHostedIos(root, 'default', value),
      note: () => {},
    });
    expect(stale).not.toHaveBeenCalled();
    expect(readHostedIos(root).default?.session).toBe(sessionId);
  } finally {
    stale.mockRestore();
    target.host.connection.close();
  }
});

test('hosted stop failures cannot overwrite the local default-slot outcome', async () => {
  upsertProject(root, { platforms: { ios: { owned: true, deviceUdid: 'LOCAL' } } });
  writeHostedIos(root, 'default', placement());
  writeHostedIos(root, 'tablet', { ...placement(), session: '34567890-1234-1234-1234-123456789abc' });
  errorMethod = 'device-host.stop';
  errorCode = 'closed';
  errorSession = sessionId;
  const teardown = vi.fn<NonNullable<Parameters<typeof runStop>[0]['teardownIos']>>(() => ({
    status: 'torn-down' as const,
    label: 'local simulator',
    id: 'LOCAL',
    platform: 'ios' as const,
  }));
  const result = await runStop({ root, report: () => {}, teardownIos: teardown });
  expect(result.outcomes.device.ios).toMatchObject({ status: 'shut-down', label: 'local simulator' });
  expect(result.outcomes.device['ios:host:default']).toMatchObject({ status: 'failed' });
  expect(result.outcomes.device['ios:host:tablet']).toMatchObject({ status: 'shut-down' });
});

test('iOS grants keep credentials in separate slot files and close only the selected connection', async () => {
  hostFeatures = ['hosted-ios-agent'];
  agentGrant = {
    driver: 'agent-device',
    path: `/device-host/agent/${sessionId}/`,
    token: 's'.repeat(43),
    scope: sessionId,
    lease: {
      tenant: `stim.${sessionId}`,
      runId: sessionId,
      clientId: 'agent',
      backend: 'ios-instance',
      deviceKey: `ios:mobile:${device.udid}`,
    },
  };
  const first = await deliver(true);
  const second = await deliver(true, 'tablet');
  for (const [slot, run] of [
    ['default', first],
    ['tablet', second],
  ] as const) {
    const file = iosAgentRemoteConfig(root, slot);
    expect(run.placement.agent.driver).toBe('agent-device');
    expect(existsSync(file)).toBe(true);
    writeHostedIos(root, slot, run.placement);
    expect(statSync(file).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      daemonBaseUrl: `https://mini.tail.ts.net:7443/device-host/agent/${sessionId}/`,
      daemonAuthToken: 's'.repeat(43),
      tenant: `stim.${sessionId}`,
      sessionIsolation: 'tenant',
      runId: sessionId,
      clientId: 'agent',
      leaseBackend: 'ios-instance',
      leaseProvider: 'proxy',
      deviceKey: `ios:mobile:${device.udid}`,
      platform: 'ios',
    });
    expect(run.placement.agent).toEqual({
      driver: 'agent-device',
      remoteConfig: file,
      command: `agent-device <command> --remote-config ${file}`,
    });
    expect(readFileSync(workspaceStateFile(root), 'utf8')).not.toContain('s'.repeat(43));
    expect(JSON.stringify(applyHostedIosProbe(run.placement, { state: 'ready' }, slot))).not.toContain('s'.repeat(43));
  }
  expect(iosAgentRemoteConfig(root, 'default')).not.toBe(iosAgentRemoteConfig(root, 'tablet'));
  expect(iosAgentRemoteConfig(root, 'default')).not.toBe(agentRemoteConfig(root));
  const config = iosAgentRemoteConfig(root, 'tablet');
  const calls: string[][] = [];
  setExecutor({
    ...getExecutor(),
    findExecutable: () => '/fake/agent-device',
    runFile: (_file, args = []) => {
      calls.push(args);
      return JSON.stringify({
        success: true,
        data: { connected: true, remoteConfig: config, session: 'agent-tablet' },
      });
    },
  });
  await stopHostedIos(root, 'tablet');
  expect(calls).toEqual([
    ['connection', 'status', '--json'],
    ['close', '--remote-config', config, '--session', 'agent-tablet', '--json'],
    ['disconnect', '--session', 'agent-tablet', '--json'],
  ]);
  expect(existsSync(config)).toBe(false);
  expect(existsSync(iosAgentRemoteConfig(root, 'default'))).toBe(true);
  expect(readHostedIos(root).default?.agent.driver).toBe('agent-device');
});

test('an unreachable stop retains the slot credential for retry', async () => {
  const config = iosAgentRemoteConfig(root, 'default');
  mkdirSync(join(config, '..'), { recursive: true });
  writeFileSync(config, '{}', { mode: 0o600 });
  writeHostedIos(root, 'default', {
    ...placement(),
    agent: {
      driver: 'agent-device',
      remoteConfig: config,
      command: `agent-device <command> --remote-config ${config}`,
    },
  });
  setExecutor({ ...getExecutor(), findExecutable: () => null });
  errorMethod = 'device-host.stop';
  errorCode = 'closed';
  await expect(stopHostedIos(root)).rejects.toThrow('placement is kept');
  expect(existsSync(config)).toBe(true);
  expect(readHostedIos(root).default?.agent.driver).toBe('agent-device');
});

test('an older host grant is ignored and removes an obsolete config without failing placement', async () => {
  const config = iosAgentRemoteConfig(root, 'default');
  mkdirSync(join(config, '..'), { recursive: true });
  writeFileSync(config, '{}');
  agentGrant = {
    driver: 'agent-device',
    path: `/device-host/agent/${sessionId}/`,
    token: 's'.repeat(43),
    scope: sessionId,
    lease: {
      tenant: `stim.${sessionId}`,
      runId: sessionId,
      clientId: 'agent',
      backend: 'ios-instance',
      deviceKey: `ios:mobile:${device.udid}`,
    },
  };
  const run = await deliver(true);
  expect(run.placement.agent).toEqual({ driver: 'none', setting: 'hosting.agentDriver' });
  expect(existsSync(config)).toBe(false);
});

test.each(['same-node', 'other-node', 'older-host', 'refused'])(
  'iOS handoff %s retains upload fallback and only sends missing content',
  async (scenario) => {
    await deliver();
    retained = new Map(blobs);
    retained.delete(manifest.sha256);
    blobs.clear();
    methods = [];
    features = scenario !== 'older-host';
    if (scenario === 'refused') {
      errorMethod = 'device-host.app.handoff';
      errorCode = 'action-failed';
    }
    const target = await prepareHostedIos('mini', {}, readHostedIos(root).default);
    const note = vi.fn<(line: string) => void>();
    await placeHostedIos(target, {
      root,
      slot: 'default',
      bundle: join(root, 'Fixture.app'),
      bundleId: 'dev.fixture',
      release: true,
      selectors: {},
      handoff: {
        nodeId: scenario === 'other-node' ? 'other' : credential.nodeId,
        token: 'a'.repeat(64),
        sha256: 'b'.repeat(64),
      },
      note,
      reserved: (value) => writeHostedIos(root, 'default', value),
    });
    expect(methods.some((entry) => entry.method === 'device-host.app.handoff')).toBe(
      ['same-node', 'refused'].includes(scenario),
    );
    const chunks = methods.filter((entry) => entry.method === 'device-host.app.chunk');
    expect(chunks.filter((entry) => retained!.has(entry.params.sha256 as string))).toHaveLength(
      scenario === 'same-node' ? 0 : retained.size,
    );
    expect(note.mock.calls.some(([line]) => line.includes('uploading the app instead'))).toBe(
      ['older-host', 'refused'].includes(scenario),
    );
  },
);

test('hosted iOS native errors are paged into the workspace once per slot and pulled before stop', async () => {
  writeHostedIos(root, 'tablet', placement());
  logRecords = [1, 2, 3].map((ts) => ({ ts, src: 'device', level: ts === 3 ? 'error' : 'info', msg: `native ${ts}` }));
  const target = await prepareHostedIos('mini', {}, placement());
  await Promise.all([
    pullHostedNativeLogs(root, 'tablet', placement(), target.host),
    pullHostedNativeLogs(root, 'tablet', placement(), target.host),
  ]);
  const stored = readFileSync(join(workspaceLogsDir(root), 'ios.tablet-host.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(stored.map((record) => record.msg)).toEqual(['native 1', 'native 2', 'native 3']);
  expect(
    stored.every((record) => record.src === 'device' && record.platform === 'ios' && record.slot === 'tablet'),
  ).toBe(true);
  expect(queryLogs({ dir: workspaceLogsDir(root), errorsOnly: true }).map((record) => record.msg)).toEqual([
    'native 3',
  ]);
  logRecords.push(
    ...Array.from({ length: 130 }, (_, index) => ({
      ts: index + 4,
      src: 'device',
      level: 'error',
      msg: `final error ${index + 1}`,
    })),
  );
  methods = [];
  await stopHostedIos(root, 'tablet');
  expect(methods.map((entry) => entry.method).indexOf('device-host.logs.query')).toBeLessThan(
    methods.map((entry) => entry.method).indexOf('device-host.stop'),
  );
  const finalLogs = readFileSync(join(workspaceLogsDir(root), 'ios.tablet-host.ndjson'), 'utf8');
  expect(finalLogs).toContain('final error 130');
  expect(finalLogs.trim().split('\n')).toHaveLength(133);
  expect(readHostedIos(root)).toEqual({});
});

test('an older host gets no iOS log queries and follow warns once while retaining copied logs', async () => {
  features = false;
  writeHostedIos(root, 'default', placement());
  writeHostedIos(root, 'tablet', placement());
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let stop: (() => void) | undefined;
  try {
    expect(await syncHostedLogs(root)).toBe(false);
    stop = followHostedMacosLogs(root, { slot: 'default', failing: true, intervalMs: 10, retryMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]![0])).toContain('newer stim-server');
    expect(methods.some((entry) => entry.method === 'device-host.logs.query')).toBe(false);
    await stopHostedIos(root);
    expect(methods.some((entry) => entry.method === 'device-host.stop')).toBe(true);
  } finally {
    stop?.();
    stderr.mockRestore();
  }
});

test('plain log pull commits 64 pages and reports a bound while final drain finishes the backlog', async () => {
  logRecords = Array.from({ length: 130 }, (_, ts) => ({ ts, src: 'device', level: 'error', msg: `backlog ${ts}` }));
  const target = await prepareHostedIos('mini', {}, placement());
  await expect(pullHostedNativeLogs(root, 'default', placement(), target.host)).rejects.toThrow('unread pages');
  expect(methods.filter((entry) => entry.method === 'device-host.logs.query')).toHaveLength(64);
  const progress = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await pullHostedNativeLogs(root, 'default', placement(), target.host, true);
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('Copying final native logs'));
    expect(readFileSync(join(workspaceLogsDir(root), 'ios-host.ndjson'), 'utf8')).toContain('backlog 129');
  } finally {
    progress.mockRestore();
  }
});

test.each([false, true])('an iOS page with no cursor or checkpoint progress cannot spin (final=%s)', async (final) => {
  const target = await prepareHostedIos('mini', {}, placement());
  const request = vi
    .spyOn(target.host.connection, 'request')
    .mockResolvedValue({ result: { records: [], cursor: {}, more: true, checkpoint: 1000 } });
  const progress = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await expect(pullHostedNativeLogs(root, 'default', placement(), target.host, final)).rejects.toThrow('no progress');
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    request.mockRestore();
    progress.mockRestore();
  }
});

test('final log drain has a time bound even while pages advance', async () => {
  const target = await prepareHostedIos('mini', {}, placement());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
  let queries = 0;
  const request = vi.spyOn(target.host.connection, 'request').mockImplementation(async () => {
    if (++queries > 4) throw new Error('The final drain did not stop at its deadline.');
    vi.setSystemTime(Date.now() + 16_000);
    return { result: { records: [], cursor: { 'device.ndjson': Date.now() }, more: true } };
  });
  const progress = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await expect(pullHostedNativeLogs(root, 'default', placement(), target.host, true)).rejects.toThrow(
      'time or page bound',
    );
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    request.mockRestore();
    progress.mockRestore();
  }
});

test('follow discovers an iOS slot placed after the follower starts', async () => {
  const stop = followHostedLogs(root, false);
  try {
    writeHostedIos(root, 'tablet', placement());
    logRecords = [{ ts: 1, src: 'device', level: 'error', msg: 'late slot failure' }];
    await vi.waitFor(
      () =>
        expect(readFileSync(join(workspaceLogsDir(root), 'ios.tablet-host.ndjson'), 'utf8')).toContain(
          'late slot failure',
        ),
      { timeout: 3000 },
    );
  } finally {
    stop();
  }
});

test('a timed-out handoff retries busy offers within the upload fallback', async () => {
  const target = await prepareHostedIos('mini', {}, placement());
  const original = target.host.connection.request.bind(target.host.connection);
  let busy = 0;
  const request = vi.spyOn(target.host.connection, 'request').mockImplementation(async (method, params, timeout) => {
    if (method === 'device-host.app.handoff') {
      busy = 2;
      throw Object.assign(new Error('handoff timed out'), { code: 'timeout' });
    }
    if (method === 'device-host.app.offer' && busy-- > 0)
      return {
        error: { code: 'action-failed', message: 'This hosted session already has a native operation in progress.' },
      };
    return original(method, params, timeout);
  });
  const note = vi.fn<(line: string) => void>();
  try {
    await expect(
      placeHostedIos(target, {
        root,
        slot: 'default',
        bundle: join(root, 'Fixture.app'),
        bundleId: 'dev.fixture',
        release: true,
        selectors: {},
        reserved: (value) => writeHostedIos(root, 'default', value),
        note,
        metro: async () => ({ gatewayPort: 8111, secret: 'a'.repeat(64) }),
        handoff: { nodeId: target.host.credential.nodeId, token: 'a'.repeat(64), sha256: 'b'.repeat(64) },
      }),
    ).resolves.toHaveProperty('launched', true);
    expect(note).toHaveBeenCalledWith(expect.stringContaining('uploading the app instead'));
    expect(methods.some((entry) => entry.method === 'device-host.app.chunk')).toBe(true);
  } finally {
    request.mockRestore();
  }
});

const autoPlacement = (localLive = false, appMode?: HostedAppOffer['mode']) =>
  automaticDevicePlacement(
    {
      root,
      slot: 'default',
      platform: 'ios',
      selectors: {},
      appMode,
      noWait: true,
    },
    {
      peek: () => ({ count: 3, max: 3, queued: 1, localLive }),
      capacity: () => ({ cpus: 4, loadPerCore: 5, builds: 0, maxBuilds: 0, maxLoadPerCore: 2 }),
      memory: () => 'normal',
      budget: async () => {
        if (localLive || readHostedIos(root).default) throw new Error('sticky outcomes must not measure the budget');
        return null;
      },
    },
  );

test('auto uses an admitted offer with no-wait and closes its probe before reservation', async () => {
  const result = await autoPlacement();
  expect(result.placement).toMatchObject({ decision: 'hosted', machine: 'mini' });
  expect(result.target?.selection).toMatchObject({ selected: 'auto' });
  expect(result.target?.host.connection.close).toHaveBeenCalledOnce();
  expect(methods.map((each) => each.method)).toContain('device-host.offer');
  expect(methods.map((each) => each.method)).not.toContain('device-host.reserve');
});

test('auto reports a declined offer and falls to the local path without reserving', async () => {
  declined = 'All configured hosted device reservations are occupied';
  const result = await autoPlacement();
  expect(result).toMatchObject({
    target: null,
    placement: { decision: 'local' },
    skipped: [{ machine: 'mini', reason: 'declined: ' + declined }],
  });
  expect(methods.map((each) => each.method)).not.toContain('device-host.reserve');
});

test('remote.easFallback asks EAS only when this Mac is full and no host admits', async () => {
  const eas = vi.fn<() => Promise<{ usable: true }>>(async () => ({ usable: true }));
  const place = (count: number) =>
    automaticDevicePlacement(
      { root, slot: 'default', platform: 'ios', selectors: {}, noWait: true, eas },
      {
        peek: () => ({ count, max: 3, queued: 0, localLive: false }),
        capacity: () => ({ cpus: 4, loadPerCore: 5, builds: 0, maxBuilds: 0, maxLoadPerCore: 2 }),
        memory: () => 'normal',
        budget: async () => null,
      },
    );
  expect((await place(3)).placement).toMatchObject({ decision: 'hosted', machine: 'mini' });
  declined = 'All configured hosted device reservations are occupied';
  expect((await place(1)).placement).toMatchObject({ decision: 'local' });
  expect(eas).not.toHaveBeenCalled();
  expect(await place(3)).toMatchObject({
    target: null,
    code: 'eas-fallback',
    placement: { decision: 'eas', machine: 'eas', reason: expect.stringContaining('no host admits') },
  });
  expect(eas).toHaveBeenCalledOnce();
  writeConfigSetting({ scope: 'machine' }, 'remote.devicePoolDisabled', ['local']);
  eas.mockClear();
  await expect(place(1)).rejects.toMatchObject({ code: 'STIM_HOSTING_REFUSED' });
  expect(eas).not.toHaveBeenCalled();
  expect((await place(3)).placement).toMatchObject({ decision: 'eas' });
  expect(eas).toHaveBeenCalledOnce();
  expect(methods.map((each) => each.method)).not.toContain('device-host.reserve');
  writeFileSync(getConfigPath(), JSON.stringify({}));
  expect((await place(3)).placement).toMatchObject({
    decision: 'eas',
    reason: expect.stringContaining('no remote Macs'),
  });
});

test('a recorded session wins regardless of the current load and unknown sessions refuse', async () => {
  writeHostedIos(root, 'default', placement());
  const result = await autoPlacement();
  expect(result.placement).toMatchObject({ decision: 'hosted', machine: 'mini', reason: 'recorded session on mini' });
  expect(methods.map((each) => each.method)).not.toContain('device-host.offer');
  sessionState = 'unknown';
  await expect(autoPlacement()).rejects.toMatchObject({ code: 'STIM_HOSTING_REFUSED' });
  expect(readHostedIos(root).default?.session).toBe(sessionId);
});

test.each([false, true])('a stopped recorded session places again, with live local device: %s', async (localLive) => {
  writeHostedIos(root, 'default', placement());
  sessionState = 'stopped';
  const result = await autoPlacement(localLive);
  expect(result.placement).toMatchObject(
    localLive
      ? { decision: 'local', reason: "this workspace's device runs here" }
      : { decision: 'hosted', machine: 'mini' },
  );
  expect(result.placement.reason).not.toBe('recorded session on mini');
  expect(readHostedIos(root)).toEqual({});
  expect(methods.filter((each) => each.method === 'device-host.offer')).toHaveLength(localLive ? 0 : 1);
});

test('auto stores its selection and reason after delivery, and a reserve race fails without re-placement', async () => {
  const selected = await autoPlacement();
  const options = {
    root,
    slot: 'default',
    bundle: join(root, 'Fixture.app'),
    bundleId: 'dev.fixture',
    release: true,
    selectors: {},
    note: () => {},
    reserved: (value: HostedIosPlacement) => writeHostedIos(root, 'default', value),
  };
  const run = await placeHostedIos(selected.target! as Awaited<ReturnType<typeof prepareHostedIos>>, options);
  writeHostedIos(root, 'default', run.placement);
  expect(readHostedIos(root).default).toMatchObject({ selected: 'auto', reason: selected.placement.reason });
  const resumed = await autoPlacement();
  const resumedRun = await placeHostedIos(resumed.target! as Awaited<ReturnType<typeof prepareHostedIos>>, options);
  expect(resumedRun.placement).toMatchObject({ selected: 'auto', reason: selected.placement.reason });
  writeHostedIos(root, 'default', { ...resumedRun.placement, selected: 'mini', reason: 'named selection' });
  const named = await autoPlacement();
  const namedRun = await placeHostedIos(named.target! as Awaited<ReturnType<typeof prepareHostedIos>>, options);
  expect(namedRun.placement).toMatchObject({ selected: 'mini', reason: 'named selection' });
  writeHostedIos(root, 'default', null);
  methods = [];
  const racing = await autoPlacement();
  errorMethod = 'device-host.reserve';
  errorCode = 'at-capacity';
  errorMessage = 'All configured hosted device reservations are occupied';
  await expect(
    placeHostedIos(racing.target! as Awaited<ReturnType<typeof prepareHostedIos>>, options),
  ).rejects.toMatchObject({
    code: 'STIM_HOSTING_REFUSED',
    message: expect.stringContaining('mini'),
    remedy: 'Retry stim ios --remote auto.',
  });
  expect(methods.filter((each) => each.method === 'device-host.offer')).toHaveLength(1);
  expect(readHostedIos(root)).toEqual({});
});

test.each([undefined, 'mini', 'local'])(
  'auto ranks build preferences with STIM_REMOTE_BUILD=%s',
  async (preference) => {
    vi.stubEnv('STIM_REMOTE_BUILD', preference);
    writeFileSync(getConfigPath(), JSON.stringify({ remote: { machines: ['mini', 'other'], build: 'other' } }));
    writeFileSync(
      deviceHostMachinesFile(),
      JSON.stringify({
        version: 1,
        machines: [credential, { ...credential, machine: 'other', deviceToken: 'other-token', nodeId: 'nOther' }],
      }),
    );
    const started: string[] = [];
    const closes: ReturnType<typeof vi.fn<() => void>>[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    open.mockImplementation(async (_target: Parameters<typeof BuildConnection.open>[0], token: string) => {
      const machine = token === 'other-token' ? 'other' : 'mini';
      const connection = Object.create(BuildConnection.prototype) as BuildConnection;
      connection.close = vi.fn<() => void>();
      closes.push(connection.close as ReturnType<typeof vi.fn<() => void>>);
      connection.request = async () => {
        started.push(machine);
        await gate;
        return {
          result: {
            platform: 'ios',
            choice: device,
            declined: null,
            capacity: { available: 1 },
            resources: { memoryPressure: 'normal', loadPerCore: machine === 'mini' ? 0.1 : 4, memoryFreeBytes: 100 },
          },
        };
      };
      return connection;
    });
    const pending = autoPlacement();
    try {
      await vi.waitFor(() => expect(started).toEqual(['mini', 'other']));
    } finally {
      finish();
    }
    const selected = await pending;
    expect(selected.placement).toMatchObject({
      decision: 'hosted',
      machine: preference === undefined ? 'other' : 'mini',
    });
    vi.unstubAllEnvs();
    expect(closes.map((close) => close.mock.calls.length)).toEqual([1, 1]);
  },
);

test.each([true, 'unverified'] as const)(
  'process delivery closes the previous Metro route without development routing and preserves %s readiness',
  async (verdict) => {
    appLaunched = verdict;
    hostFeatures = ['hosted-ios-process'];
    writeHostedIos(root, 'default', placement());
    writeWorkspaceState(root, {
      hostedMetroRequests: {
        [sessionId]: {
          id: sessionId,
          machine: 'mini',
          address: '100.64.0.2',
          peer: '100.64.0.7',
          secret: 'a'.repeat(64),
        },
      },
    });
    const run = await deliver(false, 'default', 'process');
    expect(run.launched).toBe(verdict);
    expect(run.placement.session).toBe(sessionId);
    expect(methods.some(({ method }) => method === 'device-host.reserve' || method === 'device-host.metro.open')).toBe(
      false,
    );
    expect(methods.find(({ method }) => method === 'device-host.metro.close')?.params).toEqual({ session: sessionId });
    expect(readWorkspaceState(root)?.hostedMetroRequests).not.toHaveProperty(sessionId);
    const offer = methods.find(({ method }) => method === 'device-host.app.offer')!.params;
    expect(offer.mode).toBe('process');
    expect(offer.devClientScheme).toBeUndefined();
  },
);

test('an older host refuses process mode before offer, reservation, upload or recorded-state mutation', async () => {
  const original = placement();
  writeHostedIos(root, 'default', original);
  await expect(deliver(false, 'default', 'process')).rejects.toMatchObject({
    code: 'STIM_HOSTING_REFUSED',
    remedy: expect.stringContaining('Update stim-server'),
  });
  expect(methods).toEqual([]);
  expect(readHostedIos(root).default).toEqual(original);
});

test('a reconnect to an older host refuses process mode before reservation or upload', async () => {
  hostFeatures = ['hosted-ios-process'];
  const target = await prepareHostedIos('mini', {}, undefined, 'process');
  hostFeatures = [];
  methods = [];
  const reserved = vi.fn<() => void>();
  await expect(
    placeHostedIos(target, {
      root,
      slot: 'default',
      bundle: join(root, 'Fixture.app'),
      bundleId: 'dev.fixture',
      release: false,
      mode: 'process',
      selectors: {},
      reserved,
      note: () => {},
    }),
  ).rejects.toMatchObject({ code: 'STIM_HOSTING_REFUSED', remedy: expect.stringContaining('Update stim-server') });
  expect(methods).toEqual([]);
  expect(reserved).not.toHaveBeenCalled();
  expect(readHostedIos(root)).toEqual({});
  target.host.connection.close();
});

test('automatic process placement skips an older host but never replaces its recorded session', async () => {
  const placed = await autoPlacement(false, 'process');
  expect(placed.target).toBeNull();
  expect(placed.skipped).toEqual([
    expect.objectContaining({ machine: 'mini', reason: expect.stringContaining('process apps') }),
  ]);
  expect(methods).toEqual([]);
  const original = placement();
  writeHostedIos(root, 'default', original);
  await expect(autoPlacement(false, 'process')).rejects.toMatchObject({ code: 'STIM_HOSTING_REFUSED' });
  expect(methods).toEqual([]);
  expect(readHostedIos(root).default).toEqual(original);
  hostFeatures = ['hosted-ios-process'];
  const resumed = await autoPlacement(false, 'process');
  expect(resumed).toMatchObject({ sticky: true, target: { session: { id: sessionId } } });
  expect(methods.some(({ method }) => method === 'device-host.offer' || method === 'device-host.reserve')).toBe(false);
});

test('automatic device exclusion skips offers, preserves a live session, and blocks a newly selected reservation', async () => {
  const selected = await autoPlacement();
  writeConfigSetting({ scope: 'machine' }, 'remote.devicePoolDisabled', ['mini']);
  methods = [];
  expect((await autoPlacement()).placement.decision).toBe('local');
  expect(methods).toEqual([]);
  await expect(
    placeHostedIos(selected.target! as Awaited<ReturnType<typeof prepareHostedIos>>, {
      root,
      slot: 'default',
      bundle: join(root, 'Fixture.app'),
      bundleId: 'dev.fixture',
      release: true,
      selectors: {},
      note: () => {},
      reserved: () => {},
    }),
  ).rejects.toThrow('disabled');
  expect(methods.some((entry) => entry.method === 'device-host.reserve')).toBe(false);
  writeHostedIos(root, 'default', placement());
  expect((await autoPlacement()).placement).toMatchObject({ decision: 'hosted', machine: 'mini' });
});
