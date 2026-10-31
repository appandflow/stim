import { automaticDevicePlacement } from '../device-host/auto-placement.ts';
import { createHash } from 'node:crypto';
import { Command } from 'commander';
import logsCommand from '../commands/logs.ts';

import { syncHostedLogs, followHostedLogs } from '../device-host/hosted-logs-sync.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { runStop } from '../commands/stop.ts';
import { existsSync, mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceHostMachinesFile, type HostedAndroidPlacement, type HostedAppOffer } from '@stim-cli/core/state';
import { getExecutor, setExecutor, resetExecutor } from '../exec.ts';
import { BuildConnection } from '../offload/client.ts';
import { getConfigPath, upsertProject } from '../workspace/config.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { prepareHostedAndroid, placeHostedAndroid, stopHostedAndroid } from '../device-host/hosted-android.ts';
import { androidAgentRemoteConfig } from '../device-host/hosted-native.ts';
import { readHostedAndroid, writeHostedNative } from '../device-host/ios-state.ts';

import { runReload } from '../commands/reload.ts';

const writeHostedAndroid = (root: string, slot: string, host: HostedAndroidPlacement | null): void =>
  writeHostedNative(root, slot, host, 'android');

vi.mock('../offload/tailnet.ts', async (original) => ({
  ...(await original<typeof import('../offload/tailnet.ts')>()),
  realIo: { ...(await original<typeof import('../offload/tailnet.ts')>()).realIo, status: () => null },
  tailscaleStatusAsync: async () => null,
  resolveEndpoint: () => ({ url: 'ws://127.0.0.1:12345', host: 'mini', servername: 'mini' }),
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
let processFeature: boolean;
let appLaunched: true | 'unverified';
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
  writeFileSync(getConfigPath(), JSON.stringify({ remote: { machines: ['mini'] } }));
  writeFileSync(
    deviceHostMachinesFile(),
    JSON.stringify({
      version: 2,
      machines: [
        {
          machine: 'mini',
          transport: 'tailscale',
          address: 'mini.tail.ts.net',
          serverKey: 'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKA',
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
  processFeature = true;
  appLaunched = true;
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
    feature === 'hosted-android-process'
      ? processFeature
      : feature === 'hosted-android-agent'
        ? agentFeature
        : feature !== 'hosted-android-data' || dataFeature;
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
      return { result: { state: 'installed', launched: appLaunched, agent: agentGrant, notice: agentNotice } };
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

test('stim logs queries the host for native logs only when device records can be read', async () => {
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  writeFileSync(
    join(workspaceLogsDir(root), 'build-android.ndjson'),
    JSON.stringify({ ts: 1, src: 'build', level: 'info', msg: 'built' }) + '\n',
  );
  writeHostedAndroid(root, 'default', placement);
  logRecords = [{ ts: 2, src: 'device', level: 'info', msg: 'startup' }];
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const cwd = process.cwd();
  process.chdir(root);
  const run = async (...args: string[]) => {
    output.mockClear();
    const program = new Command();
    logsCommand(program);
    await program.parseAsync(['node', 'stim', 'logs', '--json', ...args]);
    return output.mock.calls.map(([line]) => JSON.parse(String(line)).msg);
  };
  const queries = () => methods.filter((entry) => entry.method === 'device-host.logs.query').length;
  try {
    expect(await run('--source', 'build')).toEqual(['built']);
    expect(queries()).toBe(0);
    expect(await run('--source', 'device')).toEqual(['startup']);
    expect(queries()).toBeGreaterThan(0);
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

const autoPlacement = (localLive = false, appMode?: HostedAppOffer['mode']) =>
  automaticDevicePlacement(
    {
      root,
      slot: 'default',
      platform: 'android',
      appMode,
      selectors: {},
      noWait: true,
    },
    {
      peek: () => ({ count: 3, max: 3, queued: 1, localLive }),
      capacity: () => ({ cpus: 4, loadPerCore: 5, builds: 0, maxBuilds: 0, maxLoadPerCore: 2 }),
      memory: () => 'normal',
    },
  );

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

test('a stopped recorded session places again and a live local device remains local', async () => {
  writeHostedAndroid(root, 'default', placement);
  state = 'stopped';
  const result = await autoPlacement(true);
  expect(result).toMatchObject({
    target: null,
    placement: { decision: 'local', reason: "this workspace's device runs here" },
  });
  expect(readHostedAndroid(root)).toEqual({});
  expect(methods.map((each) => each.method)).not.toContain('device-host.offer');
});
