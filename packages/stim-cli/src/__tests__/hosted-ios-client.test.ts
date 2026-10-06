import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildConnection } from '../offload/client.ts';
import { deviceHostMachinesFile, type HostedIosPlacement } from '@stim-cli/core/state';
import { prepareHostedIos, placeHostedIos, stopHostedIos } from '../device-host/hosted-ios.ts';
import { readHostedIos, writeHostedIos } from '../device-host/ios-state.ts';
import { applyHostedIosProbe } from '../device-host/hosted-ios-status.ts';
import { probeHostedSession } from '../device-host/hosted-client.ts';
import { gatewayAddresses, clearHostedMetro } from '../device-host/metro-gateway.ts';
import { reconcileHostedMetro, watchHostedMetro } from '../supervisor/hosted-metro.ts';
import { getConfigPath, getProject, upsertProject } from '../workspace/config.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { workspaceStateFile } from '../workspace/paths.ts';
import { launchSlotScope, siblingPlatformSlots } from '../engine/slot-launch.ts';
import { workspaceIdleProbe } from '../supervisor/idle-stop.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import { runStop } from '../commands/stop.ts';
import { connectIosTarget } from '../commands/ios/remote.ts';
import { DEFAULT_DEPS } from '../commands/ios/dependencies.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { runReload } from '../commands/reload.ts';

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

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'stim-ios-host-'));
  process.env.STIM_HOME = home;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-host-app-')));
  mkdirSync(join(root, 'Fixture.app'));
  writeFileSync(join(root, 'Fixture.app', 'Info.plist'), 'app metadata');
  writeFileSync(getConfigPath(), JSON.stringify({ hosting: { machines: ['mini'] } }));
  writeFileSync(deviceHostMachinesFile(), JSON.stringify({ version: 1, machines: [credential] }));
  methods = [];
  blobs = new Map();
  sessionState = 'ready';
  errorMethod = '';
  errorCode = 'forbidden';
  errorSession = '';
  errorMessage = 'fixture refusal';
  declined = null;
  capacity = 1;
  pressure = 'normal';
  tailnet.changed = false;
  const connection = Object.create(BuildConnection.prototype) as BuildConnection;
  connection.close = () => {};
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
      return reply({ state: 'installed', launched: true });
    throw new Error(`Unexpected fixture method ${method}`);
  };
  open = vi.spyOn(BuildConnection, 'open').mockResolvedValue(connection);
});
afterEach(async () => {
  open.mockRestore();
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
async function deliver(release = false) {
  const target = await prepareHostedIos(
    'mini',
    { deviceType: 'iPhone 17 Pro', runtime: 'iOS 27.0' },
    readHostedIos(root).default,
  );
  try {
    return await placeHostedIos(target, {
      root,
      slot: 'default',
      bundle: join(root, 'Fixture.app'),
      bundleId: 'dev.fixture',
      release,
      selectors: { deviceType: 'iPhone 17 Pro', runtime: 'iOS 27.0' },
      devClientScheme: 'exp+fixture',
      reserved: (value) => writeHostedIos(root, 'default', value),
      note: () => {},
      metro: async () => ({ gatewayPort: 8111, secret: 'a'.repeat(64) }),
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
  expect(statSync(workspaceStateFile(root)).mode & 0o777).toBe(0o600);
  expect(workspaceIdleProbe(root).blocker()).toContain('runs on mini');
});

test.each(['declined', 'capacity', 'pressure', 'changed-node'])(
  'strict %s refusal reserves nothing',
  async (reason) => {
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
      expect(statSync(workspaceStateFile(root)).mode & 0o777).toBe(0o600);
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

test.each(['forbidden', 'capacity'])('stop handles a hello refusal with host code %s', async (code) => {
  writeHostedIos(root, 'default', placement());
  open.mockResolvedValue({ refused: true, code, failure: 'This Mac is refused.' });
  const result = await runStop({ root, report: () => {} });
  expect(result.ok).toBe(code === 'forbidden');
  expect(readHostedIos(root)).toEqual(code === 'forbidden' ? {} : { default: placement() });
  expect(methods).toEqual([]);
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
    if (reason === 'invalid-config') writeFileSync(getConfigPath(), JSON.stringify({ hosting: { machines: true } }));
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
              ? 'hosting.machines'
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
