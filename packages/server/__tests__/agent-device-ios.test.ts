import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { keepAgentClaim, killKeptChild } from './fixtures/kept-agent-claim.ts';
import { parseHostedAgentGrant } from '@stim-cli/core/state';
import type { ProcessIdentityStatus } from '@stim-cli/core/process-identity';
import { AgentDeviceDriver } from '@stim-cli/agent-driver-agent-device';

const fixture = vi.hoisted(() => ({
  policy: true,
  backend: true,
  proxyStopped: true,
  ps: [] as string[],
  psError: false,
  uncaptured: new Set<number>(),
  waits: [] as [number, number][],
  identities: {} as Record<number, ProcessIdentityStatus>,
  stubborn: new Set<number>(),
  events: [] as string[],
  calls: [] as { path: string; body: string; headers: Record<string, string> }[],
  recordOk: true,
}));

vi.mock('@stim-cli/core/process-identity', async (original) => {
  const actual = await original<typeof import('@stim-cli/core/process-identity')>();
  return {
    ...actual,
    captureProcessIdentity: (pid: number) =>
      fixture.uncaptured.has(pid)
        ? { ok: false, reason: 'unavailable' }
        : pid in fixture.identities
          ? { ok: true, token: `runner-${pid}` }
          : [777777, 777778].includes(pid)
            ? { ok: true, token: 'fixture-process' }
            : actual.captureProcessIdentity(pid),
    inspectProcessIdentity: (record: Parameters<typeof actual.inspectProcessIdentity>[0]) =>
      record && typeof record.pid === 'number' && record.pid in fixture.identities
        ? fixture.identities[record.pid]
        : record?.pid === 777778 && !fixture.proxyStopped
          ? 'unknown'
          : record && typeof record.pid === 'number' && [777777, 777778].includes(record.pid)
            ? 'gone'
            : actual.inspectProcessIdentity(record),
    waitForProcessExit: (record: Parameters<typeof actual.waitForProcessExit>[0], timeoutMs: number) => {
      if (typeof record.pid === 'number' && record.pid in fixture.identities) {
        fixture.waits.push([record.pid, timeoutMs]);
        return Promise.resolve(['gone', 'different'].includes(fixture.identities[record.pid]!));
      }
      return record.pid === 777777 || record.pid === 777778
        ? Promise.resolve(fixture.proxyStopped)
        : actual.waitForProcessExit(record, timeoutMs);
    },
  };
});

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const policy = JSON.parse(readFileSync(options.env.AGENT_DEVICE_DAEMON_POLICY!, 'utf8'));
    const canonical = JSON.stringify({
      devices: policy.devices.allow.map((device: { udid: string }) => device.udid),
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
    fixture.events.push(command === '/bin/ps' ? 'ps' : 'daemon-stop');
    if (command === '/bin/ps' && fixture.psError) {
      (args.at(-1) as (error: Error) => void)(new Error('process listing unavailable'));
      return;
    }
    const ps = command === '/bin/ps' && fixture.ps.length > 1 ? fixture.ps.shift() : fixture.ps[0];
    (args.at(-1) as (error: null, stdout: string) => void)(null, command === '/bin/ps' ? (ps ?? '') : '');
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
        const sent = options.path === '/rpc' ? JSON.parse(body?.toString() ?? '{}') : {};
        const data =
          options.path === '/health'
            ? { upstream: { leaseBackends: fixture.backend ? ['ios-instance'] : [] } }
            : sent.params?.command === 'record'
              ? {
                  jsonrpc: '2.0',
                  id: sent.id,
                  result: { ok: fixture.recordOk, data: { recording: sent.params.positionals[0] } },
                }
              : { forwarded: true };
        queueMicrotask(() =>
          answer(
            Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]), {
              statusCode: 200,
              headers: {},
            }) as IncomingMessage,
          ),
        );
      },
      destroy: () => {},
    });
    return request;
  },
}));

