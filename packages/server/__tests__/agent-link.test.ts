import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect as connectNet, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentRoute, newAgentToken, type HostedAgentApp, type HostedAgentDriver } from '@stim-cli/agent-driver';
import { secretValues, newSecret } from '@stim-cli/core/noise-session';
import {
  clientIdentity,
  deviceHostMachinesFile,
  isJsonObject,
  readHostedSessions,
  type HostedAgentIssuedGrant,
} from '@stim-cli/core/state';
import { startServer, type RunningServer } from '../src/server.ts';
import { revokeDevice, serverIdentity, spendSecret, storeSetupSecret } from '../src/registry.ts';
import { noiseConnect, setupClient, terminateClients } from './noise-client.ts';
import { BuildConnection } from '../../stim-cli/src/offload/client.ts';
import { hostConnector } from '../../stim-cli/src/device-host/hosted-client.ts';
import { openAgentRelay, type AgentRelay } from '../../stim-cli/src/supervisor/agent-relay.ts';

class FakeDriver implements HostedAgentDriver {
  readonly name = 'agent-device';
  forwarded: string[] = [];
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  issue(app: HostedAgentApp): Promise<HostedAgentIssuedGrant> {
    return Promise.resolve({
      driver: 'agent-device',
      path: agentRoute(app.session),
      token: newAgentToken(),
      scope: `lease-${app.session.slice(0, 8)}`,
      lease: {
        tenant: `stim.${app.session}`,
        runId: app.session,
        clientId: 'agent',
        deviceKey: `ios:mobile:${app.udid}`,
        backend: 'ios-instance',
      },
    });
  }
  revoke(): Promise<void> {
    return Promise.resolve();
  }
  forward(session: string, request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      this.forwarded.push(session);
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ session, url: request.url, bytes: Buffer.concat(chunks).length }));
    });
  }
  onExit(): void {}
}

const agents = vi.hoisted(() => {
  const state: { driver: HostedAgentDriver | null } = { driver: null };
  return state;
});
vi.mock('../src/agent-drivers.ts', async (original) => ({
  ...(await original<typeof import('../src/agent-drivers.ts')>()),
  configuredAgentDriver: () => Promise.resolve(agents.driver),
  stoppingAgentDriver: () => Promise.resolve(agents.driver),
}));

let home: string;
let server: RunningServer | null = null;
const relays: AgentRelay[] = [];
const connections: BuildConnection[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-agent-link-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_ACCESS_TICKET', undefined);
});

afterEach(async () => {
  for (const relay of relays.splice(0)) relay.close();
  for (const connection of connections.splice(0)) connection.close();
  terminateClients();
  await server?.close();
  server = null;
  agents.driver = null;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function start(extra: Partial<Parameters<typeof startServer>[0]> = {}): Promise<number> {
  const stimCli = join(home, 'fake-stim.mjs');
  writeFileSync(stimCli, '');
  writeFileSync(
    join(home, 'device-host-worker.mjs'),
    `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks));
    const device={udid:'12345678-1234-1234-1234-123456789abc',name:'stim-hosted',deviceTypeId:'iphone',runtimeId:'ios',deviceType:'iPhone',runtime:'27.1',architecture:'arm64'};
    writeFileSync(join(process.env.STIM_HOME,'hosted-device.json'),JSON.stringify(device));
    writeFileSync(join(process.env.STIM_HOME,'created-devices.json'),JSON.stringify({version:1,ios:[device.udid],android:[],web:[]}));
    process.stdout.write(JSON.stringify({state:input.mode==='prepare'?'ready':input.mode==='install'?'installed':'stopped',device,...(input.mode==='install'?{launched:'unverified'}:{})}));
  `,
  );
  server = await startServer({
    hosts: ['127.0.0.1'],
    port: 0,
    localSocket: null,
    stimCli,
    name: 'Worker',
    stimVersion: '9.9.9',
    serverVersion: '1.2.3',
    env: { ...process.env, ...extra.env },
    hostsDevices: true,
    tailscale: null,
    tailscaleState: { state: 'not-running', backendState: 'Stopped' },
    statusAtBoot: false,
    record: false,
    history: false,
    frameHelper: null,
    pushEndpoint: 'http://127.0.0.1:9/push',
    pullRequests: async () => new Map(),
    ...extra,
    env: { ...process.env, ...extra.env },
  });
  await server.ready;
  const [address] = server.addresses;
  if (!address) throw new Error('the server is not listening');
  return address.port;
}

function approveLocalMachine(port: number): { machine: string; client: string } {
  const machine = `local:127.0.0.1:${port}`;
  const ticket = Buffer.from(newSecret(), 'base64url');
  storeSetupSecret(ticket, ['device-host'], new Date(Date.now() + 60_000).toISOString());
  const records = spendSecret(
    secretValues(ticket).lookup.toString('hex'),
    clientIdentity().publicKey.toString('base64url'),
    'Laptop',
    'test',
  );
  const client = records?.['device-host']?.id;
  if (!client) throw new Error('the client was not approved');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ remote: { machines: [machine] } }));
  writeFileSync(
    deviceHostMachinesFile(),
    JSON.stringify({
      version: 2,
      machines: [
        {
          machine,
          transport: 'local',
          address: '127.0.0.1',
          state: 'approved',
          requestedAt: new Date().toISOString(),
          serverKey: serverIdentity().publicKey.toString('base64url'),
          deviceId: client,
        },
      ],
    }),
  );
  return { machine, client };
}

