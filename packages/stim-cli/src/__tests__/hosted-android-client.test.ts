import { createHash } from 'node:crypto';
import { Command } from 'commander';
import logsCommand from '../commands/logs.ts';
import { pullHostedNativeLogs } from '../device-host/hosted-logs.ts';
import { syncHostedLogs, followHostedLogs } from '../device-host/hosted-logs-sync.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { runStop } from '../commands/stop.ts';
import {
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceHostMachinesFile, type HostedAndroidPlacement } from '@stim-cli/core/state';
import { getExecutor, setExecutor, resetExecutor } from '../exec.ts';
import { BuildConnection } from '../offload/client.ts';
import { getConfigPath, getProject, upsertProject } from '../workspace/config.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import {
  androidAgentRemoteConfig,
  prepareHostedAndroid,
  placeHostedAndroid,
  stopHostedAndroid,
} from '../device-host/hosted-android.ts';
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
let blobs: Map<string, Buffer>;
let retained: Map<string, Buffer>;
let dataFeature: boolean;
let agentFeature: boolean;
let agentGrant: unknown;
let agentNotice: string | undefined;
let handoffFailure: boolean;
let logRecords: Record<string, unknown>[];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

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
  blobs = new Map();
  retained = new Map();
  dataFeature = true;
  agentFeature = true;
  agentGrant = undefined;
  agentNotice = undefined;
  handoffFailure = false;
  logRecords = [];
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '0.0.0' } }),
  );
  const connection = Object.create(BuildConnection.prototype) as BuildConnection;
  connection.close = () => {};
  connection.supports = (feature) =>
    feature === 'hosted-android-agent' ? agentFeature : feature !== 'hosted-android-data' || dataFeature;
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
    if (method === 'device-host.stop')
      logRecords.push({ ts: 100, src: 'device', level: 'error', msg: 'stop-time native tail' });
    if (method === 'device-host.reserve' || method === 'device-host.attach' || method === 'device-host.stop')
      return {
        result: { id: session, platform: 'android', state: method === 'device-host.stop' ? 'stopped' : state, device },
      };
    if (method === 'device-host.logs.query') {
      const cursor = params.cursor as Record<string, number> | undefined;
      const from = cursor?.['device.ndjson'] ?? 0;
      const end = Math.min(logRecords.length, from + 2);
      return {
        result: {
          records: logRecords.slice(from, end),
          cursor: { 'device.ndjson': end },
          more: end < logRecords.length,
        },
      };
    }
    if (method === 'device-host.app.offer') {
      const declared = params.manifest as { sha256: string; size: number };
      manifest = blobs.get(declared.sha256) ?? Buffer.alloc(0);
      const files = manifest.length ? JSON.parse(manifest.toString()) : [declared];
      return {
        result: {
          missing: files
            .filter((file: { sha256: string }) => !blobs.has(file.sha256))
            .map((file: { sha256: string; size: number }) => ({ sha256: file.sha256, size: file.size, offset: 0 })),
        },
      };
    }
    if (method === 'device-host.app.chunk') {
      const bytes = Buffer.from(params.data as string, 'base64');
      if (sha(bytes) !== params.sha256) throw new Error('chunk digest mismatch');
      blobs.set(params.sha256 as string, bytes);
      return { result: { offset: (params.offset as number) + bytes.length } };
    }
    if (method === 'device-host.app.handoff') {
      if (handoffFailure) return { error: { code: 'action-failed', message: 'build digest refused' } };
      for (const [digest, bytes] of retained) blobs.set(digest, bytes);
      return { result: { files: retained.size, bytes: 11 } };
    }
    if (method === 'device-host.app.launch')
      return { result: { state: 'installed', launched: true, agent: agentGrant, notice: agentNotice } };
    return { result: {} };
  };
  vi.spyOn(BuildConnection, 'open').mockResolvedValue(connection);
});
afterEach(() => {
  resetExecutor();
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

async function deliver(
  handoff?: { nodeId: string; token: string; sha256: string },
  note: (line: string) => void = () => {},
) {
  const target = await prepareHostedAndroid('mini', {}, readHostedAndroid(root).default);
  return placeHostedAndroid(target, {
    root,
    slot: 'default',
    bundle: join(root, 'App.apk'),
    bundleId: 'dev.fixture',
    selectors: {},
    release: true,
    handoff,
    note,
    reserved: (value) => writeHostedAndroid(root, 'default', value),
  });
}

test('an unchanged APK rerun sends no chunks and a changed APK sends its verified manifest and content', async () => {
  await deliver();
  methods = [];
  await deliver();
  expect(methods.filter((entry) => entry.method === 'device-host.app.chunk')).toEqual([]);
  expect(methods.filter((entry) => entry.method === 'device-host.app.launch')).toHaveLength(1);
  writeFileSync(join(root, 'App.apk'), 'changed APK');
  methods = [];
  await deliver();
  const chunks = methods.filter((entry) => entry.method === 'device-host.app.chunk');
  expect(chunks).toHaveLength(2);
  expect(chunks.map((entry) => Buffer.from(entry.params.data as string, 'base64').toString())).toContain('changed APK');
});

test.each(['same-node', 'other-node', 'older-host', 'refused'])(
  'Android handoff %s retains verified upload fallback',
  async (scenario) => {
    await deliver();
    retained = new Map(blobs);
    const apk = JSON.parse(manifest.toString())[0];
    retained.delete(sha(manifest));
    blobs.clear();
    manifest = Buffer.alloc(0);
    methods = [];
    dataFeature = scenario !== 'older-host';
    handoffFailure = scenario === 'refused';
    const note = vi.fn<(line: string) => void>();
    await deliver(
      { nodeId: scenario === 'other-node' ? 'other' : 'node', token: 'a'.repeat(64), sha256: 'b'.repeat(64) },
      note,
    );
    expect(methods.some((entry) => entry.method === 'device-host.app.handoff')).toBe(
      ['same-node', 'refused'].includes(scenario),
    );
    expect(
      methods.filter((entry) => entry.method === 'device-host.app.chunk' && entry.params.sha256 === apk.sha256),
    ).toHaveLength(scenario === 'same-node' ? 0 : 1);
    expect(note.mock.calls.some(([line]) => line.includes('uploading the app instead'))).toBe(
      ['older-host', 'refused'].includes(scenario),
    );
  },
);

test('Android errors are paged into the workspace once per slot and stop copies the host final drain', async () => {
  writeHostedAndroid(root, 'tablet', placement);
  logRecords = [
    { ts: 1, src: 'device', level: 'info', msg: 'startup' },
    { ts: 2, src: 'device', level: 'error', msg: 'FATAL EXCEPTION: main' },
    { ts: 3, src: 'device', level: 'error', msg: 'AndroidRuntime crash' },
  ];
  const target = await prepareHostedAndroid('mini', {}, placement);
  await Promise.all([1, 2].map(() => pullHostedNativeLogs(root, 'tablet', placement, target.host, false, 'android')));
  const file = join(workspaceLogsDir(root), 'android.tablet-host.ndjson');
  const stored = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(stored.map((record) => record.msg)).toEqual(['startup', 'FATAL EXCEPTION: main', 'AndroidRuntime crash']);
  expect(
    stored.every((record) => record.src === 'device' && record.platform === 'android' && record.slot === 'tablet'),
  ).toBe(true);
  methods = [];
  await stopHostedAndroid(root, 'tablet');
  const stop = methods.findIndex((entry) => entry.method === 'device-host.stop');
  expect(methods.slice(0, stop).some((entry) => entry.method === 'device-host.logs.query')).toBe(true);
  expect(methods.slice(stop + 1).some((entry) => entry.method === 'device-host.logs.query')).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('stop-time native tail');
  expect(readHostedAndroid(root)).toEqual({});
});

test('stim logs --errors --json pulls Android native records without progress on stdout', async () => {
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  writeFileSync(join(workspaceLogsDir(root), 'build-android.ndjson'), '');
  writeHostedAndroid(root, 'default', placement);
  logRecords = [
    { ts: 1, src: 'device', level: 'info', msg: 'startup' },
    { ts: 2, src: 'device', level: 'error', msg: 'FATAL EXCEPTION: main' },
  ];
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const program = new Command();
    logsCommand(program);
    await program.parseAsync(['node', 'stim', 'logs', '--errors', '--json']);
    expect(output.mock.calls.map(([line]) => JSON.parse(String(line)))).toMatchObject([
      { src: 'device', platform: 'android', level: 'error', msg: 'FATAL EXCEPTION: main' },
    ]);
  } finally {
    process.chdir(cwd);
  }
});

test('older Android hosts get an update note and no log queries during sync or follow', async () => {
  writeHostedAndroid(root, 'default', placement);
  dataFeature = false;
  const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await syncHostedLogs(root)).toBe(false);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('needs a newer stim-server'));
  const stop = followHostedLogs(root, false);
  try {
    await vi.waitFor(() => expect(warning.mock.calls.length).toBe(2), { timeout: 2000 });
    expect(methods.some((entry) => entry.method === 'device-host.logs.query')).toBe(false);
  } finally {
    stop();
  }
});

