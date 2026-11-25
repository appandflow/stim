import { createHash } from 'node:crypto';
import { createAgentDriverHost } from '@stim-cli/agent-driver';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { inspectProcessIdentity, captureProcessIdentity } from '@stim-cli/core/process-identity';
import { AgentDeviceDriver } from '../driver.ts';
import { parseHostedAgentGrant } from '@stim-cli/core/state';

const FAKE_AGENT_DEVICE = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const unregistered = () => {
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  daemon.unref();
  appendFileSync(process.env.FAKE_PIDS, daemon.pid + '\\n');
  appendFileSync(process.env.FAKE_STRAYS, daemon.pid + '\\n');
};
const digest = () => {
  const policy = JSON.parse(readFileSync(process.env.AGENT_DEVICE_DAEMON_POLICY, 'utf8'));
  if (!policy.devices) return undefined;
  return createHash('sha256').update(JSON.stringify({
    devices: policy.devices.allow.map((device) => device.udid ?? device.serial),
    commands: policy.commands ? { mode: 'allow', names: policy.commands.allow.toSorted() } : null,
    capabilities: policy.capabilities.deny,
  })).digest('hex');
};
if (args[0] === '--version') {
  console.log('0.21.42');
} else if (args[0] === 'proxy' && process.env.FAKE_PROXY === 'exit-unregistered') {
  unregistered();
  console.error('Error (COMMAND_FAILED): Failed to start daemon');
  process.exit(1);
} else if (args[0] === 'proxy' && process.env.FAKE_PROXY === 'silent-unregistered') {
  unregistered();
  setInterval(() => {}, 1000);
} else if (args[0] === 'proxy' && process.env.FAKE_PROXY === 'daemon-only') {
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  daemon.unref();
  appendFileSync(process.env.FAKE_PIDS, daemon.pid + '\\n');
  writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({ pid: daemon.pid }));
  setInterval(() => {}, 1000);
} else if (args[0] === 'proxy' && process.env.FAKE_PROXY === 'fail') {
  console.error('Error (COMMAND_FAILED): Failed to start daemon');
  process.exit(1);
} else if (args[0] === 'proxy' && process.env.FAKE_PROXY === 'silent') {
  setInterval(() => {}, 1000);
} else if (args[0] === 'proxy') {
  if (process.env.FAKE_PROXIES) appendFileSync(process.env.FAKE_PROXIES, process.pid + '\\n');
  const code = (process.env.FAKE_DAEMON === 'stubborn' ? "process.on('SIGTERM', () => {});" : '') + 'setInterval(() => {}, 1000)';
  const daemon = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  daemon.unref();
  appendFileSync(process.env.FAKE_PIDS, daemon.pid + '\\n');
  writeFileSync(join(stateDir, 'proxy-env.json'), JSON.stringify({
    policy: readFileSync(process.env.AGENT_DEVICE_DAEMON_POLICY, 'utf8'),
    backend: process.env.AGENT_DEVICE_MACOS_APP_BACKEND,
  }));
  const admin = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const ok = request.headers.authorization === 'Bearer daemon-secret' && process.env.FAKE_ADMIN !== 'refuse';
      const entry = JSON.stringify({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString() }) + '\\n';
      const slow = request.method === 'PUT' ? Number(process.env.FAKE_ADMIN_PUT_MS ?? 0) : 0;
      appendFileSync(join(stateDir, 'admin-started.log'), entry);
      setTimeout(() => {
        appendFileSync(join(stateDir, 'admin.log'), entry);
        response.writeHead(ok ? 200 : 400, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ ok }));
      }, slow);
    });
  });
  admin.listen(0, '127.0.0.1', () => {
    writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({ pid: daemon.pid, httpPort: admin.address().port, token: 'daemon-secret', policyDigest: digest() }));
    const server = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        if (request.url === '/health') {
          const leaseBackends = (process.env.FAKE_LEASE_BACKENDS ?? 'ios-instance,macos-app').split(',');
          response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
          return response.end(JSON.stringify({ ok: true, service: 'agent-device-proxy', upstream: { leaseBackends } }));
        }
        const authorized = request.headers.authorization === 'Bearer ' + process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
        response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ authorized, method: request.method, url: request.url, body: Buffer.concat(chunks).toString(), seen: Object.keys(request.headers), tenant: request.headers['x-agent-device-tenant'] }));
      });
    });
    server.listen(0, '127.0.0.1', () => console.log('Proxy listening at http://127.0.0.1:' + server.address().port));
  });
} else if (args[0] === 'daemon' && args[1] === 'stop') {
  if (process.env.FAKE_STOP_FAIL || (process.env.FAKE_STOP_FAIL_FILE && existsSync(process.env.FAKE_STOP_FAIL_FILE))) {
    console.error('Error (COMMAND_FAILED): daemon stop failed');
    process.exit(1);
  }
  let pid;
  try { pid = JSON.parse(readFileSync(join(stateDir, 'daemon.json'), 'utf8')).pid; } catch {}
  const running = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const found = pid !== undefined && running();
  let mode = found ? 'graceful' : 'not-running';
  if (found && !process.env.FAKE_STOP_NOOP) {
    process.kill(pid, 'SIGTERM');
    let until = Date.now() + Number(process.env.FAKE_STOP_GRACE_MS ?? 2000);
    while (running() && Date.now() < until) {}
    if (running()) {
      process.kill(pid, 'SIGKILL');
      mode = 'forced';
      until = Date.now() + 2000;
      while (running() && Date.now() < until) {}
    }
  }
  if (args.includes('--json')) console.log(JSON.stringify({ success: true, data: { stopped: found, mode } }));
  else console.log('Daemon stopped (' + mode + ').');
}
`;

let root: string;

function install(home: string): string {
  const real = join(home, 'lib', 'agent-device.mjs');
  mkdirSync(join(home, 'lib'), { recursive: true });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(real, FAKE_AGENT_DEVICE);
  chmodSync(real, 0o755);
  symlinkSync(real, join(home, '.local', 'bin', 'agent-device'));
  return real;
}

function driverIn(
  home: string,
  extra: Partial<ConstructorParameters<typeof AgentDeviceDriver>[0]> = {},
  env: Record<string, string> = {},
) {
  return new AgentDeviceDriver({
    env: { HOME: home, PATH: '/usr/bin:/bin', FAKE_PIDS: join(home, 'daemon-pids.log'), ...env },
    stateDir: join(home, 'state'),
    claimRoot: join(home, 'agent-device.claims'),
    host: createAgentDriverHost({ stateDir: join(home, 'state'), claimRoot: join(home, 'agent-device.claims') }),
    watchMs: 50,
    ...extra,
  });
}

function loopback(port: number, method: string, path: string, body?: string, headers = {}) {
  return new Promise<{ status: number; text: string; contentType: string | undefined }>((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (answer) => {
      let text = '';
      answer.on('data', (chunk: Buffer) => (text += chunk.toString()));
      answer.on('end', () =>
        resolve({ status: answer.statusCode ?? 0, text, contentType: answer.headers['content-type'] }),
      );
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

async function through(
  driver: AgentDeviceDriver,
  session: string,
  method: string,
  path: string,
  body?: string,
  headers = {},
) {
  const target = await driver.target(session);
  if (!target) return { status: 503, text: '', contentType: undefined };
  return loopback(target.port, method, `${target.path}${path}`, body, headers);
}

const SESSION = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-agent-device-'));
});

function isFixtureDaemon(pid: number): boolean {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes('setInterval');
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

afterEach(async () => {
  const log = join(root, 'daemon-pids.log');
  const recorded = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  let survivors = recorded.filter(isFixtureDaemon);
  for (let waited = 0; survivors.length > 0 && waited < 1000; waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    survivors = survivors.filter(isFixtureDaemon);
  }
  for (const pid of survivors) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
  if (survivors.length > 0) throw new Error(`fake agent-device daemons outlived their test: ${survivors.join(', ')}`);
});

describe.skipIf(process.platform === 'win32')('agent-device driver', () => {
  test('allocates a lease for exactly the hosted app process, renews it and releases it on revoke', async () => {
    install(root);
    const driver = driverIn(root, { leaseRenewMs: 50 });
    await driver.start();
    try {
      const sessionsDir = join(root, 'state', 'sessions');
      const removed = [`stim.${SESSION}_default`, `stim.${SESSION}_other`];
      const kept = ['default', 'stim.other_default'];
      for (const name of [...removed, ...kept]) {
        mkdirSync(join(sessionsDir, name, 'requests'), { recursive: true });
        writeFileSync(join(sessionsDir, name, 'session.json'), '{}');
      }
      const grant = await driver.issue({
        client: 'c',
        session: SESSION,
        bundleId: 'dev.example.app.hosted1',
        pid: 4242,
      });
      const routed = { ...grant, path: `/device-host/agent/${SESSION}/` };
      expect(parseHostedAgentGrant(routed)).toEqual(routed);
      if (!grant.lease) throw new Error('expected a lease');
      expect(grant.lease.deviceKey).toBe('dev.example.app.hosted1@4242');
      const calls = () =>
        readFileSync(join(root, 'state', 'admin.log'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { method: string; url: string; body: string });
      expect(calls()[0]).toMatchObject({ method: 'PUT', url: `/admin/leases/${grant.scope}` });
      expect(JSON.parse(calls()[0]!.body)).toEqual({
        tenantId: grant.lease.tenant,
        runId: grant.lease.runId,
        clientId: grant.lease.clientId,
        leaseBackend: 'macos-app',
        leaseProvider: 'proxy',
        deviceKey: 'dev.example.app.hosted1@4242',
        ttlMs: 600_000,
      });
      await vi.waitFor(() => expect(calls().filter((call) => call.method === 'PUT').length).toBeGreaterThan(2));
      await driver.revoke(SESSION);
      for (const name of removed) expect(existsSync(join(sessionsDir, name))).toBe(false);
      for (const name of kept) expect(existsSync(join(sessionsDir, name, 'session.json'))).toBe(true);
      expect(calls().at(-1)).toMatchObject({ method: 'DELETE', url: `/admin/leases/${grant.scope}` });
      const after = calls().length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(calls()).toHaveLength(after);
      expect((await through(driver, SESSION, 'GET', '/health')).status).toBe(503);
    } finally {
      await driver.stop();
    }
  });

  test('stop removes the directories of revoked sessions after the daemon is gone and keeps live ones', async () => {
    install(root);
    const driver = driverIn(root);
    await driver.start();
    const daemonPid = (JSON.parse(readFileSync(join(root, 'state', 'daemon.json'), 'utf8')) as { pid: number }).pid;
    const identity = captureProcessIdentity(daemonPid);
    const sessionsDir = join(root, 'state', 'sessions');
    const live = '22222222-2222-4222-8222-222222222222';
    const directory = (session: string) => join(sessionsDir, `stim.${session}_default`);
    try {
      for (const session of [SESSION, live]) {
        await driver.issue({ client: 'c', session, bundleId: 'dev.example.app.hosted1', pid: 4242 });
        mkdirSync(directory(session), { recursive: true });
      }
      await driver.revoke(SESSION);
      mkdirSync(directory(SESSION), { recursive: true });
      await driver.stop();
      expect(inspectProcessIdentity({ pid: daemonPid, processToken: identity.ok ? identity.token : '' })).toBe('gone');
      expect(existsSync(directory(SESSION))).toBe(false);
      expect(existsSync(directory(live))).toBe(true);
    } finally {
      await driver.stop();
    }
  });

  test('revoke waits for a renewal in flight so the DELETE is the last admin call', async () => {
    install(root);
    const driver = driverIn(root, { leaseRenewMs: 300 }, { FAKE_ADMIN_PUT_MS: '200' });
    await driver.start();
    try {
      await driver.issue({ client: 'c', session: SESSION, bundleId: 'dev.example.app.hosted1', pid: 4242 });
      const started = () =>
        readFileSync(join(root, 'state', 'admin-started.log'), 'utf8')
          .trim()
          .split('\n');
      await vi.waitFor(() => expect(started().length).toBeGreaterThan(1));
      await driver.revoke(SESSION);
      const calls = readFileSync(join(root, 'state', 'admin.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { method: string }).method);
      expect(calls.at(-1)).toBe('DELETE');
      expect(calls.filter((method) => method === 'PUT')).toHaveLength(2);
    } finally {
      await driver.stop();
    }
  });

  test('holds the daemon under a claim and removes both on stop', async () => {
    install(root);
    const driver = driverIn(root);
    await driver.start();
    await driver.start();
    expect(statSync(join(root, 'state')).mode & 0o777).toBe(0o700);
    const daemonPid = (JSON.parse(readFileSync(join(root, 'state', 'daemon.json'), 'utf8')) as { pid: number }).pid;
    const holders = readClaimSet(join(root, 'agent-device.claims')).live;
    expect(holders).toHaveLength(1);
    expect(holders[0]!.child?.pid).toBe(daemonPid);
    const record = { pid: daemonPid, processToken: holders[0]!.child!.processToken };
    expect(inspectProcessIdentity(record)).toBe('same');
    await driver.stop();
    expect(inspectProcessIdentity(record)).toBe('gone');
    expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(0);
    await driver.stop();
  });

  test('refuses a second owner of the same claim', async () => {
    install(root);
    const first = driverIn(root);
    await first.start();
    try {
      await expect(driverIn(root, { stateDir: join(root, 'other') }).start()).rejects.toThrow(
        /held by another process|claim/,
      );
    } finally {
      await first.stop();
    }
  });

  test('forwards a request to the daemon with the host token and never the client credential', async () => {
    install(root);
    const driver = driverIn(root);
    await driver.start();
    try {
      await driver.issue({ client: 'c', session: SESSION, bundleId: 'dev.example.app.hosted1', pid: 4242 });
      const answer = await through(driver, SESSION, 'GET', '/health?x=1', undefined, {
        authorization: 'Bearer client-grant-token',
        'x-agent-device-token': 'client-grant-token',
        cookie: 'a=b',
      });
      expect(answer.status).toBe(200);
      const answerRpc = await through(
        driver,
        SESSION,
        'POST',
        '/rpc?x=1',
        '{"method":"agent_device.command","params":{"command":"snapshot"}}',
        {
          'x-agent-device-tenant': 'stim.other',
          authorization: 'Bearer client-grant-token',
          'x-agent-device-token': 'client-grant-token',
          'content-type': 'application/json',
          cookie: 'a=b',
        },
      );
      const seen = JSON.parse(answerRpc.text) as Record<string, unknown>;
      expect(seen).toMatchObject({ authorized: true, method: 'POST', url: '/rpc?x=1', tenant: `stim.${SESSION}` });
      expect(seen.seen).not.toContain('x-agent-device-token');
      expect(seen.seen).not.toContain('cookie');
      expect(answerRpc.text).not.toContain('client-grant-token');
    } finally {
      await driver.stop();
    }
  });

  test('pins every command and lease call to the session lease, whatever the client names', async () => {
    install(root);
    const driver = driverIn(root);
    await driver.start();
    try {
      const grant = await driver.issue({
        client: 'c',
        session: SESSION,
        bundleId: 'dev.example.app.hosted1',
        pid: 4242,
      });
      if (!grant.lease) throw new Error('expected a lease');
      const rpc = (body: object | string) =>
        through(driver, SESSION, 'POST', '/rpc', typeof body === 'string' ? body : JSON.stringify(body), {
          'content-type': 'application/json',
        }).then((answer) => ({
          ...answer,
          upstream:
            answer.status === 200
              ? (JSON.parse((JSON.parse(answer.text) as { body: string }).body) as {
                  params: Record<string, unknown>;
                })
              : null,
        }));
      const command = await rpc({
        jsonrpc: '2.0',
        method: 'agent_device.command',
        params: {
          command: 'open',
          session: 'other-client',
          runtime: { launchUrl: 'other://open' },
          meta: {
            tenantId: 'stim.other',
            leaseId: 'f'.repeat(32),
            sessionIsolation: 'none',
            requestId: 'r1',
            cwd: '/Users/someone',
            developerDir: '/Applications/Xcode.app',
            installSource: { kind: 'path', path: '/etc' },
            lockPolicy: 'strip',
          },
        },
      });
      expect(command.upstream?.params.runtime).toBeUndefined();
      expect(command.upstream?.params.meta).toEqual({
        requestId: 'r1',
        tenantId: grant.lease.tenant,
        runId: grant.lease.runId,
        leaseId: grant.scope,
        clientId: grant.lease.clientId,
        deviceKey: 'dev.example.app.hosted1@4242',
        leaseProvider: 'proxy',
        leaseBackend: 'macos-app',
        sessionIsolation: 'tenant',
      });
      const selected = await rpc({
        method: 'agent_device.command',
        params: {
          command: 'batch',
          flags: {
            udid: 'SIM-1',
            serial: 'emulator-5554',
            device: 'iPhone',
            target: 'mobile',
            iosSimulatorDeviceSet: '/tmp/set',
            androidDeviceAllowlist: 'emulator-5554',
            platform: 'ios',
            surface: 'app',
            batchSteps: [
              {
                command: 'open',
                positionals: ['dev.example.app.hosted1'],
                flags: { udid: 'SIM-2', platform: 'android' },
                input: { serial: 's' },
                runtime: { launchUrl: 'x://y' },
              },
              { command: 'snapshot' },
            ],
          },
          input: { udid: 'SIM-3', text: 'hi' },
        },
      });
      expect(selected.upstream?.params).toMatchObject({
        flags: {
          platform: 'macos',
          surface: 'app',
          batchSteps: [
            { command: 'open', positionals: ['dev.example.app.hosted1'], flags: { platform: 'macos' }, input: {} },
            { command: 'snapshot', flags: { platform: 'macos' } },
          ],
        },
        input: { text: 'hi' },
      });
      const sent = selected.upstream?.params as {
        flags: { batchSteps: Record<string, unknown>[] } & Record<string, unknown>;
        input: unknown;
      };
      expect(Object.keys(sent.flags).toSorted()).toEqual(['batchSteps', 'platform', 'surface']);
      expect(sent.input).toEqual({ text: 'hi' });
      expect(sent.flags.batchSteps[0]).toEqual({
        command: 'open',
        positionals: ['dev.example.app.hosted1'],
        flags: { platform: 'macos' },
        input: {},
      });
      const record = await rpc({
        method: 'agent_device.command',
        params: { command: 'record', positionals: ['start'] },
      });
      expect(record.status).toBe(400);
      expect(JSON.parse(record.text).error.message).toContain('macos-app lease does not allow screen recording');
      const bareOpen = await rpc({ method: 'agent_device.command', params: { command: 'open' } });
      expect(bareOpen.upstream?.params.flags).toEqual({ platform: 'macos' });
      for (const denied of ['session_list', 'lease_release', 'install', 'devices', 'diff', undefined])
        expect((await rpc({ method: 'agent_device.command', params: { command: denied } })).status).toBe(400);
      expect(
        (
          await rpc({
            method: 'agent_device.command',
            params: { command: 'batch', flags: { batchSteps: [{ command: 'snapshot' }, { command: 'session_list' }] } },
          })
        ).status,
      ).toBe(400);
      const heartbeat = await rpc({
        method: 'agent_device.lease.heartbeat',
        params: { tenant: 'stim.other', leaseId: 'f'.repeat(32), backend: 'ios-instance', provider: 'x' },
      });
      expect(heartbeat.upstream?.params).toEqual({
        tenantId: grant.lease.tenant,
        runId: grant.lease.runId,
        leaseId: grant.scope,
        clientId: grant.lease.clientId,
        deviceKey: 'dev.example.app.hosted1@4242',
        leaseProvider: 'proxy',
        backend: 'macos-app',
      });
      for (const body of [
        { method: 'agent_device.lease.allocate', params: {} },
        { method: 'agent_device.install_from_source', params: {} },
        { method: 'agent_device.command' },
      ])
        expect((await rpc(body)).status).toBe(400);
      expect((await through(driver, SESSION, 'POST', '/rpc', 'not json')).status).toBe(400);
      for (const { body, id, rule, details } of [
        {
          body: {
            id: 'doctor-request',
            method: 'agent_device.command',
            params: { command: 'doctor', flags: { platform: 'macos' } },
          },
          id: 'doctor-request',
          rule: 'command',
          details: { command: 'doctor' },
        },
        {
          body: {
            id: 0,
            method: 'agent_device.command',
            params: { command: 'batch', flags: { batchSteps: [{ command: 'snapshot' }, { command: 'doctor' }] } },
          },
          id: 0,
          rule: 'command',
          details: { command: 'doctor' },
        },
        {
          body: { id: 2, method: 'agent_device.lease.allocate', params: {} },
          id: 2,
          rule: 'method',
          details: { method: 'agent_device.lease.allocate' },
        },
        {
          body: { id: 4, method: 'agent_device.command', params: { command: 'batch', flags: { batchSteps: [null] } } },
          id: 4,
          rule: 'command',
          details: {},
        },
        {
          body: { id: 5, method: 'x'.repeat(200), params: {} },
          id: 5,
          rule: 'method',
          details: { method: 'x'.repeat(64) },
        },
        { body: 'not json', id: null, rule: 'request', details: {} },
        { body: { id: 'malformed', method: 'agent_device.command' }, id: 'malformed', rule: 'request', details: {} },
        {
          body: { id: true, method: 'agent_device.lease.allocate', params: {} },
          id: null,
          rule: 'method',
          details: { method: 'agent_device.lease.allocate' },
        },
        { body: 'x'.repeat(1024 * 1024 + 1), id: null, rule: 'request', details: {} },
      ]) {
        const answer = await rpc(body);
        expect(answer.status).toBe(400);
        expect(answer.contentType).toBe('application/json');
        const envelope = JSON.parse(answer.text);
        expect(envelope).toMatchObject({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32000,
            message: expect.any(String),
            data: {
              code: 'UNAUTHORIZED',
              message: envelope.error.message,
              hint: expect.any(String),
              retriable: false,
              details: { reason: 'STIM_AGENT_REQUEST_REFUSED', rule, ...details },
            },
          },
        });
        for (const name of [...Object.values(details), ...(rule === 'command' ? ['snapshot', 'batch'] : [])])
          expect(envelope.error.message).toContain(name);
      }
    } finally {
      await driver.stop();
    }
  });

  test('reports the proxy error when the proxy exits before it is ready', async () => {
    install(root);
    const driver = driverIn(root, {}, { FAKE_PROXY: 'fail' });
    await expect(driver.start()).rejects.toThrow(
      /exited with 1 before it was ready\. Error \(COMMAND_FAILED\): Failed to start daemon/,
    );
    await driver.stop();
  });

  test('stops a daemon the proxy started even when the proxy never reports ready and daemon stop does nothing', async () => {
    install(root);
    const driver = driverIn(root, { startTimeoutMs: 500 }, { FAKE_PROXY: 'daemon-only', FAKE_STOP_NOOP: '1' });
    await expect(driver.start()).rejects.toThrow(/did not report a listening address/);
    const daemonPid = (JSON.parse(readFileSync(join(root, 'state', 'daemon.json'), 'utf8')) as { pid: number }).pid;
    await vi.waitFor(() => expect(() => process.kill(daemonPid, 0)).toThrow(/ESRCH/));
    expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(0);
  });
});

describe.skipIf(process.platform === 'win32')('agent-device confinement', () => {
  test('refuses to start an agent-device that cannot lease one macOS app, and leaves nothing running', async () => {
    install(root);
    const driver = driverIn(root, {}, { FAKE_LEASE_BACKENDS: 'ios-instance,android-instance' });
    await expect(driver.start()).rejects.toMatchObject({ code: 'agent-driver-unavailable' });
    await expect(driver.start()).rejects.toThrow(/Stim never hands a client the hosting Mac desktop/);
    const daemonPid = (JSON.parse(readFileSync(join(root, 'state', 'daemon.json'), 'utf8')) as { pid: number }).pid;
    await vi.waitFor(() => expect(() => process.kill(daemonPid, 0)).toThrow(/ESRCH/));
    expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(0);
  });

  test('starts agent-device confined to host-allocated macos-app leases on the native backend', async () => {
    install(root);
    const driver = driverIn(root);
    await driver.start();
    try {
      const seen = JSON.parse(readFileSync(join(root, 'state', 'proxy-env.json'), 'utf8')) as {
        policy: string;
        backend: string;
      };
      expect(seen.backend).toBe('native');
      const policy = JSON.parse(seen.policy) as { leases: unknown; commands: { allow: string[] } };
      expect(policy.leases).toEqual({ require: 'macos-app' });
      expect(policy.commands.allow).toContain('snapshot');
      expect(policy.commands.allow).not.toContain('install');
      expect(statSync(join(root, 'state', 'policy.json')).mode & 0o777).toBe(0o600);
    } finally {
      await driver.stop();
    }
  });

  test('never signals a pid it read from a stale daemon record', async () => {
    install(root);
    mkdirSync(join(root, 'state'), { recursive: true });
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeFileSync(join(root, 'state', 'daemon.json'), JSON.stringify({ pid: bystander.pid }));
      const driver = driverIn(root, { startTimeoutMs: 500 }, { FAKE_PROXY: 'silent' });
      await expect(driver.start()).rejects.toThrow(/did not report a listening address/);
      await driver.stop();
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
    } finally {
      bystander.kill('SIGKILL');
    }
  });

  test('forwards only the proxy routes and keeps a bare session route to the root', async () => {
    install(root);
    const driver = driverIn(root);
    await driver.start();
    try {
      await driver.issue({ client: 'c', session: SESSION, bundleId: 'dev.example.app.hosted1', pid: 4242 });
      expect((await through(driver, SESSION, 'GET', '/health')).status).toBe(200);
      const target = await driver.target(SESSION);
      if (!target) throw new Error('expected a target');
      const forged = `/${'A'.repeat(target.path.length - SESSION.length - 2)}/${SESSION}/health`;
      expect((await loopback(target.port, 'GET', forged)).status).toBe(404);
      expect((await loopback(target.port, 'GET', `/${SESSION}/health`)).status).toBe(404);
      expect((await through(driver, SESSION, 'GET', '/admin/human-control/holds')).status).toBe(404);
      expect((await through(driver, SESSION, 'GET', '/admin/leases')).status).toBe(404);
      expect((await through(driver, SESSION, 'GET', '/rpc/../admin')).status).toBe(404);
      expect((await through(driver, SESSION, 'GET', '/rpc')).status).toBe(404);
      expect((await through(driver, SESSION, 'POST', '/upload', 'x')).status).toBe(404);
      expect((await through(driver, SESSION, 'GET', `/sessions/${SESSION}/requests/r1/diagnostics`)).status).toBe(404);
      const owned = `/sessions/${encodeURIComponent(`stim.${SESSION}:default`)}/requests/r1/diagnostics`;
      const diagnostics = await through(driver, SESSION, 'GET', owned);
      expect(diagnostics.status).toBe(200);
      expect(JSON.parse(diagnostics.text)).toMatchObject({ url: owned, tenant: `stim.${SESSION}` });
      expect((await through(driver, SESSION, 'POST', owned, 'x')).status).toBe(404);
      const another = `/sessions/${encodeURIComponent('stim.other:default')}/requests/r1/diagnostics`;
      expect((await through(driver, SESSION, 'GET', another)).status).toBe(404);
    } finally {
      await driver.stop();
    }
  });
});

function deviceDriverIn(
  home: string,
  extra: Partial<ConstructorParameters<typeof AgentDeviceDriver>[0]> = {},
  env: Record<string, string> = {},
) {
  return driverIn(
    home,
    { device: { session: SESSION, udid: 'SIM-1' }, ...extra },
    { FAKE_STRAYS: join(home, 'strays.log'), ...env },
  );
}

function strays(home: string): number[] {
  const log = join(home, 'strays.log');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number) : [];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function launchRoot(home: string): string {
  return join(
    tmpdir(),
    `stim-server-agent-device-${createHash('sha256').update(join(home, 'state')).digest('hex').slice(0, 16)}`,
  );
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('hosted device launch recovery', () => {
  afterEach(() => {
    for (const pid of strays(root)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    rmSync(launchRoot(root), { recursive: true, force: true });
    rmSync(launchRoot(root).replace('stim-server-agent-device-', 'stim-server-recordings-'), {
      recursive: true,
      force: true,
    });
  });

  test.each([
    { mode: 'exit-unregistered', error: /exited with 1 before it was ready/, options: {} },
    { mode: 'silent-unregistered', error: /did not report a listening address/, options: { startTimeoutMs: 500 } },
  ])(
    'a launch whose proxy $mode releases the claim, signals no daemon it cannot identify, and the next launch starts',
    async ({ mode, error, options }) => {
      install(root);
      const failing = deviceDriverIn(root, options, { FAKE_PROXY: mode });
      await expect(failing.start()).rejects.toThrow(error);
      const [stray] = strays(root);
      if (stray === undefined) throw new Error('the fake proxy started no daemon');
      expect(alive(stray)).toBe(true);
      expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(0);

      const next = deviceDriverIn(root);
      await next.start();
      try {
        expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(1);
        expect(alive(stray)).toBe(true);
      } finally {
        await next.stop();
      }
      expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(0);
    },
  );

  async function crashMidSession(env: Record<string, string> = {}): Promise<{ earlier: number; orphanProxy: number }> {
    install(root);
    const proxies = join(root, 'proxies.log');
    const crashed = deviceDriverIn(root, {}, { FAKE_PROXIES: proxies, ...env });
    await crashed.start();
    const earlier = Number(readFileSync(join(root, 'daemon-pids.log'), 'utf8').split('\n')[0]);
    const claimDir = join(root, 'agent-device.claims', 'exclusive');
    const claimFile = readdirSync(claimDir).find((name) => name.endsWith('.claim'));
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = dead.pid;
    if (!claimFile || deadPid === undefined)
      throw new Error('the crashed server left no claim, or no stand-in started');
    const identity = captureProcessIdentity(deadPid);
    await new Promise((resolve) => dead.once('exit', resolve));
    if (!identity.ok) throw new Error('the stand-in server identity could not be captured');
    const claim: unknown = JSON.parse(readFileSync(join(claimDir, claimFile), 'utf8'));
    writeFileSync(
      join(claimDir, claimFile),
      JSON.stringify(Object.assign({}, claim, { owner: { pid: deadPid, processToken: identity.token } })),
    );
    return { earlier, orphanProxy: Number(readFileSync(proxies, 'utf8').split('\n')[0]) };
  }

  test('after the server dies mid-session, the next server retires the earlier daemon through agent-device and launches', async () => {
    const { earlier, orphanProxy } = await crashMidSession();
    const next = deviceDriverIn(root);
    try {
      await next.start();
      expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(1);
      expect(alive(earlier)).toBe(false);
    } finally {
      await next.stop();
      try {
        process.kill(-orphanProxy, 'SIGKILL');
      } catch {}
    }
  });

  test('after the server dies, a launch waits out agent-device force-stopping an earlier daemon that ignores SIGTERM', async () => {
    const { earlier, orphanProxy } = await crashMidSession({ FAKE_DAEMON: 'stubborn' });
    const next = deviceDriverIn(root, { stopTimeoutMs: 200 }, { FAKE_STOP_GRACE_MS: '1000' });
    try {
      await next.start();
      expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(1);
      expect(alive(earlier)).toBe(false);
    } finally {
      await next.stop();
      try {
        process.kill(-orphanProxy, 'SIGKILL');
      } catch {}
      try {
        process.kill(earlier, 'SIGKILL');
      } catch {}
    }
  });

  test('an rc.3 daemon that outlived its server keeps its claim, and once that claim is cleared the next launch retires it', async () => {
    install(root);
    const legacy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    legacy.unref();
    if (legacy.pid === undefined) throw new Error('the rc.3 stand-in daemon did not start');
    writeFileSync(join(root, 'daemon-pids.log'), `${legacy.pid}\n`);
    writeFileSync(join(root, 'strays.log'), `${legacy.pid}\n`);
    mkdirSync(launchRoot(root), { recursive: true, mode: 0o700 });
    writeFileSync(join(launchRoot(root), 'daemon.json'), JSON.stringify({ pid: legacy.pid }));
    const claims = join(root, 'agent-device.claims');
    const rc3 = createAgentDriverHost({ stateDir: join(root, 'state'), claimRoot: claims });
    const taken = await rc3.claims.take(claims, 'agent-device daemon');
    const child = await rc3.processes.capture(legacy.pid);
    if (!('claim' in taken) || !child) throw new Error('the rc.3 claim could not be planted');
    await rc3.claims.setChild(taken.claim, child);
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = dead.pid;
    if (deadPid === undefined) throw new Error('no stand-in server started');
    const identity = captureProcessIdentity(deadPid);
    await new Promise((resolve) => dead.once('exit', resolve));
    if (!identity.ok) throw new Error('the stand-in server identity could not be captured');
    const claimName = readdirSync(join(claims, 'exclusive')).find((name) => name.endsWith('.claim'));
    if (!claimName) throw new Error('the rc.3 claim file is missing');
    const claimFile = join(claims, 'exclusive', claimName);
    const claim: unknown = JSON.parse(readFileSync(claimFile, 'utf8'));
    writeFileSync(
      claimFile,
      JSON.stringify(Object.assign({}, claim, { owner: { pid: deadPid, processToken: identity.token } })),
    );

    await expect(deviceDriverIn(root).start()).rejects.toThrow(/held by another process/);
    expect(alive(legacy.pid)).toBe(true);
    rmSync(claims, { recursive: true, force: true });
    const next = deviceDriverIn(root);
    try {
      await next.start();
      expect(alive(legacy.pid)).toBe(false);
    } finally {
      await next.stop();
    }
  });

  test('a launch retires the launch recorded when it takes the claim, not the one recorded before', async () => {
    const { earlier, orphanProxy } = await crashMidSession();
    const launchFile = join(root, 'state', 'agent-device-launch');
    const recorded = readFileSync(launchFile, 'utf8');
    writeFileSync(launchFile, '0000000000000000\n');
    const host = createAgentDriverHost({ stateDir: join(root, 'state'), claimRoot: join(root, 'agent-device.claims') });
    const take = host.claims.take.bind(host.claims);
    host.claims.take = (...args) => {
      writeFileSync(launchFile, recorded);
      return take(...args);
    };
    const next = deviceDriverIn(root, { host });
    try {
      await next.start();
      expect(alive(earlier)).toBe(false);
    } finally {
      await next.stop();
      try {
        process.kill(-orphanProxy, 'SIGKILL');
      } catch {}
      try {
        process.kill(earlier, 'SIGKILL');
      } catch {}
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    'a launch whose recordings folder cannot be created still links the state sessions to the daemon directory',
    async () => {
      const previous = process.env.TMPDIR;
      const tmp = join(root, 'tmp');
      mkdirSync(tmp, { mode: 0o700 });
      process.env.TMPDIR = tmp;
      mkdirSync(launchRoot(root), { mode: 0o700 });
      chmodSync(tmp, 0o555);
      install(root);
      const driver = deviceDriverIn(root);
      try {
        await driver.start();
        const launch = readFileSync(join(root, 'state', 'agent-device-launch'), 'utf8').trim();
        expect(readlinkSync(join(root, 'state', 'sessions'))).toBe(join(launchRoot(root), launch, 'state', 'sessions'));
      } finally {
        await driver.stop();
        chmodSync(tmp, 0o700);
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
      }
    },
  );

  test('after the server dies, stopping its session keeps the claim until agent-device proves the daemon stopped', async () => {
    const { earlier, orphanProxy } = await crashMidSession();
    try {
      const failing = join(root, 'stop-fails');
      writeFileSync(failing, '');
      const stopping = deviceDriverIn(root, {}, { FAKE_STOP_FAIL_FILE: failing });
      await expect(stopping.stop()).rejects.toThrow(/could not be proven stopped/);
      expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(1);
      expect(alive(earlier)).toBe(true);
      rmSync(failing);
      await stopping.stop();
      expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(0);
      expect(alive(earlier)).toBe(false);
    } finally {
      try {
        process.kill(-orphanProxy, 'SIGKILL');
      } catch {}
      try {
        process.kill(earlier, 'SIGKILL');
      } catch {}
    }
  });

  test('after the server dies, a launch refuses while the earlier daemon cannot be proven stopped, and signals nothing', async () => {
    const { earlier, orphanProxy } = await crashMidSession();
    try {
      const blocked = deviceDriverIn(root, {}, { FAKE_STOP_FAIL: '1' });
      await expect(blocked.start()).rejects.toThrow(/could not be proven stopped/);
      expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(0);
      expect(alive(earlier)).toBe(true);
      const next = deviceDriverIn(root);
      await next.start();
      try {
        expect(alive(earlier)).toBe(false);
      } finally {
        await next.stop();
      }
    } finally {
      try {
        process.kill(-orphanProxy, 'SIGKILL');
      } catch {}
      try {
        process.kill(earlier, 'SIGKILL');
      } catch {}
    }
  });
});
