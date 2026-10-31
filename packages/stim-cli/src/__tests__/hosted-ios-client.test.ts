import { automaticDevicePlacement } from '../device-host/auto-placement.ts';
import { withAmbientContext } from '@stim-cli/core';
import { testContext } from './_context.ts';
import { createServer } from 'node:net';
import { FAKE_SERVER_PUBLIC } from './_noise-server.ts';
import { createHash } from 'node:crypto';
import {
  type PathLike,
  type WatchListener,
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
import { deviceHostMachinesFile, type HostedIosPlacement, type HostedAppOffer } from '@stim-cli/core/state';
import { prepareHostedIos, placeHostedIos, stopHostedIos } from '../device-host/hosted-ios.ts';
import { hostedMetroPortProbe, iosAgentRemoteConfig } from '../device-host/hosted-native.ts';
import { readHostedIos, writeHostedNative } from '../device-host/ios-state.ts';
import { applyHostedIosProbe } from '../device-host/hosted-ios-status.ts';
import { probeHostedSession } from '../device-host/hosted-client.ts';
import { getConfigPath, getProject, upsertProject, writeConfigSetting } from '../workspace/config.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { pullHostedNativeLogs, readHostedNativeLogs } from '../device-host/hosted-logs.ts';
import { followHostedMacosLogs, followHostedLogs, syncHostedLogs } from '../device-host/hosted-logs-sync.ts';
import { workspaceLogsDir, workspaceStateFile } from '../workspace/paths.ts';
import { workspaceIdleProbe } from '../supervisor/idle-stop.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import { runStop } from '../commands/stop.ts';

import { workspaceInUse } from '../workspace/in-use.ts';
import { runReload } from '../commands/reload.ts';
import { getExecutor, setExecutor, resetExecutor } from '../exec.ts';
import { agentRemoteConfig } from '../device-host/hosted-macos.ts';

const writeHostedIos = (root: string, slot: string, host: HostedIosPlacement | null): void =>
  writeHostedNative(root, slot, host, 'ios');

await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
});

const tailnet = vi.hoisted(() => ({ port: 0, changed: false }));
const watcher = vi.hoisted(() => ({ dropEvents: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    watch: (
      file: PathLike,
      options: WatchListener<string> | { persistent?: boolean },
      listener?: WatchListener<string>,
    ) => {
      const changed = typeof options === 'function' ? options : listener;
      return fs.watch(file, (event, name) => {
        if (!watcher.dropEvents) changed?.(event, name);
      });
    },
  };
});
vi.mock('../offload/tailnet.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../offload/tailnet.ts')>()),
  realIo: { ...(await importOriginal<typeof import('../offload/tailnet.ts')>()).realIo, status: () => null },
  tailscaleStatusAsync: async () => null,
  resolveEndpoint: () =>
    tailnet.changed
      ? 'no peer on this tailnet is named mini'
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
  transport: 'tailscale' as const,
  address: 'mini.tail.ts.net',
  serverKey: FAKE_SERVER_PUBLIC,
  deviceId: 'client',
  state: 'approved' as const,
  requestedAt: '2026-10-05T12:00:00Z',
};
let home: string;
let root: string;
let open: ReturnType<typeof vi.spyOn>;
let fixtureConnection: BuildConnection;
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
let hostBusy: number[];
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
  writeFileSync(deviceHostMachinesFile(), JSON.stringify({ version: 2, machines: [credential] }));
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
  hostBusy = [];
  agentGrant = undefined;
  fixtureConnection = Object.create(BuildConnection.prototype) as BuildConnection;
  fixtureConnection.close = vi.fn<() => void>();
  fixtureConnection.supports = (feature) =>
    feature === 'hosted-ios-agent' || feature === 'hosted-ios-process' ? hostFeatures.includes(feature) : features;
  fixtureConnection.request = async (method, raw) => {
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
    if (method === 'device-host.metro.ports')
      return reply({ busy: hostBusy.filter((port) => (params.ports as number[]).includes(port)) });
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
  open = vi.spyOn(BuildConnection, 'open').mockResolvedValue(fixtureConnection);
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
      metroPort: 8086,
      reserved: (value) => writeHostedIos(root, slot, value),
      note: () => {},
      enterPhase,
      ...(mode === 'process' ? {} : { metro: async () => {} }),
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
  expect(methods.find((entry) => entry.method === 'device-host.metro.open')?.params).toMatchObject({
    clientMetroPort: 8086,
  });
  expect(readHostedIos(root).default?.device?.udid === device.udid).toBe(true);
  expect(getProject(root)?.platforms?.ios).toBeUndefined();
  for (const [digest, bytes] of blobs) expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
  expect(statSync(workspaceStateFile(root)).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
  expect(workspaceIdleProbe(root).blocker()).toContain('runs on mini');
});

test('missing configuration and approval keep their existing credential remedies', async () => {
  await expect(prepareHostedIos('other', {})).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
  rmSync(deviceHostMachinesFile());
  await expect(prepareHostedIos('mini', {})).rejects.toThrow('Run stim remote add mini');
  expect(methods).toEqual([]);
});