const SESSION = '11111111-1111-4111-8111-111111111111';
const UDID = '22222222-abcd-4222-8222-222222222222';
let home: string;
let driver: AgentDeviceDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-ios-agent-'));
  process.env.STIM_HOME = home;
  const bin = join(home, 'agent-device.mjs');
  writeFileSync(bin, '');
  fixture.policy = true;
  fixture.backend = true;
  fixture.proxyStopped = true;
  fixture.calls = [];
  fixture.recordOk = true;
  fixture.ps = [];
  fixture.psError = false;
  fixture.uncaptured = new Set();
  fixture.waits = [];
  fixture.identities = {};
  fixture.stubborn = new Set();
  fixture.events = [];
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (Math.abs(pid) in fixture.identities) {
      fixture.events.push(`signal:${pid}:${signal}`);
      if (!fixture.stubborn.has(Math.abs(pid)) || signal === 'SIGKILL') fixture.identities[Math.abs(pid)] = 'gone';
      return true;
    }
    return kill(pid, signal);
  });
  driver = new AgentDeviceDriver({
    env: { STIM_AGENT_DEVICE_BIN: bin },
    stateDir: join(home, 'agent'),
    claimRoot: join(home, 'claims'),
    device: { session: SESSION, udid: UDID },
  });
});

