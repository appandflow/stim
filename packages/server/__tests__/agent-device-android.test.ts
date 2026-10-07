import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { keepAgentClaim, killKeptChild } from './fixtures/kept-agent-claim.ts';
import { parseHostedAgentGrant } from '@stim-cli/core/state';
import { HostedAgentHost } from '../src/agent-driver.ts';
import { AgentDeviceDriver } from '../src/agent-device-driver.ts';

const fixture = vi.hoisted(() => ({
  version: '0.21.22',
  policy: true,
  backend: true,
  proxyStopped: true,
  daemonStopped: true,
  helperBusy: false,
  avdName: '',
  adbError: null as (Error & { code?: number; killed?: boolean }) | null,
  shellMissing: false,
  helperSession: '',
  events: [] as string[],
  calls: [] as { path: string; body: string; headers: Record<string, string> }[],
}));

vi.mock('@stim-cli/core/process-identity', async (original) => {
  const actual = await original<typeof import('@stim-cli/core/process-identity')>();
  return {
    ...actual,
    captureProcessIdentity: (pid: number) =>
      [777777, 777778].includes(pid) ? { ok: true, token: 'fixture-process' } : actual.captureProcessIdentity(pid),
    inspectProcessIdentity: (record: Parameters<typeof actual.inspectProcessIdentity>[0]) =>
      record && typeof record.pid === 'number' && [777777, 777778].includes(record.pid)
        ? (record.pid === 777778 && !fixture.proxyStopped) || (record.pid === 777777 && !fixture.daemonStopped)
          ? 'unknown'
          : record.pid === 777777
            ? 'same'
            : 'gone'
        : actual.inspectProcessIdentity(record),
    waitForProcessExit: async (record: { pid: number }) =>
      record.pid === 777778 ? fixture.proxyStopped : fixture.daemonStopped,
  };
});

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    fixture.helperSession = options.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION!;
    const policy = JSON.parse(readFileSync(options.env.AGENT_DEVICE_DAEMON_POLICY!, 'utf8'));
    const canonical = JSON.stringify({
      devices: policy.devices.allow.map((device: { serial: string }) => device.serial),
      commands: { mode: 'allow', names: policy.commands.allow.toSorted() },
      capabilities: policy.capabilities.deny,
    });
    const file = options.env.AGENT_DEVICE_DAEMON_POLICY!.replace('policy.json', 'daemon.json');
    writeFileSync(
      file,
      JSON.stringify({
        pid: 777777,
        httpPort: 4311,
        token: 'daemon-private',
        policyDigest: fixture.policy ? createHash('sha256').update(canonical).digest('hex') : 'different',
      }),
    );
    const child = Object.assign(new EventEmitter(), {
      pid: 777778,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => child.stdout.write('Proxy listening at http://127.0.0.1:4310\n'));
    return child;
  },
  execFile: (command: string, ...args: unknown[]) => {
    if (!(args[0] as string[]).includes('--version')) fixture.events.push(`${command}:${JSON.stringify(args[0])}`);
    const argv = args[0] as string[];
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    if (argv.includes('emu') && fixture.adbError) {
      callback(fixture.adbError, '', fixture.adbError.message);
      return;
    }
    if (argv.includes('shell') && fixture.shellMissing) {
      fixture.adbError = new Error('error: device not found');
      callback(fixture.adbError, '', fixture.adbError.message);
      return;
    }
    callback(
      null,
      argv.includes('--version')
        ? fixture.version
        : argv.includes('emu')
          ? `${fixture.avdName}\nOK\n`
          : argv.includes('pidof') && fixture.helperBusy
            ? '4444'
            : '',
      '',
    );
  },
}));

vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  request: (
    options: { path: string; headers: Record<string, string> },
    answer: (response: IncomingMessage) => void,
  ) => {
    const request = Object.assign(new EventEmitter(), {
      end: (body?: Buffer) => {
        fixture.calls.push({ path: options.path, body: body?.toString() ?? '', headers: options.headers });
        const data =
          options.path === '/health'
            ? { upstream: { leaseBackends: fixture.backend ? ['android-instance'] : [] } }
            : { forwarded: true };
        queueMicrotask(() =>
          answer(
            Object.assign(Readable.from([JSON.stringify(data)]), { statusCode: 200, headers: {} }) as IncomingMessage,
          ),
        );
      },
      destroy: () => {},
    });
    return request;
  },
}));

