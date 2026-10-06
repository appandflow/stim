import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { parseHostedAgentGrant } from '@stim-cli/core/state';
import { AgentDeviceDriver } from '../src/agent-device-driver.ts';

const fixture = vi.hoisted(() => ({
  policy: true,
  backend: true,
  proxyStopped: true,
  calls: [] as { path: string; body: string; headers: Record<string, string> }[],
}));

vi.mock('@stim-cli/core/process-identity', async (original) => {
  const actual = await original<typeof import('@stim-cli/core/process-identity')>();
  return {
    ...actual,
    captureProcessIdentity: (pid: number) =>
      [777777, 777778].includes(pid) ? { ok: true, token: 'fixture-process' } : actual.captureProcessIdentity(pid),
    inspectProcessIdentity: (record: Parameters<typeof actual.inspectProcessIdentity>[0]) =>
      record?.pid === 777778 && !fixture.proxyStopped
        ? 'unknown'
        : record && typeof record.pid === 'number' && [777777, 777778].includes(record.pid)
          ? 'gone'
          : actual.inspectProcessIdentity(record),
    waitForProcessExit: () => Promise.resolve(fixture.proxyStopped),
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
  execFile: (...args: unknown[]) => (args.at(-1) as () => void)(),
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
            ? { upstream: { leaseBackends: fixture.backend ? ['ios-instance'] : [] } }
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
const UDID = '22222222-2222-4222-8222-222222222222';
const upstream =
  '/private/tmp/claude-501/-Users-janicduplessis-Developer-stim/0dc300cd-42a3-4758-8d35-79edf2904001/scratchpad/ad-937471b/build-src';
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
  driver = new AgentDeviceDriver({
    env: { STIM_AGENT_DEVICE_BIN: bin },
    stateDir: join(home, 'agent'),
    claimRoot: join(home, 'claims'),
    ios: { session: SESSION, udid: UDID },
  });
});

afterEach(async () => {
  await driver.stop();
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
  expect(statSync(join(home, 'agent', 'policy.json')).mode & 0o777).toBe(0o600);
  expect(fixture.calls.map((call) => call.path)).toEqual(['/health']);
  await expect(driver.issue({ client: 'c', session: UDID, udid: UDID, bundleId: 'dev.app' })).rejects.toThrow(
    'another hosted simulator',
  );
  await driver.stop();
  expect(readClaimSet(join(home, 'claims')).live).toHaveLength(0);
});

// agent-device 0.21.20 ADR 0029: src/daemon-policy-file.ts and src/daemon/daemon-policy.ts.
test.skipIf(!existsSync(join(upstream, 'src/daemon-policy-file.ts')))(
  'the real upstream parser accepts the generated policy and inventory filtering exposes only its simulator',
  async () => {
    await start();
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          `
            import { readFileSync } from 'node:fs';
            import { pathToFileURL } from 'node:url';
            import assert from 'node:assert/strict';
            const root = process.argv[1];
            const { parseDaemonPolicy } = await import(pathToFileURL(root + '/src/daemon-policy-file.ts'));
            const { assertDaemonPolicyAdmitsRequest, restrictDeviceInventoryToDaemonPolicy } =
              await import(pathToFileURL(root + '/src/daemon/daemon-policy.ts'));
            const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
            const policy = parseDaemonPolicy(raw, process.argv[2]);
            assert.throws(() => parseDaemonPolicy({ ...raw, commands: { allow: ['rotate'] } }, 'invalid'));
            assertDaemonPolicyAdmitsRequest(policy, { command: 'devices' });
            const devices = [{ id: raw.devices.allow[0].udid }, { id: 'foreign-simulator' }];
            const gateways = restrictDeviceInventoryToDaemonPolicy({
              localOnly: { discover: async () => devices },
              providerFirst: { discoverWithSource: async () => ({ devices, source: 'local' }) },
            }, policy);
            console.log(JSON.stringify({
              digest: policy.digest,
              local: await gateways.localOnly.discover(),
              provider: await gateways.providerFirst.discover(),
            }));
          `,
          upstream,
          join(home, 'agent', 'policy.json'),
        ],
        { encoding: 'utf8', timeout: 10000 },
      ),
    );
    expect(result).toEqual({
      digest: JSON.parse(readFileSync(join(home, 'agent', 'daemon.json'), 'utf8')).policyDigest,
      local: [{ id: UDID }],
      provider: [{ id: UDID }],
    });
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
        cwd: '/private/tmp/.../2266-p1',
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
  expect((await rpc({}, 'agent_device.command', '/upload')).status).toBe(404);
  await driver.revoke(SESSION);
  expect((await rpc({ command: 'snapshot' })).status).toBe(503);
  expect(fixture.calls).toEqual([]);
});