afterEach(async () => {
  await driver.stop();
  vi.restoreAllMocks();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function rpc(params: object, method = 'agent_device.command', path = '/rpc') {
  return rpcBody({ id: 4, method, params }, path);
}

async function rpcBody(body: object | string, path = '/rpc') {
  const request = Object.assign(Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), {
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
  return driver.issue({ client: 'c', session: SESSION, udid: UDID, bundleId: 'dev.app' });
}

test('starts with exactly one simulator policy, requires its digest and allocates no macOS admin lease', async () => {
  const grant = await start();
  expect(parseHostedAgentGrant(grant)).toEqual(grant);
  expect(grant).toMatchObject({ lease: { deviceKey: `ios:mobile:${UDID}`, backend: 'ios-instance' } });
  const policy = JSON.parse(readFileSync(join(home, 'agent', 'policy.json'), 'utf8'));
  expect(policy.devices).toEqual({ allow: [{ udid: UDID }] });
  expect(policy.capabilities).toEqual({ deny: ['device-shutdown'] });
  expect(policy).not.toHaveProperty('leases');
  expect(statSync(join(home, 'agent', 'policy.json')).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
  expect(fixture.calls.map((call) => call.path)).toEqual(['/health']);
  await expect(driver.issue({ client: 'c', session: UDID, udid: UDID, bundleId: 'dev.app' })).rejects.toThrow(
    'another hosted simulator',
  );
  await driver.stop();
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(0);
});

test(
  'a fresh iOS driver refuses a kept live-child claim before stopping the daemon or runners',
  { skip: process.platform === 'win32' },
  async () => {
    const root = join(home, 'claims');
    const child = keepAgentClaim(root);
    const claim = readClaimSet(root).live[0]!;
    try {
      await expect(driver.stop()).rejects.toThrow(claim.path);
      await expect(driver.stop()).rejects.toThrow(claimRemoveCommand(claim.path));
      expect(readClaimSet(root).live[0]!.child).toEqual(child);
      expect(fixture.events).toEqual([]);
    } finally {
      await killKeptChild(child);
    }
  },
);

test(
  'a fresh iOS driver recovers a kept gone-child claim and sweeps runners before releasing it',
  { skip: process.platform === 'win32' },
  async () => {
    const root = join(home, 'claims');
    const child = keepAgentClaim(root);
    await killKeptChild(child);
    expect(readClaimSet(root).dead).toHaveLength(1);
    fixture.ps = [runner(888880)];
    fixture.identities = { 888880: 'same' };
    await driver.stop();
    expect(fixture.events).toEqual(['ps', 'ps', 'signal:-888880:SIGTERM']);
    expect(readClaimSet(root).live).toEqual([]);
    expect(readClaimSet(root).dead).toEqual([]);
  },
);

test.each(['policy', 'backend'] as const)('grants nothing when the daemon lacks the required %s', async (missing) => {
  fixture[missing] = false;
  await expect(driver.start()).rejects.toThrow(/requires agent-device/);
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(0);
});

test('keeps the daemon claim until both its proxy and daemon are proven stopped', async () => {
  await start();
  fixture.proxyStopped = false;
  await expect(driver.stop()).rejects.toThrow('proxy is unresolved');
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(1);
  fixture.proxyStopped = true;
  await driver.stop();
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(0);
});

function runner(pid: number, udid = UDID, group = pid): string {
  return `${pid} ${group} /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test-without-building -only-testing AgentDeviceRunnerUITests/RunnerTests/testCommand -xctestrun /host/AgentDeviceRunner.env.session-${udid}-owner-1.xctestrun -destination platform=iOS Simulator,id=${udid}`;
}

test.each(['Xcode.app', 'Xcode 27.app'])(
  'stops only exact-UDID runners under %s, after the daemon clean path',
  async (app) => {
    await start();
    fixture.ps = [
      [
        runner(888880, UDID.toUpperCase()),
        runner(888881, SESSION),
        runner(888882, `${UDID}0`),
        runner(888883).replace('-destination ', '--destination '),
        runner(888884).replace('AgentDeviceRunnerUITests', 'OtherUITests'),
        runner(888885, UDID, 900000),
        runner(888886, `0${UDID}`),
        runner(888887).replace('/usr/bin/xcodebuild', '/usr/bin/not-xcodebuild'),
        runner(888888).replace('/usr/bin/xcodebuild', '/usr/bin/echo xcodebuild'),
      ]
        .join('\n')
        .replaceAll('Xcode.app', app),
    ];
    fixture.identities = Object.fromEntries(
      [888880, 888881, 888882, 888883, 888884, 888885, 888886, 888887, 888888].map((pid) => [pid, 'same']),
    );
    await driver.stop();
    expect(fixture.events).toEqual(['daemon-stop', 'ps', 'ps', 'signal:-888880:SIGTERM', 'signal:888885:SIGTERM']);
    expect(fixture.identities[888881]).toBe('same');
    expect(readClaimSet(join(home, 'claims')).live).toHaveLength(0);
  },
);

test('escalates a surviving runner group to SIGKILL after waiting for SIGTERM', async () => {
  await start();
  fixture.ps = [runner(888880)];
  fixture.identities = { 888880: 'same' };
  fixture.stubborn.add(888880);
  await driver.stop();
  expect(fixture.events).toEqual(['daemon-stop', 'ps', 'ps', 'signal:-888880:SIGTERM', 'signal:-888880:SIGKILL']);
  expect(fixture.waits).toEqual([
    [888880, 3000],
    [888880, 2000],
  ]);
});

test('never signals a runner whose captured identity changed or whose destination changed before signalling', async () => {
  await start();
  fixture.ps = [runner(888880) + '\n' + runner(888881), runner(888880) + '\n' + runner(888881, SESSION)];
  fixture.identities = { 888880: 'different', 888881: 'same' };
  await driver.stop();
  expect(fixture.events).toEqual(['daemon-stop', 'ps', 'ps']);
});

test('keeps an unresolved runner claim, continues stopping other runners and retries cleanup', async () => {
  await start();
  fixture.ps = [runner(888880) + '\n' + runner(888881)];
  fixture.identities = { 888880: 'unknown', 888881: 'same' };
  await expect(driver.stop()).rejects.toThrow('iOS runners did not stop (888880)');
  expect(fixture.events).toEqual(['daemon-stop', 'ps', 'ps', 'signal:-888881:SIGTERM']);
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(1);
  fixture.identities[888880] = 'same';
  await driver.stop();
  expect(fixture.identities[888880]).toBe('gone');
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(0);
});

test('keeps the daemon claim when the process inventory cannot be read and retries cleanup', async () => {
  await start();
  fixture.psError = true;
  await expect(driver.stop()).rejects.toThrow('process listing unavailable');
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(1);
  fixture.psError = false;
  await driver.stop();
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(0);
});

test('never signals a runner whose identity cannot be captured', async () => {
  await start();
  fixture.ps = [runner(888880)];
  fixture.identities = { 888880: 'same' };
  fixture.uncaptured.add(888880);
  await expect(driver.stop()).rejects.toThrow('iOS runners did not stop (888880)');
  expect(fixture.events).toEqual(['daemon-stop', 'ps', 'ps']);
  fixture.uncaptured.clear();
  await driver.stop();
});

test('cleans session runners when daemon startup fails', async () => {
  fixture.backend = false;
  fixture.ps = [runner(888880)];
  fixture.identities = { 888880: 'same' };
  await expect(driver.start()).rejects.toThrow('requires agent-device');
  expect(fixture.identities[888880]).toBe('gone');
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(0);
});

test.each([
  { command: 'devices', positionals: [], flags: {} },
  { command: 'open', positionals: ['dev.app'], flags: { udid: UDID } },
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
        leaseBackend: 'ios-instance',
        sessionIsolation: 'tenant',
        platform: 'ios',
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
        leaseBackend: 'ios-instance',
        sessionIsolation: 'tenant',
      },
      token: '<token>',
    },
  };
  const screenshot = command.command === 'screenshot';
  const scope =
    command.command === 'devices'
      ? {}
      : { leaseId: 'client-lease', leaseProvider: 'proxy', clientId: 'client', deviceKey: `ios:mobile:${UDID}` };
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
      platform: 'ios',
      udid: UDID,
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
      deviceKey: `ios:mobile:${UDID}`,
      leaseProvider: 'proxy',
      leaseBackend: 'ios-instance',
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
  expect(forwarded[field]).toEqual({ platform: 'ios', udid: UDID });
  expect(forwarded.meta).toEqual({
    tenantId: `stim.${SESSION}`,
    runId: SESSION,
    clientId: 'agent',
    deviceKey: `ios:mobile:${UDID}`,
    leaseProvider: 'proxy',
    leaseBackend: 'ios-instance',
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
          deviceKey: `ios:mobile:${UDID}`,
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
    deviceKey: `ios:mobile:${UDID}`,
    backend: 'ios-instance',
    leaseId: 'client-lease',
    ...(command === 'heartbeat' ? { ttlMs: 300000 } : {}),
  });
});

test('pins automatic iOS lease allocation and every batch step to the simulator and tenant', async () => {
  await start();
  const allocated = await rpc(
    {
      tenantId: 'foreign',
      runId: 'other',
      backend: 'macos-app',
      deviceKey: 'other',
      provider: 'limrun',
      ttlMs: 300000,
    },
    'agent_device.lease.allocate',
  );
  expect(allocated.status).toBe(200);
  expect(JSON.parse(fixture.calls.at(-1)!.body).params).toEqual({
    tenantId: `stim.${SESSION}`,
    runId: SESSION,
    clientId: 'agent',
    deviceKey: `ios:mobile:${UDID}`,
    leaseProvider: 'proxy',
    backend: 'ios-instance',
    ttlMs: 300000,
  });
  await rpc({
    command: 'batch',
    runtime: { launchUrl: 'file:///etc' },
    internal: { publicNetworkOnly: false },
    meta: { requestId: 'r', cwd: '/host', tenantId: 'other', leaseId: 'client-lease' },
    flags: {
      platform: 'macos',
      batchSteps: [
        {
          command: 'open',
          positionals: ['dev.app'],
          runtime: { bundleUrl: '/host' },
          flags: { udid: UDID, target: 'mobile', serial: 'foreign', stateDir: '/client/state' },
          input: { platform: 'macos', device: 'other', config: '/client/config', cwd: '/client/worktree' },
          meta: { cwd: '/client/worktree', tenantId: 'other' },
        },
        { command: 'click', positionals: ['e1'] },
      ],
    },
  });
  const forwarded = JSON.parse(fixture.calls.at(-1)!.body).params;
  expect(forwarded.runtime).toBeUndefined();
  expect(forwarded.internal).toBeUndefined();
  expect(forwarded.meta).toEqual({
    requestId: 'r',
    leaseId: 'client-lease',
    tenantId: `stim.${SESSION}`,
    runId: SESSION,
    clientId: 'agent',
    deviceKey: `ios:mobile:${UDID}`,
    leaseProvider: 'proxy',
    leaseBackend: 'ios-instance',
    sessionIsolation: 'tenant',
  });
  expect(forwarded.flags).toMatchObject({
    platform: 'ios',
    udid: UDID,
    batchSteps: [{ flags: { platform: 'ios', udid: UDID } }, { flags: { platform: 'ios', udid: UDID } }],
  });
  expect(forwarded.flags.batchSteps[0]).not.toHaveProperty('runtime');
  expect(forwarded.flags.batchSteps[0].flags).toEqual({ platform: 'ios', udid: UDID });
  expect(forwarded.flags.batchSteps[0].input).toEqual({ platform: 'ios', udid: UDID });
  expect(fixture.calls.at(-1)!.headers).toMatchObject({ 'x-agent-device-tenant': `stim.${SESSION}` });
  expect(fixture.calls.at(-1)!.headers.authorization).not.toContain('client-private');
});

test.each([
  { command: 'install' },
  { command: 'reinstall' },
  { command: 'uninstall' },
  { command: 'install-from-source' },
  { command: 'push' },
  { command: 'boot' },
  { command: 'shutdown' },
  { command: 'close', flags: { shutdown: true } },
  { command: 'snapshot', flags: { udid: SESSION } },
  { command: 'batch', flags: { batchSteps: [{ command: 'snapshot', input: { udid: SESSION } }] } },
  { command: 'screenshot', positionals: ['/host/file.png'] },
  { command: 'open', positionals: ['https://host/'] },
  { command: 'open', flags: { launchConsole: '/host/console' } },
  { command: 'open', flags: { launchUrl: 'https://host/' } },
  { command: 'snapshot', flags: { baseline: '/host/baseline.png' } },
  { command: 'open', input: { installSource: { kind: 'path', path: '/host/app' } } },
  { command: 'snapshot', input: { developerDir: '/host' } },
  {
    command: 'record',
    positionals: ['start', '/Users/me/clip.mp4'],
    meta: { clientArtifactPaths: { outPath: '/c/r' } },
  },
  { command: 'record', positionals: ['start', '/tmp/agent-device-recording-1-ab/../../etc/x.mp4'] },
  { command: 'record', positionals: ['start'], meta: {} },
  { command: 'record', positionals: ['stop', '/tmp/agent-device-recording-1-ab.mp4'] },
  { command: 'record', positionals: ['list'] },
  { command: 'batch', flags: { batchSteps: [{ command: 'record', positionals: ['stop'] }] } },
  {
    command: 'batch',
    flags: {
      batchSteps: [
        { command: 'click' },
        { command: 'batch', input: { batchSteps: [{ command: 'screenshot', flags: { out: '/host/file' } }] } },
      ],
    },
  },
])('refuses unsafe requests before any step reaches the daemon: %j', async (params) => {
  await start();
  fixture.calls = [];
  fixture.ps = [];
  fixture.psError = false;
  fixture.uncaptured = new Set();
  fixture.waits = [];
  fixture.identities = {};
  fixture.stubborn = new Set();
  fixture.events = [];
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (Math.abs(pid) in fixture.identities) {
      fixture.events.push(`signal:${pid}:${signal}`);
      if (!fixture.stubborn.has(Math.abs(pid)) || signal === 'SIGKILL') fixture.identities[Math.abs(pid)] = 'gone';
      return true;
    }
    return kill(pid, signal);
  });
  expect((await rpc(params)).status).toBe(400);
  expect(fixture.calls).toEqual([]);
});