const grant = () => ({
  driver: 'agent-device',
  path: `/device-host/agent/${session}/`,
  token: 's'.repeat(43),
  scope: session,
  lease: {
    tenant: `stim.${session}`,
    runId: session,
    clientId: 'agent',
    backend: 'android-instance',
    deviceKey: `android:mobile:${device.serial}`,
  },
});
async function deliverAgent(slot = 'default', note: (line: string) => void = () => {}) {
  const target = await prepareHostedAndroid('mini', {});
  return placeHostedAndroid(target, {
    root,
    slot,
    bundle: join(root, 'App.apk'),
    bundleId: 'dev.fixture',
    selectors: {},
    release: true,
    reserved: (value) => writeHostedAndroid(root, slot, value),
    note,
  });
}

test('Android grants write private slot configs, appear in status and close only the selected connection', async () => {
  agentGrant = grant();
  const first = await deliverAgent();
  const second = await deliverAgent('tablet');
  for (const [slot, run] of [
    ['default', first],
    ['tablet', second],
  ] as const) {
    const file = androidAgentRemoteConfig(root, slot);
    writeHostedAndroid(root, slot, run.placement);
    expect(statSync(file).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      daemonBaseUrl: `https://mini.tail.ts.net:7443/device-host/agent/${session}/`,
      daemonAuthToken: 's'.repeat(43),
      tenant: `stim.${session}`,
      sessionIsolation: 'tenant',
      runId: session,
      clientId: 'agent',
      leaseBackend: 'android-instance',
      leaseProvider: 'proxy',
      deviceKey: `android:mobile:${device.serial}`,
      platform: 'android',
    });
    expect(run.placement.agent).toEqual({
      driver: 'agent-device',
      remoteConfig: file,
      command: `agent-device <command> --remote-config ${file}`,
    });
    expect(applyHostedAndroidProbe(run.placement, { state: 'ready' }).android.host?.agent).toEqual(run.placement.agent);
    expect(JSON.stringify(applyHostedAndroidProbe(run.placement, { state: 'ready' }))).not.toContain('s'.repeat(43));
  }
  const config = androidAgentRemoteConfig(root, 'tablet');
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
  await stopHostedAndroid(root, 'tablet');
  expect(calls).toEqual([
    ['connection', 'status', '--json'],
    ['close', '--remote-config', config, '--session', 'agent-tablet', '--json'],
    ['disconnect', '--session', 'agent-tablet', '--json'],
  ]);
  expect(existsSync(config)).toBe(false);
  expect(existsSync(androidAgentRemoteConfig(root, 'default'))).toBe(true);
});

test.each(['older-host', 'unavailable'])(
  'Android %s reports no driver and removes obsolete credentials',
  async (reason) => {
    agentGrant = reason === 'older-host' ? grant() : { driver: 'none' };
    agentFeature = reason !== 'older-host';
    agentNotice = reason === 'unavailable' ? 'Agent control requires agent-device 0.21.22 or later.' : undefined;
    const file = androidAgentRemoteConfig(root, 'default');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{}');
    const notes: string[] = [];
    const run = await deliverAgent('default', (line) => notes.push(line));
    expect(run.placement.agent.driver).toBe('none');
    expect(existsSync(file)).toBe(false);
    expect(notes.includes('Agent control requires agent-device 0.21.22 or later.')).toBe(reason === 'unavailable');
  },
);

test('an unreachable Android stop retains the slot credential for retry', async () => {
  agentGrant = grant();
  const run = await deliverAgent();
  writeHostedAndroid(root, 'default', run.placement);
  setExecutor({ ...getExecutor(), findExecutable: () => null });
  failure = 'closed';
  await expect(stopHostedAndroid(root)).rejects.toThrow('placement is kept');
  expect(existsSync(androidAgentRemoteConfig(root, 'default'))).toBe(true);
});
