import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { inspectProcessIdentity, captureProcessIdentity } from '@stim-cli/core/process-identity';
import { AgentDeviceDriver, resolveAgentDevice } from '../src/agent-device-driver.ts';
import { AgentDriverUnavailable } from '../src/agent-driver.ts';
import { parseHostedAgentGrant } from '@stim-cli/core/state';

const FAKE_AGENT_DEVICE = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
if (args[0] === 'proxy' && process.env.FAKE_PROXY === 'daemon-only') {
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  daemon.unref();
  appendFileSync(process.env.FAKE_PIDS, daemon.pid + '\\n');
  writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({ pid: daemon.pid }));
  setInterval(() => {}, 1000);
} else if (args[0] === 'proxy' && process.env.FAKE_PROXY === 'silent') {
  setInterval(() => {}, 1000);
} else if (args[0] === 'proxy') {
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
    writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({ pid: daemon.pid, httpPort: admin.address().port, token: 'daemon-secret' }));
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
  if (!process.env.FAKE_STOP_NOOP) try { process.kill(JSON.parse(readFileSync(join(stateDir, 'daemon.json'), 'utf8')).pid, 'SIGTERM'); } catch {}
  console.log('Daemon stopped (graceful).');
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
    watchMs: 50,
    ...extra,
  });
}

function through(
  driver: AgentDeviceDriver,
  session: string,
  method: string,
  path: string,
  body?: string,
  headers = {},
) {
  const front = createServer((request, response) => driver.forward(session, request, response));
  return new Promise<{ status: number; text: string; contentType: string | undefined }>((resolve, reject) => {
    front.listen(0, '127.0.0.1', () => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port: (front.address() as AddressInfo).port,
          method,
          path: `/device-host/agent/${session}${path}`,
          headers,
        },
        (answer) => {
          let text = '';
          answer.on('data', (chunk: Buffer) => (text += chunk.toString()));
          answer.on('end', () => {
            front.closeAllConnections();
            front.close();
            resolve({ status: answer.statusCode ?? 0, text, contentType: answer.headers['content-type'] });
          });
        },
      );
      outgoing.once('error', reject);
      outgoing.end(body);
    });
  });
}

const SESSION = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-agent-device-'));
});