test.each(['devices', 'open', 'snapshot', 'orientation'])(
  'forwards %s with client selectors stripped and the hosted simulator forced',
  async (command) => {
    await start();
    const selectors = {
      udid: UDID,
      serial: 'foreign',
      target: 'mobile',
      device: 'other',
      platform: 'android',
      iosSimulatorDeviceSet: '/other',
      androidDeviceAllowlist: ['other'],
    };
    expect((await rpc({ command, flags: selectors, input: selectors })).status).toBe(200);
    const forwarded = JSON.parse(fixture.calls.at(-1)!.body).params;
    expect(forwarded.command).toBe(command);
    expect(forwarded.flags).toEqual({ platform: 'ios', udid: UDID });
    expect(forwarded.input).toEqual({ platform: 'ios', udid: UDID });
  },
);

test('allows screenshot artifacts but refuses uploads and stops forwarding after revoke', async () => {
  await start();
  expect(
    (
      await rpc({
        command: 'screenshot',
        flags: { out: '/tmp/agent-device-screenshot-123-ab12.png' },
        positionals: ['/tmp/agent-device-screenshot-123-ab12.png'],
      })
    ).status,
  ).toBe(200);
  fixture.calls = [];
  fixture.ps = [];
  fixture.psError = false;
  fixture.uncaptured = new Set();
  fixture.waits = [];
  fixture.identities = {};
  fixture.stubborn = new Set();
  fixture.events = [];
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (Math.abs(pid) in fixture.identities) {
      fixture.events.push(`signal:${pid}:${signal}`);
      if (!fixture.stubborn.has(Math.abs(pid)) || signal === 'SIGKILL') fixture.identities[Math.abs(pid)] = 'gone';
      return true;
    }
    return kill(pid, signal);
  });
  expect((await rpc({}, 'agent_device.command', '/upload')).status).toBe(404);
  await driver.revoke(SESSION);
  expect((await rpc({ command: 'snapshot' })).status).toBe(503);
  expect(fixture.calls).toEqual([]);
});