test('a dev-client Metro port held on the host refuses with the metro.port remedy before any upload', async () => {
  errorMethod = 'device-host.metro.open';
  errorCode = 'device-busy';
  await expect(deliver()).rejects.toMatchObject({
    code: 'STIM_HOSTING_REFUSED',
    remedy: expect.stringContaining('metro.port'),
  });
  expect(methods.some((entry) => entry.method === 'device-host.app.offer')).toBe(false);
});

test('the host Metro port probe answers from the host and counts an older or unanswering host as free', async () => {
  hostBusy = [8083];
  const notes: string[] = [];
  const free = hostedMetroPortProbe('mini', (line) => notes.push(line));
  expect([await free(8082), await free(8083), await free(8084)]).toEqual([true, false, true]);
  features = false;
  expect(await hostedMetroPortProbe('mini', () => {})(8083)).toBe(true);
  features = true;
  errorMethod = 'device-host.metro.ports';
  expect(await hostedMetroPortProbe('mini', (line) => notes.push(line))(8083)).toBe(true);
  expect(notes).toEqual([expect.stringContaining('Could not check which Metro ports are free on mini')]);
});

test('probe caches owner evidence and missing sessions become stopped', async () => {
  const pending = placement();
  pending.session = '23456789-1234-1234-1234-123456789abc';
  await probeHostedSession(pending);
  await probeHostedSession(pending);
  expect(methods.filter((entry) => entry.method === 'device-host.attach')).toHaveLength(1);
  const otherHome = join(home, 'other-home');
  expect(await withAmbientContext(testContext({ home: otherHome }), () => probeHostedSession(pending))).toMatchObject({
    state: 'unreachable',
  });
  expect(await probeHostedSession(pending)).toEqual({ state: 'ready' });
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

test('cancelling a hosted stop preserves both placements and never stops the sibling', async () => {
  const sibling = { ...placement(), session: '34567890-1234-1234-1234-123456789abc' };
  writeHostedIos(root, 'default', placement());
  writeHostedIos(root, 'tablet', sibling);
  const controller = new AbortController();
  const cancelled = new Error('cancel hosted cleanup');
  const request = fixtureConnection.request.bind(fixtureConnection);
  fixtureConnection.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === 'device-host.stop') controller.abort(cancelled);
    return result;
  };

  await expect(stopHostedIos(root, undefined, controller.signal)).rejects.toBe(cancelled);
  expect(readHostedIos(root)).toEqual({ default: placement(), tablet: sibling });
  expect(methods.filter((entry) => entry.method === 'device-host.stop')).toHaveLength(1);
  expect(fixtureConnection.close).toHaveBeenCalled();
});

test('cancelling stim stop during the final log copy keeps the placement, and a rerun copies each record once', async () => {
  writeHostedIos(root, 'default', placement());
  logRecords = [1, 2, 3, 4, 5].map((ts) => ({ ts, src: 'device', level: 'info', msg: `native ${ts}` }));
  const controller = new AbortController();
  const cancelled = new Error('cancel stim stop');
  const request = fixtureConnection.request.bind(fixtureConnection);
  fixtureConnection.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === 'device-host.logs.query') controller.abort(cancelled);
    return result;
  };

  await expect(runStop({ root, report: () => {}, operation: testContext({ signal: controller.signal }) })).rejects.toBe(
    cancelled,
  );
  expect(readHostedIos(root)).toEqual({ default: placement() });
  expect(readHostedNativeLogs(root, 'ios', 'default')).toEqual([]);

  fixtureConnection.request = request;
  const result = await runStop({ root, report: () => {} });
  expect(result.ok).toBe(true);
  expect(readHostedIos(root)).toEqual({});
  expect(readHostedNativeLogs(root, 'ios', 'default').map((record) => record.msg)).toEqual(
    logRecords.map((record) => record.msg),
  );
});