async function call(connection: BuildConnection, method: string, params: unknown): Promise<unknown> {
  const reply = await connection.request(method, params, 10_000);
  if ('error' in reply) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
}

async function hostedApp(machine: string): Promise<{ session: string; token: string }> {
  const connection = await hostConnector(machine)();
  connections.push(connection);
  const reserved = await call(connection, 'device-host.reserve', {
    workspace: '/client/app',
    slot: 'default',
    platform: 'ios',
    attempt: randomUUID(),
  });
  const session = isJsonObject(reserved) && typeof reserved.id === 'string' ? reserved.id : '';
  await vi.waitFor(() => expect(readHostedSessions()[0]?.state).toBe('ready'), { timeout: 10_000 });
  await call(connection, 'device-host.metro.open', { session });
  const content = Buffer.from('plist');
  const digest = createHash('sha256').update(content).digest('hex');
  const manifest = Buffer.from(
    JSON.stringify([{ path: 'Info.plist', kind: 'file', size: content.length, sha256: digest }]),
  );
  const manifestDigest = createHash('sha256').update(manifest).digest('hex');
  const app = { session, attempt: randomUUID() };
  await call(connection, 'device-host.app.offer', {
    ...app,
    bundleId: 'dev.stim.fixture',
    mode: 'development',
    manifest: { sha256: manifestDigest, size: manifest.length },
  });
  const parts: [string, Buffer][] = [
    [manifestDigest, manifest],
    [digest, content],
  ];
  for (const [sha256, bytes] of parts)
    await call(connection, 'device-host.app.chunk', { ...app, sha256, offset: 0, data: bytes.toString('base64') });
  await call(connection, 'device-host.app.launch', app);
  let token = '';
  await vi.waitFor(
    async () => {
      const delivery = await call(connection, 'device-host.app.attach', app);
      expect(delivery).toHaveProperty('state', 'installed');
      token = isJsonObject(delivery) && isJsonObject(delivery.agent) ? String(delivery.agent.token ?? '') : '';
      expect(token).not.toBe('');
    },
    { timeout: 10_000 },
  );
  return { session, token };
}