const recordStart = (output?: string) => ({
  command: 'record',
  session: 'default',
  positionals: output === undefined ? ['start'] : ['start', output],
  flags: { platform: 'ios', out: '/client/clip.mov', fps: 30 },
  meta: { requestId: 'r', clientArtifactPaths: { outPath: '/client/clip' } },
});

const forwardedRecord = () => JSON.parse(fixture.calls.at(-1)?.body ?? '{}');

test('writes a recording only in the session state, one at a time, and removes it on stop', async () => {
  await start();
  const remote = await rpc(recordStart('/tmp/agent-device-recording-1793117267701-ab12cd.mov'));
  expect(remote.status).toBe(200);
  const started = forwardedRecord().params;
  const output = started.positionals[1];
  expect(output.startsWith(join(home, 'agent', 'recordings') + '/')).toBe(true);
  expect(output.endsWith('/recording.mov')).toBe(true);
  expect(started.flags).toEqual({ platform: 'ios', udid: UDID, fps: 30 });
  expect(started.meta.clientArtifactPaths).toEqual({ outPath: '/client/clip.mov' });
  expect(statSync(join(output, '..')).mode & 0o777).toBe(0o700);

  const second = await rpc(recordStart());
  expect(second.status).toBe(400);
  expect(JSON.parse(second.text).error.data.details.rule).toBe('recording');

  expect(JSON.parse((await rpc({ command: 'record', session: 'default', positionals: ['stop'] })).text)).toMatchObject({
    id: 4,
    result: { ok: true },
  });
  expect((await rpc(recordStart())).status).toBe(200);
  expect(forwardedRecord().params.positionals[1]).toMatch(/\/recording\.mp4$/);
  expect(forwardedRecord().params.meta.clientArtifactPaths).toEqual({ outPath: '/client/clip.mp4' });

  await driver.stop();
  expect(existsSync(join(home, 'agent', 'recordings'))).toBe(false);
});