test.each([
  ['forbidden', true, ''],
  ['capacity', false, 'run stim doctor, restore hosting access, then rerun stim stop'],
  ['unauthorized', false, 'run stim doctor, restore hosting access, then rerun stim stop'],
])('stop handles a hello refusal with host code %s', async (code, cleared, remedy) => {
  writeHostedIos(root, 'default', placement());
  open.mockResolvedValue({ refused: true, code, failure: 'This machine is refused.' });
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
  open.mockResolvedValue({ refused: true, code: 'forbidden', failure: 'This machine is refused.' });
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

test('hosted stop failures cannot overwrite the local default-slot outcome', async () => {
  upsertProject(root, { platforms: { ios: { owned: true, deviceUdid: 'LOCAL' } } });
  writeHostedIos(root, 'default', placement());
  writeHostedIos(root, 'tablet', { ...placement(), session: '34567890-1234-1234-1234-123456789abc' });
  errorMethod = 'device-host.stop';
  errorCode = 'closed';
  errorSession = sessionId;
  const teardown = vi.fn<NonNullable<Parameters<typeof runStop>[0]['teardownIos']>>(async () => ({
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

test('removing a hosted slot closes its pending log request and re-adding it resumes collection', async () => {
  writeHostedIos(root, 'tablet', placement());
  const target = await prepareHostedIos('mini', {}, placement());
  vi.mocked(target.host.connection.close).mockClear();
  const original = target.host.connection.request.bind(target.host.connection);
  let release = () => {};
  let pending = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = vi.spyOn(target.host.connection, 'request').mockImplementation(async (method, params, timeout) => {
    if (method === 'device-host.logs.query' && !pending) {
      pending = true;
      await gate;
    }
    return original(method, params, timeout);
  });
  logRecords = [{ ts: 1, src: 'device', level: 'error', msg: 'removed slot log' }];
  const stop = followHostedLogs(root, false);
  try {
    await vi.waitFor(() => expect(pending).toBe(true), { timeout: 3000 });
    writeHostedIos(root, 'tablet', null);
    await vi.waitFor(() => expect(target.host.connection.close).toHaveBeenCalled(), { timeout: 3000 });
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const file = join(workspaceLogsDir(root), 'ios.tablet-host.ndjson');
    expect(existsSync(file)).toBe(false);

    logRecords = [{ ts: 2, src: 'device', level: 'error', msg: 're-added slot log' }];
    writeHostedIos(root, 'tablet', placement());
    await vi.waitFor(() => expect(readFileSync(file, 'utf8')).toContain('re-added slot log'), { timeout: 3000 });
  } finally {
    release();
    stop();
    request.mockRestore();
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
        metro: async () => {},
        handoff: { serverKey: target.host.credential.serverKey!, token: 'a'.repeat(64), sha256: 'b'.repeat(64) },
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

test('remote-only waits for a full host and places once it has room, and refuses at once with no-wait or a host that is out', async () => {
  const full = 'All configured hosted device reservations are occupied';
  let clock = 0;
  const sleeps: number[] = [];
  const place = (noWait: boolean, waitMs: number, onSleep: () => void = () => {}, onWait?: (line: string) => void) =>
    automaticDevicePlacement(
      { root, slot: 'default', platform: 'ios', placement: 'remote-only', selectors: {}, noWait, waitMs, onWait },
      {
        peek: () => ({ count: 3, max: 3, queued: 1, localLive: false }),
        capacity: () => ({ cpus: 4, loadPerCore: 1, builds: 0, maxBuilds: 0, maxLoadPerCore: 2 }),
        memory: () => 'normal',
        budget: async () => null,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
          onSleep();
        },
      },
    );
  declined = full;
  capacity = 0;
  const waiting = vi.fn<(line: string) => void>();
  const placed = await place(
    false,
    60_000,
    () => {
      if (sleeps.length === 2) [declined, capacity] = [null, 1];
    },
    waiting,
  );
  expect(placed.placement).toMatchObject({ decision: 'hosted', machine: 'mini' });
  expect(sleeps).toEqual([5000, 5000]);
  expect(waiting).toHaveBeenCalledOnce();

  [declined, capacity] = [full, 0];
  sleeps.length = 0;
  await expect(place(true, 60_000)).rejects.toMatchObject({ code: 'STIM_AT_CAPACITY' });
  await expect(place(false, 0)).rejects.toMatchObject({ code: 'STIM_AT_CAPACITY' });
  expect(sleeps).toEqual([]);
  clock = 0;
  await expect(place(false, 12_000)).rejects.toMatchObject({
    code: 'STIM_AT_CAPACITY',
    message: expect.stringContaining('waited 12s'),
  });
  expect(sleeps).toEqual([5000, 5000, 2000]);

  [declined, capacity] = ['Hosted sessions are paused', 1];
  sleeps.length = 0;
  await expect(place(false, 60_000)).rejects.toMatchObject({ code: 'STIM_HOSTING_REFUSED' });
  expect(sleeps).toEqual([]);
});

test('an aborted run ends the remote-only wait instead of polling to its deadline', async () => {
  declined = 'All configured hosted device reservations are occupied';
  capacity = 0;
  const controller = new AbortController();
  let sleeps = 0;
  await expect(
    automaticDevicePlacement(
      {
        root,
        slot: 'default',
        platform: 'ios',
        placement: 'remote-only',
        selectors: {},
        noWait: false,
        waitMs: 600_000,
        signal: controller.signal,
      },
      {
        peek: () => ({ count: 3, max: 3, queued: 0, localLive: false }),
        capacity: () => ({ cpus: 4, loadPerCore: 1, builds: 0, maxBuilds: 0, maxLoadPerCore: 2 }),
        memory: () => 'normal',
        budget: async () => null,
        now: () => 0,
        sleep: async () => {
          sleeps++;
          controller.abort();
        },
      },
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(sleeps).toBe(1);
});

test('remote.easFallback asks EAS only when this machine is full and no host admits', async () => {
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
    reason: expect.stringContaining('no remote machines'),
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