async function relayed(relay: AgentRelay, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${await relay.port}${path}`, {
    method: 'POST',
    body: 'x'.repeat(100_000),
    headers,
  });
  return { status: response.status, body: await response.text() };
}

test('a local network client drives its own hosted session through the loopback relay with its agent token', async () => {
  const driver = new FakeDriver();
  agents.driver = driver;
  const port = await start();
  const { machine } = approveLocalMachine(port);
  const { session, token } = await hostedApp(machine);
  const relay = openAgentRelay({ machine, session });
  relays.push(relay);
  const route = `${agentRoute(session)}rpc`;
  const auth = { authorization: `Bearer ${token}` };

  for (let attempt = 0; attempt < 2; attempt++)
    expect(await relayed(relay, route, auth)).toEqual({
      status: 200,
      body: JSON.stringify({ session, url: route, bytes: 100_000 }),
    });
  expect(await relayed(relay, route)).toEqual({ status: 403, body: 'Forbidden.\n' });
  expect(await relayed(relay, route, { authorization: `Bearer ${token}`, origin: 'http://attacker.example' })).toEqual({
    status: 403,
    body: 'Forbidden.\n',
  });
  expect(await relayed(relay, `${agentRoute(randomUUID())}rpc`, auth)).toEqual({
    status: 403,
    body: 'Forbidden. This agent link carries another hosted session.\n',
  });

  const direct = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: auth });
  expect(direct.status).toBe(403);
  expect(await direct.text()).toBe('Forbidden. The server could not identify the requesting tailnet node.\n');
  expect(driver.forwarded).toEqual([session, session]);
}, 30_000);

test('the host links only the authenticated client own session, and stops relaying once the client is revoked', async () => {
  const driver = new FakeDriver();
  agents.driver = driver;
  const port = await start();
  const { machine, client } = approveLocalMachine(port);
  const { session, token } = await hostedApp(machine);

  const other = await noiseConnect(`ws://127.0.0.1:${port}`, {
    keyPair: setupClient(['device-host'], 'Other').keyPair,
  });
  expect(
    await other.request('hello', { client: { name: 'other', version: '1' }, access: 'device-host' }),
  ).toHaveProperty('result.capabilities', ['device-host']);
  expect(await other.request('device-host.agent.link', { session })).toHaveProperty('error.code', 'unknown-session');

  const linked = [];
  for (let index = 0; index <= 16; index++) {
    const link = await noiseConnect(`ws://127.0.0.1:${port}`, { keyPair: clientIdentity() });
    await link.request('hello', { client: { name: 'stim', version: '1' }, access: 'device-host' });
    expect(await link.request('device-host.agent.link', { session })).toHaveProperty('result', {});
    linked.push(link);
  }
  expect(await linked[0]?.closed).toBe(1000);
  for (const link of linked.slice(1)) link.socket.close();

  const unknown = openAgentRelay({ machine, session: randomUUID() });
  relays.push(unknown);
  const refused = await relayed(unknown, `${agentRoute(session)}rpc`, { authorization: `Bearer ${token}` });
  expect(refused.status).toBe(502);
  expect(refused.body).toContain(`${machine} refused the agent link: This client has no hosted session`);

  const relay = openAgentRelay({ machine, session });
  relays.push(relay);
  expect(revokeDevice(client)).toBe(true);
  const revoked = await relayed(relay, `${agentRoute(session)}rpc`, { authorization: `Bearer ${token}` });
  expect(revoked.status).toBe(502);
  expect(revoked.body).toContain(machine);
  expect(driver.forwarded).toEqual([]);
}, 30_000);

test('the relay holds at most 8 local connections, and stopping the session closes its open agent links', async () => {
  agents.driver = new FakeDriver();
  const port = await start();
  const { machine } = approveLocalMachine(port);
  const { session } = await hostedApp(machine);
  const relay = openAgentRelay({ machine, session });
  relays.push(relay);
  const relayPort = await relay.port;
  const local: Socket[] = [];
  for (let index = 0; index < 8; index++) {
    const socket = connectNet(relayPort, '127.0.0.1');
    await once(socket, 'connect');
    local.push(socket);
  }
  const excess = connectNet(relayPort, '127.0.0.1');
  await once(excess, 'close');
  expect(local.some((socket) => socket.destroyed)).toBe(false);
  for (const socket of local) socket.destroy();

  const link = await noiseConnect(`ws://127.0.0.1:${port}`, { keyPair: clientIdentity() });
  await link.request('hello', { client: { name: 'stim', version: '1' }, access: 'device-host' });
  expect(await link.request('device-host.agent.link', { session })).toHaveProperty('result', {});
  const [connection] = connections;
  if (!connection) throw new Error('no hosted connection');
  await call(connection, 'device-host.stop', { session });
  expect(await link.closed).toBe(1000);
}, 30_000);

test('a hosted session stays ready while its client only holds an agent link, and is stopped once that link is gone', async () => {
  agents.driver = new FakeDriver();
  const port = await start({
    env: { STIM_MAINTENANCE: 'on', STIM_MAINTENANCE_IDLE_STOP_HOURS: '0.0002' },
    hostedIdleSweepMs: 50,
  });
  const { machine } = approveLocalMachine(port);
  const { session } = await hostedApp(machine);
  const link = await noiseConnect(`ws://127.0.0.1:${port}`, { keyPair: clientIdentity() });
  await link.request('hello', { client: { name: 'stim', version: '1' }, access: 'device-host' });
  expect(await link.request('device-host.agent.link', { session })).toHaveProperty('result', {});
  for (const connection of connections.splice(0)) connection.close();

  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(readHostedSessions().find((record) => record.id === session)).toMatchObject({ state: 'ready' });

  link.socket.close();
  await vi.waitFor(() => expect(readHostedSessions().find((record) => record.id === session)?.state).toBe('stopped'), {
    timeout: 15_000,
  });
  expect(readHostedSessions().find((record) => record.id === session)?.idleStop).toBeDefined();
}, 30_000);