test('overlapping starts run only one recording', async () => {
  await start();
  const answers = await Promise.all([rpc(recordStart()), rpc(recordStart())]);
  expect(answers.map((answer) => answer.status).toSorted()).toEqual([200, 400]);
  expect(fixture.calls.filter((call) => call.body.includes('"record"'))).toHaveLength(1);
});

test('a start the daemon refuses leaves no recording behind', async () => {
  await start();
  fixture.recordOk = false;
  expect((await rpc(recordStart())).status).toBe(200);
  expect(readdirSync(join(home, 'agent', 'recordings'))).toEqual([]);
  fixture.recordOk = true;
  expect((await rpc(recordStart())).status).toBe(200);
});

test('stops a recording at the time limit and hands that stop to the next client stop', async () => {
  await driver.stop();
  driver = new AgentDeviceDriver({
    env: { STIM_AGENT_DEVICE_BIN: join(home, 'agent-device.mjs') },
    stateDir: join(home, 'agent'),
    claimRoot: join(home, 'claims'),
    device: { session: SESSION, udid: UDID },
    maxRecordingMs: 20,
  });
  await start();
  await rpc(recordStart());
  await vi.waitFor(() => expect(forwardedRecord().params.positionals).toEqual(['stop']));
  const stop = forwardedRecord();
  expect(stop.params).toEqual({
    command: 'record',
    positionals: ['stop'],
    session: 'default',
    flags: { platform: 'ios', udid: UDID },
    meta: {
      tenantId: `stim.${SESSION}`,
      runId: SESSION,
      clientId: 'agent',
      deviceKey: `ios:mobile:${UDID}`,
      leaseProvider: 'proxy',
      leaseBackend: 'ios-instance',
      sessionIsolation: 'tenant',
    },
  });
  expect(fixture.calls.at(-1)?.headers).toMatchObject({ 'x-agent-device-tenant': `stim.${SESSION}` });
  const refused = JSON.parse((await rpc(recordStart())).text);
  expect(refused.error.data.details.rule).toBe('recording');
  expect(refused.error.message).toContain('limit');
  const calls = fixture.calls.length;
  const answer = await rpcBody({
    id: 'client-stop',
    method: 'agent_device.command',
    params: { command: 'record', session: 'default', positionals: ['stop'] },
  });
  expect(JSON.parse(answer.text)).toEqual({
    jsonrpc: '2.0',
    id: 'client-stop',
    result: { ok: true, data: { recording: 'stop' } },
  });
  expect(fixture.calls).toHaveLength(calls);
  expect((await rpc(recordStart())).status).toBe(200);
});