const SESSION = '11111111-1111-4111-8111-111111111111';
const SERIAL = 'emulator-5554';
const AVD = `stim-hosted-${SESSION}`;
let home: string;
let driver: AgentDeviceDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-android-agent-'));
  process.env.STIM_HOME = home;
  const bin = join(home, 'agent-device.mjs');
  writeFileSync(bin, '');
  fixture.version = '0.21.22';
  fixture.policy = true;
  fixture.backend = true;
  fixture.proxyStopped = true;
  fixture.daemonStopped = true;
  fixture.helperBusy = false;
  fixture.avdName = AVD;
  fixture.adbError = null;
  fixture.shellMissing = false;
  fixture.calls = [];
  fixture.events = [];
  driver = new AgentDeviceDriver({
    env: { STIM_AGENT_DEVICE_BIN: bin },
    stateDir: join(home, 'agent'),
    claimRoot: join(home, 'claims'),
    device: { session: SESSION, serial: SERIAL, avdName: AVD },
  });
});

afterEach(async () => {
  fixture.adbError = null;
  fixture.shellMissing = false;
  fixture.avdName = AVD;
  await driver.stop();
  vi.restoreAllMocks();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function rpc(params: object, method = 'agent_device.command', path = '/rpc') {
  return rpcBody({ id: 4, method, params }, path);
}

async function rpcBody(body: object, path = '/rpc') {
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url: `/device-host/agent/${SESSION}${path}`,
    method: 'POST',
    headers: { authorization: 'Bearer client-private' },
  });
  const response = Object.assign(new PassThrough(), {
    statusCode: 0,
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
  });
  let text = '';
  response.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  const done = new Promise<void>((resolve) => response.once('finish', resolve));
  driver.forward(SESSION, request as IncomingMessage, response as unknown as ServerResponse);
  await done;
  return { status: response.statusCode, text };
}

async function start() {
  await driver.start();
  return driver.issue({ client: 'c', session: SESSION, serial: SERIAL, avdName: AVD, bundleId: 'dev.app' });
}

