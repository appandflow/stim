import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateNoiseKeyPair } from '@stim-cli/core/noise';
import { decodeSecret, newSecret } from '@stim-cli/core/noise-session';
import type { Endpoint, MachineCredential } from '@stim-cli/core/state';
import { startServer, type RunningServer } from '../src/server.ts';
import { readBuildClients, revokeDevice, serverIdentity, storeSetupSecret } from '../src/registry.ts';
import { BuildConnection } from '../../stim-cli/src/offload/client.ts';
import { reachMachine, realIo, type AccessInput } from '../../stim-cli/src/offload/tailnet.ts';

let home: string;
let server: RunningServer | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-p2-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_ACCESS_TICKET', undefined);
});

afterEach(async () => {
  await server?.close();
  server = null;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function start(): Promise<Endpoint> {
  const stimCli = join(home, 'fake-stim.mjs');
  writeFileSync(stimCli, '');
  server = await startServer({
    hosts: ['127.0.0.1'],
    port: 0,
    localSocket: null,
    stimCli,
    name: 'Worker',
    stimVersion: '9.9.9',
    serverVersion: '1.2.3',
    env: { ...process.env },
    tailscale: null,
    tailscaleState: { state: 'not-running', backendState: 'Stopped' },
    statusAtBoot: false,
    record: false,
    history: false,
    frameHelper: null,
    pushEndpoint: 'http://127.0.0.1:9/push',
    pullRequests: async () => new Map(),
  });
  await server.ready;
  const port = server.addresses[0]!.port;
  return { url: `ws://127.0.0.1:${port}`, servername: 'worker', host: `127.0.0.1:${port}` };
}

function input(endpoint: Endpoint, credential: MachineCredential | undefined, fix = false): AccessInput {
  return {
    machine: 'worker',
    access: 'build',
    endpoint,
    address: 'worker.tail1.ts.net',
    credential,
    other: undefined,
    fix,
    deviceName: 'Laptop',
    setupFlags: ['build'],
    serverVersion: '1.2.3',
    io: realIo,
    tickets: new Map(),
  };
}

test('the CLI pairs with a real stim-server through its setup ticket, pins its key and reconnects with it', async () => {
  const endpoint = await start();
  const ticket = newSecret();
  const pending = {
    machine: 'worker',
    transport: 'tailscale',
    address: 'worker.tail1.ts.net',
    state: 'pending',
    requestedAt: new Date().toISOString(),
    ticket,
  } as const;

  expect(await reachMachine(input(endpoint, pending))).toMatchObject({ state: 'pending' });

  storeSetupSecret(decodeSecret(ticket)!, ['build'], new Date(Date.now() + 60_000).toISOString());
  const paired = await reachMachine(input(endpoint, pending));
  expect(paired.state).toBe('approved');
  if (paired.state !== 'approved') return;
  expect(paired.credential.serverKey).toBe(serverIdentity().publicKey.toString('base64url'));
  const [record] = readBuildClients();
  expect(record).toMatchObject({ id: paired.credential.deviceId, name: 'Laptop', capabilities: ['build'] });

  expect(await reachMachine(input(endpoint, pending))).toMatchObject({ state: 'pending' });
  expect(await reachMachine(input(endpoint, paired.credential))).toMatchObject({ state: 'approved' });

  const connection = await BuildConnection.open(endpoint, paired.credential.serverKey!, 5000);
  expect(connection).toBeInstanceOf(BuildConnection);
  if (!(connection instanceof BuildConnection)) return;
  const reply = await connection.request('build.offer', { repo: 'x' }, 5000);
  expect(reply).not.toHaveProperty('error.code', 'closed');

  revokeDevice(record!.id);
  await vi.waitFor(() => expect(connection.failure).toContain('unauthorized'), { timeout: 3000 });
  expect(await reachMachine(input(endpoint, paired.credential))).toMatchObject({ state: 'revoked' });
});

test('the CLI refuses a stim-server that does not hold the pinned key', async () => {
  const endpoint = await start();
  const credential: MachineCredential = {
    machine: 'worker',
    transport: 'tailscale',
    address: 'worker.tail1.ts.net',
    state: 'approved',
    requestedAt: new Date().toISOString(),
    serverKey: generateNoiseKeyPair().publicKey.toString('base64url'),
    deviceId: 'ab12',
  };
  expect(await reachMachine(input(endpoint, credential))).toMatchObject({ state: 'key-changed' });
  const refused = await BuildConnection.open(endpoint, credential.serverKey!, 5000);
  expect(refused).toMatchObject({ refused: true, code: 'server-key-mismatch' });
});