test.each([
  { stop: 'client', maxRecordingMs: 600_000 },
  { stop: 'time limit', maxRecordingMs: 200 },
])('deletes a recording over the size limit after a $stop stop', async ({ maxRecordingMs }) => {
  await driver.stop();
  driver = new AgentDeviceDriver({
    env: { STIM_AGENT_DEVICE_BIN: join(home, 'agent-device.mjs') },
    stateDir: join(home, 'agent'),
    claimRoot: join(home, 'claims'),
    device: { session: SESSION, udid: UDID },
    maxRecordingBytes: 10,
    maxRecordingMs,
  });
  await start();
  await rpc(recordStart());
  const output = forwardedRecord().params.positionals[1];
  writeFileSync(output, 'more than ten bytes');
  await vi.waitFor(() => {
    if (maxRecordingMs < 600_000 && existsSync(join(output, '..'))) throw new Error('waiting for the time-limit stop');
  });
  const answer = JSON.parse((await rpc({ command: 'record', session: 'default', positionals: ['stop'] })).text);
  expect(answer).toMatchObject({
    id: 4,
    result: { ok: false, error: { details: { reason: 'STIM_RECORDING_TOO_LARGE' } } },
  });
  expect(existsSync(join(output, '..'))).toBe(false);
});

test('a stop the daemon answers with a failure ends the recording', async () => {
  await start();
  await rpc(recordStart());
  const output = forwardedRecord().params.positionals[1];
  fixture.recordOk = false;
  expect(JSON.parse((await rpc({ command: 'record', session: 'default', positionals: ['stop'] })).text)).toMatchObject({
    result: { ok: false },
  });
  expect(existsSync(join(output, '..'))).toBe(false);
  fixture.recordOk = true;
  expect((await rpc(recordStart())).status).toBe(200);
});

test('a stop from another agent-device session keeps the running recording', async () => {
  await start();
  await rpc(recordStart());
  const calls = fixture.calls.length;
  const other = await rpc({ command: 'record', session: 'other', positionals: ['stop'] });
  expect(other.status).toBe(400);
  expect(JSON.parse(other.text).error.data.details.rule).toBe('recording');
  expect(fixture.calls).toHaveLength(calls);
  expect((await rpc(recordStart())).status).toBe(400);
  expect((await rpc({ command: 'record', session: 'default', positionals: ['stop'] })).status).toBe(200);
});

test('a request too deep to serialize fails without rejecting the relay', async () => {
  await start();
  const depth = 12_000;
  const body = `{"id":9,"method":"agent_device.command","params":{"command":"snapshot","flags":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}}`;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect((await rpcBody(body)).status).toBe(500);
});