test('pins the serial policy and verifies its digest before granting Android control', async () => {
  const grant = await start();
  expect(fixture.helperSession).toBe('0');
  expect(parseHostedAgentGrant(grant)).toEqual(grant);
  expect(grant).toMatchObject({ lease: { backend: 'android-instance', deviceKey: `android:mobile:${SERIAL}` } });
  const policy = JSON.parse(readFileSync(join(home, 'agent', 'policy.json'), 'utf8'));
  expect(policy.devices).toEqual({ allow: [{ serial: SERIAL }] });
  expect(policy.capabilities).toEqual({ deny: ['device-shutdown'] });
  expect(statSync(join(home, 'agent', 'policy.json')).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
  expect(fixture.calls.map((call) => call.path)).toEqual(['/health']);
  await expect(
    driver.issue({ client: 'c', session: SESSION, serial: 'emulator-5556', avdName: AVD, bundleId: 'dev.app' }),
  ).rejects.toThrow('another hosted emulator');
});

test.each(['policy', 'backend'] as const)('grants nothing without the required %s', async (missing) => {
  fixture[missing] = false;
  await expect(driver.start()).rejects.toThrow('requires agent-device 0.21.22');
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(0);
});

test('a kept live daemon claim blocks restart and stop, then a gone child can be reconciled', async () => {
  const root = join(home, 'claims');
  const child = keepAgentClaim(root);
  const claim = readClaimSet(root).live[0]!;
  try {
    await expect(driver.start()).rejects.toThrow('held by another process');
    await expect(driver.stop()).rejects.toThrow(claim.path);
    await expect(driver.stop()).rejects.toThrow(claimRemoveCommand(claim.path));
    expect(readClaimSet(root).live[0]!.child).toEqual(child);
    expect(fixture.events).toEqual([]);
  } finally {
    await killKeptChild(child);
  }
  await driver.stop();
  expect(readClaimSet(root).live).toEqual([]);
});

test('stops the daemon and only the pinned Android helpers before releasing the claim', async () => {
  await start();
  await driver.stop();
  const adb = fixture.events.filter((event) => event.includes('"shell"'));
  expect(adb).toHaveLength(4);
  expect(adb.every((event) => event.includes('["-s","emulator-5554","shell",'))).toBe(true);
  expect(adb[0]).toContain(
    '["-s","emulator-5554","shell","am","force-stop","com.callstack.agentdevice.snapshothelper"]',
  );
  expect(adb[2]).toContain('"com.callstack.agentdevice.imehelper"');
  expect(fixture.events.every((event) => !event.includes('/bin/ps'))).toBe(true);
  expect(readClaimSet(join(home, 'claims')).live).toEqual([]);
});

test.each([
  { command: 'devices', positionals: [], flags: {} },
  { command: 'open', positionals: ['dev.app'], flags: { serial: SERIAL } },
  { command: 'snapshot', positionals: [], flags: { snapshotInteractiveOnly: true } },
  { command: 'click', positionals: ['e1'], flags: {} },
  {
    command: 'screenshot',
    positionals: [],
    flags: { out: '/tmp/agent-device-screenshot-123-ab12.png' },
  },
  {
    command: 'screenshot',
    positionals: ['/tmp/agent-device-screenshot-123-ab12.png'],
    flags: {},
  },
  { command: 'close', positionals: [], flags: {} },
])('accepts the real client envelope for $command without forwarding ambient paths or routing', async (command) => {
  await start();
  const captured = {
    jsonrpc: '2.0',
    id: 'b6dc81fbd6708d93',
    method: 'agent_device.command',
    params: {
      session: 'default',
      command: 'devices',
      positionals: [],
      flags: {
        stateDir: '/var/folders/48/xx/T/tmp.8d2DWWsIz6',
        daemonBaseUrl: 'http://127.0.0.1:4399/x',
        tenant: 'stim.<session>',
        runId: '<session>',
        leaseBackend: 'android-instance',
        sessionIsolation: 'tenant',
        platform: 'android',
        verbose: false,
      },
      meta: {
        requestId: 'b6dc81fbd6708d93',
        cwd: '/client/worktree',
        sessionExplicit: false,
        debug: false,
        lockPlatform: 'ios',
        tenantId: 'stim.<session>',
        runId: '<session>',
        leaseBackend: 'android-instance',
        sessionIsolation: 'tenant',
      },
      token: '<token>',
    },
  };
  const screenshot = command.command === 'screenshot';
  const scope =
    command.command === 'devices'
      ? {}
      : { leaseId: 'client-lease', leaseProvider: 'proxy', clientId: 'client', deviceKey: `android:mobile:${SERIAL}` };
  const params = {
    ...captured.params,
    ...command,
    flags: { ...captured.params.flags, ...command.flags, ...scope },
    meta: {
      ...captured.params.meta,
      ...scope,
      ...(screenshot ? { clientArtifactPaths: { path: '/client/shot.png' } } : {}),
    },
  };
  expect((await rpcBody({ ...captured, params })).status).toBe(200);
  const forwarded = JSON.parse(fixture.calls.at(-1)!.body);
  expect(forwarded.params).toEqual({
    command: command.command,
    session: 'default',
    positionals: command.positionals,
    flags: {
      ...command.flags,
      ...(scope.leaseId ? { leaseId: scope.leaseId } : {}),
      verbose: false,
      platform: 'android',
      serial: SERIAL,
    },
    meta: {
      requestId: 'b6dc81fbd6708d93',
      sessionExplicit: false,
      debug: false,
      ...(scope.leaseId ? { leaseId: scope.leaseId } : {}),
      ...(screenshot ? { clientArtifactPaths: { path: '/client/shot.png' } } : {}),
      tenantId: `stim.${SESSION}`,
      runId: SESSION,
      clientId: 'agent',
      deviceKey: `android:mobile:${SERIAL}`,
      leaseProvider: 'proxy',
      leaseBackend: 'android-instance',
      sessionIsolation: 'tenant',
    },
  });
  expect(fixture.calls.at(-1)!.body).not.toContain(captured.params.flags.stateDir);
  expect(fixture.calls.at(-1)!.body).not.toContain(captured.params.meta.cwd);
});

test.each(['flags', 'input'])('strips client configuration and connection scope from %s', async (field) => {
  await start();
  const ambient = {
    stateDir: '/client/state',
    cwd: '/client/worktree',
    config: '/client/config.json',
    remoteConfig: '/client/remote.json',
    daemonBaseUrl: 'http://client/rpc',
    daemonAuthToken: 'client-token',
    daemonTransport: 'http',
    daemonServerMode: 'dual',
    tenant: 'other',
    tenantId: 'other',
    runId: 'other',
    clientId: 'other',
    deviceKey: 'other',
    leaseBackend: 'macos-app',
    sessionIsolation: 'none',
    leaseProvider: 'limrun',
    provider: 'limrun',
  };
  expect((await rpc({ command: 'snapshot', [field]: ambient, meta: ambient })).status).toBe(200);
  const forwarded = JSON.parse(fixture.calls.at(-1)!.body).params;
  expect(forwarded[field]).toEqual({ platform: 'android', serial: SERIAL });
  expect(forwarded.meta).toEqual({
    tenantId: `stim.${SESSION}`,
    runId: SESSION,
    clientId: 'agent',
    deviceKey: `android:mobile:${SERIAL}`,
    leaseProvider: 'proxy',
    leaseBackend: 'android-instance',
    sessionIsolation: 'tenant',
  });
  expect(fixture.calls.at(-1)!.body).not.toContain('/client/');
  expect(fixture.calls.at(-1)!.body).not.toContain('client-token');
});

test.each(['heartbeat', 'release'])('accepts the real client lease %s scope and pins its owner', async (command) => {
  await start();
  expect(
    (
      await rpc(
        {
          session: 'default',
          token: '<token>',
          tenantId: 'stim.<session>',
          runId: '<session>',
          leaseProvider: 'proxy',
          clientId: 'client',
          deviceKey: `android:mobile:${SERIAL}`,
          leaseId: 'client-lease',
          ...(command === 'heartbeat' ? { ttlMs: 300000 } : {}),
        },
        `agent_device.lease.${command}`,
      )
    ).status,
  ).toBe(200);
  expect(JSON.parse(fixture.calls.at(-1)!.body).params).toEqual({
    session: 'default',
    tenantId: `stim.${SESSION}`,
    runId: SESSION,
    leaseProvider: 'proxy',
    clientId: 'agent',
    deviceKey: `android:mobile:${SERIAL}`,
    backend: 'android-instance',
    leaseId: 'client-lease',
    ...(command === 'heartbeat' ? { ttlMs: 300000 } : {}),
  });
});

test.each([
  { command: 'install' },
  { command: 'reinstall' },
  { command: 'uninstall' },
  { command: 'shutdown' },
  { command: 'boot' },
  { command: 'record' },
  { command: 'logs' },
  { command: 'close', flags: { shutdown: true } },
  { command: 'snapshot', serial: 'emulator-5556' },
  { command: 'snapshot', flags: { serial: 'emulator-5556' } },
  { command: 'snapshot', input: { serial: 'emulator-5556' } },
  { command: 'snapshot', flags: { serial: null } },
  { command: 'batch', flags: { batchSteps: [{ command: 'snapshot', serial: 'emulator-5556' }] } },
  { command: 'batch', flags: { batchSteps: [{ command: 'snapshot', input: { serial: 'emulator-5556' } }] } },
  { command: 'batch', input: { batchSteps: [{ command: 'batch', flags: { batchSteps: [{ command: 'install' }] } }] } },
  { command: 'open', positionals: ['/host/App.apk'] },
  { command: 'screenshot', flags: { out: '/host/shot.png' } },
])('refuses unsafe requests before forwarding: %j', async (params) => {
  await start();
  fixture.calls = [];
  expect((await rpc(params)).status).toBe(400);
  expect(fixture.calls).toEqual([]);
});

test.each(['allocate', 'heartbeat', 'release'])('refuses foreign serials in lease %s requests', async (method) => {
  await start();
  fixture.calls = [];
  for (const params of [
    { serial: 'emulator-5556' },
    { flags: { serial: 'emulator-5556' } },
    { deviceKey: 'android:mobile:emulator-5556' },
  ])
    expect((await rpc(params, `agent_device.lease.${method}`)).status).toBe(400);
  expect(fixture.calls).toEqual([]);
});

test('pins allocation and nested batch steps to the host owner without ambient fields', async () => {
  await start();
  expect(
    (await rpc({ serial: SERIAL, deviceKey: 'foreign', tenantId: 'other' }, 'agent_device.lease.allocate')).status,
  ).toBe(200);
  expect(JSON.parse(fixture.calls.at(-1)!.body).params).toEqual({
    tenantId: `stim.${SESSION}`,
    runId: SESSION,
    clientId: 'agent',
    deviceKey: `android:mobile:${SERIAL}`,
    leaseProvider: 'proxy',
    backend: 'android-instance',
  });
  expect(
    (
      await rpc({
        command: 'batch',
        flags: {
          batchSteps: [
            {
              command: 'batch',
              input: {
                batchSteps: [
                  {
                    command: 'open',
                    positionals: ['dev.app'],
                    flags: { serial: SERIAL, udid: 'foreign', stateDir: '/client' },
                  },
                ],
              },
            },
          ],
        },
      })
    ).status,
  ).toBe(200);
  const step = JSON.parse(fixture.calls.at(-1)!.body).params.flags.batchSteps[0].input.batchSteps[0];
  expect(step).toEqual({ command: 'open', positionals: ['dev.app'], flags: { platform: 'android', serial: SERIAL } });
  expect(fixture.calls.at(-1)!.body).not.toContain('/client');
});

test('older Android policy parsers get no daemon or claim', async () => {
  fixture.version = '0.21.20';
  await expect(driver.start()).rejects.toThrow('0.21.22');
  expect(fixture.events).toEqual([]);
  expect(readClaimSet(join(home, 'claims')).live).toEqual([]);
});

test.each(['proxy', 'daemon', 'helper'])(
  'an unresolved %s retains the daemon claim and refuses another start',
  async (child) => {
    await start();
    fixture.proxyStopped = child !== 'proxy';
    fixture.daemonStopped = child !== 'daemon';
    fixture.helperBusy = child === 'helper';
    try {
      await expect(driver.stop()).rejects.toThrow(/claim.*kept/);
      expect(readClaimSet(join(home, 'claims')).live).toHaveLength(1);
      await expect(driver.start()).rejects.toThrow('previous agent-device daemon is unresolved');
    } finally {
      fixture.proxyStopped = true;
      fixture.daemonStopped = true;
      fixture.helperBusy = false;
      await driver.stop();
    }
    expect(readClaimSet(join(home, 'claims')).live).toEqual([]);
  },
);

test.each(['absent', 'console-refused', 'replaced', 'lost-during-cleanup'])(
  'stop releases the daemon claim when the emulator is %s without touching a replacement',
  async (status) => {
    await start();
    fixture.events = [];
    if (status === 'absent') fixture.adbError = new Error('error: device not found');
    if (status === 'console-refused')
      fixture.adbError = new Error('error: could not connect to TCP port 5556: Connection refused');
    if (status === 'replaced') fixture.avdName = 'another-avd';
    if (status === 'lost-during-cleanup') fixture.shellMissing = true;
    await driver.stop();
    expect(readClaimSet(join(home, 'claims')).live).toEqual([]);
    const shell = fixture.events.filter((event) => event.includes('"shell"'));
    expect(shell).toHaveLength(status === 'lost-during-cleanup' ? 1 : 0);
  },
);

test.each(['absent', 'replaced'])(
  'refuses forwarding and drops the grant through strict daemon stop when the emulator is %s',
  async (status) => {
    const agents = new HostedAgentHost({
      resolve: () => null,
      resolveDevice: () => driver,
      nodeOf: () => 'node',
      restartDelayMs: 0,
      maxRestarts: 1,
    });
    try {
      const access = await agents.appRunning({
        client: 'c',
        session: SESSION,
        serial: SERIAL,
        avdName: AVD,
        bundleId: 'dev.app',
      });
      expect(access.grant.driver).toBe('agent-device');
      fixture.calls = [];
      const now = Date.now();
      const date = vi.spyOn(Date, 'now').mockReturnValue(now + 3000);
      if (status === 'absent') fixture.adbError = new Error('error: device not found');
      else fixture.avdName = 'another-avd';
      const answer = await rpc({ command: 'snapshot' });
      date.mockRestore();
      expect(answer.status).toBe(503);
      expect(answer.text).toContain('hosted emulator');
      expect(fixture.calls).toEqual([]);
      await vi.waitFor(() => expect(agents.access(SESSION)?.notice).toContain('identity could not be verified'));
      await vi.waitFor(() => expect(readClaimSet(join(home, 'claims')).live).toEqual([]));
      expect(agents.access(SESSION)?.grant).toEqual({ driver: 'none' });
      expect(fixture.events.some((event) => event.includes('"daemon","stop"'))).toBe(true);
      expect(fixture.events.some((event) => event.includes('"force-stop"'))).toBe(false);
    } finally {
      await agents.close();
    }
  },
);

test('watch detects serial reuse even while request verification is cached', async () => {
  driver = new AgentDeviceDriver({
    env: { STIM_AGENT_DEVICE_BIN: join(home, 'agent-device.mjs') },
    stateDir: join(home, 'agent'),
    claimRoot: join(home, 'claims'),
    device: { session: SESSION, serial: SERIAL, avdName: AVD },
    watchMs: 20,
  });
  const agents = new HostedAgentHost({
    resolve: () => null,
    resolveDevice: () => driver,
    nodeOf: () => 'node',
    maxRestarts: 0,
  });
  try {
    await agents.appRunning({ client: 'c', session: SESSION, serial: SERIAL, avdName: AVD, bundleId: 'dev.app' });
    fixture.avdName = 'another-avd';
    await vi.waitFor(() => expect(agents.access(SESSION)?.grant.driver).toBe('none'));
    await vi.waitFor(() => expect(readClaimSet(join(home, 'claims')).live).toEqual([]));
    expect((await rpc({ command: 'snapshot' })).status).toBe(503);
  } finally {
    await agents.close();
  }
});

test('an adb timeout refuses a request without reporting daemon loss, then healthy requests recover', async () => {
  await start();
  const exit = vi.fn<() => void>();
  driver.onExit(exit);
  fixture.calls = [];
  const date = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);
  fixture.adbError = Object.assign(new Error('adb timed out'), { killed: true });
  expect((await rpc({ command: 'snapshot' })).status).toBe(503);
  expect(fixture.calls).toEqual([]);
  expect(exit).not.toHaveBeenCalled();
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(1);
  fixture.adbError = null;
  expect((await rpc({ command: 'snapshot' })).status).toBe(200);
  const probes = fixture.events.filter((event) => event.includes('"emu"')).length;
  expect((await rpc({ command: 'snapshot' })).status).toBe(200);
  expect(fixture.events.filter((event) => event.includes('"emu"'))).toHaveLength(probes);
  date.mockRestore();
});

test('Android nested selectors refuse another emulator by its platform noun', async () => {
  await start();
  const answer = await rpc({
    command: 'batch',
    flags: { batchSteps: [{ command: 'snapshot', input: { serial: 'emulator-5556' } }] },
  });
  expect(answer.status).toBe(400);
  expect(JSON.parse(answer.text).error.message).toBe(
    'Another emulator is refused; this connection targets one hosted emulator.',
  );
});