function isFixtureDaemon(pid: number): boolean {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes('setInterval');
  } catch {
    return false;
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
  test('refuses to start an agent-device that cannot lease one macOS app, and leaves nothing running', async () => {
    install(root);
    const driver = driverIn(root, {}, { FAKE_LEASE_BACKENDS: 'ios-instance,android-instance' });
    await expect(driver.start()).rejects.toThrow(AgentDriverUnavailable);
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
      expect(parseHostedAgentGrant(grant)).toEqual(grant);
      if (grant.driver === 'none') throw new Error('expected a grant');
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

  test('issues no grant when agent-device refuses the lease', async () => {
    install(root);
    const driver = driverIn(root, {}, { FAKE_ADMIN: 'refuse' });
    await driver.start();
    try {
      await expect(
        driver.issue({ client: 'c', session: SESSION, bundleId: 'dev.example.app.hosted1', pid: 4242 }),
      ).rejects.toThrow(/refused the lease/);
      expect((await through(driver, SESSION, 'GET', '/health')).status).toBe(503);
    } finally {
      await driver.stop();
    }
  });

  test('resolves agent-device by explicit path and runs a script under the server Node', () => {
    const real = install(root);
    expect(resolveAgentDevice({ HOME: root, PATH: '/usr/bin:/bin' })).toEqual({
      command: process.execPath,
      args: [realpathSync(real)],
    });
  });

  test('refuses with the places it looked when agent-device is missing', () => {
    expect(() => resolveAgentDevice({ HOME: root })).toThrow(
      /\.local\/bin\/agent-device.*npm install --global --prefix/s,
    );
  });

  test('uses only the agent-device that STIM_AGENT_DEVICE_BIN names when it is set', () => {
    const real = install(root);
    const elsewhere = join(root, 'other', 'agent-device.mjs');
    mkdirSync(join(root, 'other'));
    writeFileSync(elsewhere, FAKE_AGENT_DEVICE);
    expect(resolveAgentDevice({ HOME: root, STIM_AGENT_DEVICE_BIN: elsewhere })).toEqual({
      command: process.execPath,
      args: [realpathSync(elsewhere)],
    });
    expect(realpathSync(real)).not.toBe(realpathSync(elsewhere));
    expect(() => resolveAgentDevice({ HOME: root, STIM_AGENT_DEVICE_BIN: join(root, 'missing') })).toThrow(
      /STIM_AGENT_DEVICE_BIN names .*missing/,
    );
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
      if (grant.driver === 'none') throw new Error('expected a grant');
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

  test('answers 503 when no daemon runs', async () => {
    expect((await through(driverIn(root), SESSION, 'GET', '/health')).status).toBe(503);
  });

  test('reports a daemon that exits on its own and still stops cleanly afterwards', async () => {
    install(root);
    const driver = driverIn(root);
    const exited = new Promise<void>((resolve) => driver.onExit(resolve));
    await driver.start();
    const daemonPid = (JSON.parse(readFileSync(join(root, 'state', 'daemon.json'), 'utf8')) as { pid: number }).pid;
    const identity = captureProcessIdentity(daemonPid);
    process.kill(daemonPid, 'SIGKILL');
    await exited;
    await driver.stop();
    expect(inspectProcessIdentity({ pid: daemonPid, processToken: identity.ok ? identity.token : '' })).toBe('gone');
    expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(0);
    await driver.start();
    await driver.stop();
  });

  test('stops a daemon that ignores SIGTERM and one that agent-device did not stop, by recorded identity', async () => {
    install(root);
    const driver = driverIn(root, {}, { FAKE_DAEMON: 'stubborn', FAKE_STOP_NOOP: '1' });
    await driver.start();
    const daemonPid = (JSON.parse(readFileSync(join(root, 'state', 'daemon.json'), 'utf8')) as { pid: number }).pid;
    const record = {
      pid: daemonPid,
      processToken: readClaimSet(join(root, 'agent-device.claims')).live[0]!.child!.processToken,
    };
    await driver.stop();
    expect(inspectProcessIdentity(record)).toBe('gone');
    expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(0);
  }, 15_000);

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

  test('stops a daemon the proxy started even when the proxy never reports ready and daemon stop does nothing', async () => {
    install(root);
    const driver = driverIn(root, { startTimeoutMs: 500 }, { FAKE_PROXY: 'daemon-only', FAKE_STOP_NOOP: '1' });
    await expect(driver.start()).rejects.toThrow(/did not report a listening address/);
    const daemonPid = (JSON.parse(readFileSync(join(root, 'state', 'daemon.json'), 'utf8')) as { pid: number }).pid;
    await vi.waitFor(() => expect(() => process.kill(daemonPid, 0)).toThrow(/ESRCH/));
    expect(readClaimSet(join(root, 'agent-device.claims')).live).toHaveLength(0);
  });

  test('forwards only the proxy routes and keeps a bare session route to the root', async () => {
    install(root);
    const driver = driverIn(root);
    await driver.start();
    try {
      await driver.issue({ client: 'c', session: SESSION, bundleId: 'dev.example.app.hosted1', pid: 4242 });
      expect((await through(driver, SESSION, 'GET', '/health')).status).toBe(200);
      expect((await through(driver, SESSION, 'GET', '/admin/human-control/holds')).status).toBe(404);
      expect((await through(driver, SESSION, 'GET', '/admin/leases')).status).toBe(404);
      expect((await through(driver, SESSION, 'GET', '/rpc/../admin')).status).toBe(404);
      expect((await through(driver, SESSION, 'GET', '/rpc')).status).toBe(404);
      expect((await through(driver, SESSION, 'POST', '/upload', 'x')).status).toBe(404);
      expect((await through(driver, SESSION, 'GET', `/sessions/${SESSION}/requests/r1/diagnostics`)).status).toBe(404);
    } finally {
      await driver.stop();
    }
  });

  test('reports a daemon exit once even when the proxy and the watcher both notice it', async () => {
    install(root);
    const driver = driverIn(root);
    let exits = 0;
    driver.onExit(() => (exits += 1));
    await driver.start();
    const daemonPid = (JSON.parse(readFileSync(join(root, 'state', 'daemon.json'), 'utf8')) as { pid: number }).pid;
    process.kill(daemonPid, 'SIGKILL');
    await vi.waitFor(() => expect(exits).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exits).toBe(1);
    await driver.stop();
  });
});
