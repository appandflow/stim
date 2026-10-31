import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { keepAgentClaim, killKeptChild } from './fixtures/kept-agent-claim.ts';
import type { ProcessIdentityStatus } from '@stim-cli/core/process-identity';
import { AgentDeviceDriver } from '@stim-cli/agent-driver-agent-device';

const fixture = vi.hoisted(() => ({
  version: '0.21.30',
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
  recordError: { code: '', message: '' },
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
    const version = Array.isArray(args[0]) && args[0].includes('--version');
    if (!version) fixture.events.push(command === '/bin/ps' ? 'ps' : 'daemon-stop');
    if (command === '/bin/ps' && fixture.psError) {
      (args.at(-1) as (error: Error) => void)(new Error('process listing unavailable'));
      return;
    }
    const ps = command === '/bin/ps' && fixture.ps.length > 1 ? fixture.ps.shift() : fixture.ps[0];
    (args.at(-1) as (error: null, stdout: string) => void)(
      null,
      command === '/bin/ps' ? (ps ?? '') : version ? fixture.version : '',
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
        const sent = options.path === '/rpc' ? JSON.parse(body?.toString() ?? '{}') : {};
        const data =
          options.path === '/health'
            ? { upstream: { leaseBackends: fixture.backend ? ['ios-instance'] : [] } }
            : sent.params?.command === 'record'
              ? fixture.recordError.message
                ? {
                    jsonrpc: '2.0',
                    id: sent.id,
                    error: { code: -32000, message: fixture.recordError.message, data: fixture.recordError },
                  }
                : { jsonrpc: '2.0', id: sent.id, result: { ok: true, data: { recording: sent.params.positionals[0] } } }
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
  fixture.version = '0.21.30';
  fixture.policy = true;
  fixture.backend = true;
  fixture.proxyStopped = true;
  fixture.calls = [];
  fixture.recordError = { code: '', message: '' };
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

test.each([
  { command: 'fold', positionals: ['open'], flags: { keyframes: '[{"atMs":0,"angle":90},{"atMs":500,"angle":180}]' } },
  { command: 'push', positionals: ['dev.app', '{"aps":{"alert":"x"}}'] },
  { command: 'perf', positionals: ['memory', 'sample'] },
  { command: 'settings', positionals: ['permission', 'grant', 'camera'], input: { app: 'dev.app' } },
  { command: 'wait', positionals: ['100'], flags: { durationMs: 100 } },
  { command: 'apps', flags: { appsFilter: 'user-installed' } },
  { command: 'click', positionals: ['@e1'], flags: { noRecord: true } },
  {
    command: 'gesture',
    flags: { kind: 'tap' },
    input: { session: 'default', deviceTarget: 'mobile', kind: 'tap', points: [{ x: 10, y: 10 }] },
  },
])('forwards the client request for $command with its own flags and input', async (params) => {
  await start();
  expect((await rpc({ session: 'default', ...params })).status).toBe(200);
  const forwarded = JSON.parse(fixture.calls.at(-1)?.body ?? '{}').params;
  expect(forwarded.positionals).toEqual(params.positionals);
  expect(forwarded.flags).toEqual({ ...params.flags, platform: 'ios', udid: UDID });
  expect(forwarded.input).toEqual(params.input && { ...params.input, platform: 'ios', udid: UDID });
});

test('an agent-device older than the hosted command list gets no daemon or claim', async () => {
  fixture.version = '0.21.29';
  await expect(driver.start()).rejects.toThrow('0.21.30');
  expect(fixture.calls).toEqual([]);
  expect(readClaimSet(join(home, 'claims')).live).toEqual([]);
});

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

test('writes a recording only in a private temp directory, one at a time, and removes it on stop and start', async () => {
  await start();
  const remote = await rpc(recordStart('/tmp/agent-device-recording-1793117267701-ab12cd.mov'));
  expect(remote.status).toBe(200);
  const started = forwardedRecord().params;
  const output = started.positionals[1];
  const recordings = dirname(dirname(output));
  expect(relative(home, output).startsWith('..')).toBe(true);
  expect(relative(tmpdir(), output).startsWith('..')).toBe(false);
  expect(basename(output)).toBe('recording.mov');
  expect(started.flags).toEqual({ platform: 'ios', udid: UDID, fps: 30 });
  expect(started.meta.clientArtifactPaths).toEqual({ outPath: '/client/clip.mov' });
  const permissionMask = process.platform === 'win32' ? 0o600 : 0o777;
  const expectedPermissions = process.platform === 'win32' ? 0o600 : 0o700;
  expect(statSync(join(output, '..')).mode & permissionMask).toBe(expectedPermissions);
  expect(statSync(recordings).mode & permissionMask).toBe(expectedPermissions);

  const second = await rpc(recordStart());
  expect(second.status).toBe(400);
  expect(JSON.parse(second.text).error.data.details.rule).toBe('recording');

  expect(JSON.parse((await rpc({ command: 'record', session: 'default', positionals: ['stop'] })).text)).toMatchObject({
    id: 4,
    result: { ok: true },
  });
  expect((await rpc(recordStart())).status).toBe(200);
  expect(basename(forwardedRecord().params.positionals[1])).toBe('recording.mp4');
  expect(forwardedRecord().params.meta.clientArtifactPaths).toEqual({ outPath: '/client/clip.mp4' });

  await driver.stop();
  expect(existsSync(recordings)).toBe(false);

  mkdirSync(join(recordings, 'left-by-a-crash'), { recursive: true });
  await start();
  expect(existsSync(recordings)).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'refuses to record when the recordings directory is a link another user could plant',
  async () => {
    await start();
    expect((await rpc(recordStart())).status).toBe(200);
    const recordings = dirname(dirname(forwardedRecord().params.positionals[1]));
    await driver.stop();
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    await start();
    symlinkSync(elsewhere, recordings, 'dir');
    const calls = fixture.calls.length;
    expect((await rpc(recordStart())).status).toBe(500);
    expect(fixture.calls.slice(calls).some((call) => call.body.includes('"record"'))).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(recordings);
  },
);

test('a start the daemon refuses leaves no recording behind', async () => {
  await start();
  fixture.recordError = { code: 'COMMAND_FAILED', message: 'recorder failed to start' };
  expect((await rpc(recordStart())).status).toBe(200);
  expect(readdirSync(dirname(dirname(forwardedRecord().params.positionals[1])))).toEqual([]);
  fixture.recordError = { code: '', message: '' };
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

test('only a stop agent-device answers with no active recording ends a recording it did not finish', async () => {
  await start();
  await rpc(recordStart());
  const output = forwardedRecord().params.positionals[1];
  fixture.recordError = { code: 'INVALID_ARGS', message: 'record stop accepts no --quality flag' };
  const stop = { command: 'record', session: 'default', positionals: ['stop'], flags: { quality: 'high' } };
  expect((await rpc(stop)).status).toBe(200);
  expect(forwardedRecord().params.flags).toEqual({ platform: 'ios', udid: UDID });
  expect(existsSync(join(output, '..'))).toBe(true);
  expect((await rpc(recordStart())).status).toBe(400);
  fixture.recordError = { code: 'INVALID_ARGS', message: 'no active recording' };
  await rpc(stop);
  expect(existsSync(join(output, '..'))).toBe(false);
  fixture.recordError = { code: '', message: '' };
  expect((await rpc(recordStart())).status).toBe(200);
});

test('a request too deep to serialize fails without rejecting the relay', async () => {
  await start();
  const depth = 12_000;
  const body = `{"id":9,"method":"agent_device.command","params":{"command":"snapshot","flags":{"snapshotScope":${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}}}}`;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect((await rpcBody(body)).status).toBe(500);
});

test.each([
  { command: 'screenshot', positionals: ['/host/file.png'] },
  { command: 'record', positionals: ['start'], meta: {} },
  { command: 'record', positionals: ['stop', '/tmp/agent-device-recording-1-ab.mp4'] },
  { command: 'record', positionals: ['list'] },
  { command: 'batch', flags: { batchSteps: [{ command: 'record', positionals: ['stop'] }] } },
  { command: 'push', positionals: ['dev.app', '/Users/me/payload.json'] },
  { command: 'push', positionals: ['dev.app', '{"a":"/../../tmp/x}"}'] },
  { command: 'push', positionals: ['/host/App.app', '{"aps":{}}'] },
  { command: 'perf', positionals: ['memory', 'snapshot'] },
  { command: 'artifacts', positionals: ['provider-session'] },
  { command: 'settings', positionals: ['permission', 'grant', 'accessibility'] },
  { command: 'settings', positionals: [' Permission', 'grant', 'Screen-Recording'] },
  { command: 'settings', positionals: ['clear-app-state', 'clear', '/host/App.app'] },
  { command: 'settings', positionals: ['permission', 'grant', 'camera'], input: { app: '/host/App.app' } },
])('refuses host access and out-of-scope recording requests before forwarding: %j', async (params) => {
  await start();
  fixture.calls = [];
  expect((await rpc(params)).status).toBe(400);
  expect(fixture.calls).toEqual([]);
});

test.each(['Xcode 27.app'])('stops only exact-UDID runners under %s, after the daemon clean path', async (app) => {
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
});

test('never signals a runner whose captured identity changed or whose destination changed before signalling', async () => {
  await start();
  fixture.ps = [runner(888880) + '\n' + runner(888881), runner(888880) + '\n' + runner(888881, SESSION)];
  fixture.identities = { 888880: 'different', 888881: 'same' };
  await driver.stop();
  expect(fixture.events).toEqual(['daemon-stop', 'ps', 'ps']);
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

test('overlapping starts run only one recording', async () => {
  await start();
  const answers = await Promise.all([rpc(recordStart()), rpc(recordStart())]);
  expect(answers.map((answer) => answer.status).toSorted()).toEqual([200, 400]);
  expect(fixture.calls.filter((call) => call.body.includes('"record"'))).toHaveLength(1);
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
