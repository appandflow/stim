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
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { inspectProcessIdentity, captureProcessIdentity } from '@stim-cli/core/process-identity';
import { AgentDeviceDriver, resolveAgentDevice } from '../src/agent-device-driver.ts';
import { AgentDriverUnavailable } from '../src/agent-driver.ts';

const FAKE_AGENT_DEVICE = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
if (args[0] === 'proxy' && process.env.FAKE_PROXY === 'daemon-only') {
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  daemon.unref();
  writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({ pid: daemon.pid }));
  setInterval(() => {}, 1000);
} else if (args[0] === 'proxy' && process.env.FAKE_PROXY === 'silent') {
  setInterval(() => {}, 1000);
} else if (args[0] === 'proxy') {
  const code = (process.env.FAKE_DAEMON === 'stubborn' ? "process.on('SIGTERM', () => {});" : '') + 'setInterval(() => {}, 1000)';
  const daemon = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  daemon.unref();
  writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({ pid: daemon.pid, httpPort: 1, token: 'daemon-secret' }));
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const authorized = request.headers.authorization === 'Bearer ' + process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
      response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ authorized, method: request.method, url: request.url, body: Buffer.concat(chunks).toString(), seen: Object.keys(request.headers) }));
    });
  });
  server.listen(0, '127.0.0.1', () => console.log('Proxy listening at http://127.0.0.1:' + server.address().port));
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
    env: { HOME: home, PATH: '/usr/bin:/bin', ...env },
    stateDir: join(home, 'state'),
    claimRoot: join(home, 'agent-device.claims'),
    scopedMacosLease: true,
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
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
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
            resolve({ status: answer.statusCode ?? 0, text });
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

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('agent-device driver', () => {
  test('ships disabled until agent-device can lease one macOS app', async () => {
    install(root);
    const driver = new AgentDeviceDriver({
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      stateDir: join(root, 'state'),
      claimRoot: join(root, 'agent-device.claims'),
    });
    await expect(driver.start()).rejects.toThrow(AgentDriverUnavailable);
    await expect(driver.start()).rejects.toThrow(/Stim never hands a client the hosting Mac desktop/);
    expect(existsSync(join(root, 'state'))).toBe(false);
    await expect(driver.issue({ client: 'c', session: SESSION, bundleId: 'dev.example.app', pid: 5 })).rejects.toThrow(
      AgentDriverUnavailable,
    );
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
      const answer = await through(driver, SESSION, 'POST', '/rpc?x=1', '{"method":"snapshot"}', {
        authorization: 'Bearer client-grant-token',
        'x-agent-device-token': 'client-grant-token',
        'content-type': 'application/json',
        cookie: 'a=b',
      });
      expect(answer.status).toBe(200);
      const seen = JSON.parse(answer.text) as Record<string, unknown>;
      expect(seen).toMatchObject({ authorized: true, method: 'POST', url: '/rpc?x=1', body: '{"method":"snapshot"}' });
      expect(seen.seen).not.toContain('x-agent-device-token');
      expect(seen.seen).not.toContain('cookie');
      expect(answer.text).not.toContain('client-grant-token');
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
      expect((await through(driver, SESSION, 'GET', '/health')).status).toBe(200);
      expect((await through(driver, SESSION, 'GET', '/admin/human-control/holds')).status).toBe(404);
      expect((await through(driver, SESSION, 'GET', '/rpc/../admin')).status).toBe(404);
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
