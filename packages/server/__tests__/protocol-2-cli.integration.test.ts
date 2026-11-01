import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateNoiseKeyPair } from '@stim-cli/core/noise';
import { decodeSecret, initiateNoise, newSecret } from '@stim-cli/core/noise-session';
import { clientIdentity, isJsonObject } from '@stim-cli/core/state';
import { WebSocket } from 'ws';
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
    // The last test asks for device-host access, which the server grants only on a Mac unless told it hosts devices.
    hostsDevices: true,
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
    other: () => undefined,
    persist: () => {},
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

  expect(await reachMachine(input(endpoint, pending))).toMatchObject({ state: 'approved' });
  expect(readBuildClients()).toHaveLength(1);
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

test('authenticated Gradle artifact queries reuse completed bytes and refuse changed private inputs without another compile', async () => {
  const privateInput = join(home, 'worker-private-input');
  const counter = join(home, 'compiles');
  writeFileSync(privateInput, 'first');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: { maxLoadPerCore: 100_000 } }));
  writeFileSync(
    join(home, 'offload-worker.mjs'),
    `
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === 'offer-native-gradle') {
  console.log(JSON.stringify({ stimBuild: 'fixture', arch: process.arch, jdk: '21', androidSdk: {} }));
} else {
  let text = '';
  for await (const part of process.stdin) text += part;
  const input = JSON.parse(text);
  const receipt = input.receipt ?? { source: input.native.sourceDigest };
  const hash = createHash('sha256').update(receipt.source).update(readFileSync(${JSON.stringify(privateInput)})).digest('hex');
  const identity = { hash, key: hash + '-android' };
  if (process.argv[2] === 'native-gradle-artifact') console.log(JSON.stringify({ identity }));
  else {
    appendFileSync(${JSON.stringify(counter)}, 'compile\\n');
    const bytes = Buffer.from('completed native archive');
    const out = join(input.area, 'out', input.job);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'app.tgz'), bytes);
    console.log(JSON.stringify({ type: 'result', ok: true, fingerprint: null,
      sourceDigest: input.native.sourceDigest, androidPackage: 'dev.example.sample',
      cacheArtifact: { identity, receipt }, artifact: { name: 'Sample.apk', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }, timings: {} }));
  }
}
`,
  );
  const endpoint = await start();
  const ticket = newSecret();
  storeSetupSecret(decodeSecret(ticket)!, ['build'], new Date(Date.now() + 60_000).toISOString());
  const paired = await reachMachine(
    input(endpoint, {
      machine: 'worker',
      transport: 'tailscale',
      address: 'worker.tail1.ts.net',
      state: 'pending',
      requestedAt: new Date().toISOString(),
      ticket,
    }),
  );
  if (paired.state !== 'approved') throw new Error(`Pairing failed: ${paired.state}`);
  const connection = await BuildConnection.open(endpoint, paired.credential.serverKey!, 5000);
  if (!(connection instanceof BuildConnection)) throw new Error(connection.failure);
  try {
    expect(connection.supports('native-gradle-peer-cache')).toBe(true);
    const query = {
      project: '',
      sourceDigest: 'a'.repeat(64),
      inputs: { complete: true, ignored: [], outputs: ['build'] },
      android: { variant: 'debug', abi: null, compilerCache: 'none', gradleBuildCache: true, pch: 'auto' },
    };
    const params = { repo: 'app-1', native: 'gradle', gradleArtifact: query };
    expect(await connection.request('build.offer', params, 5000)).toHaveProperty('result.artifact', null);
    expect(await connection.request('build.sync', { repo: 'app-1', files: [], done: true }, 5000)).toHaveProperty(
      'result',
    );
    let outcome: unknown;
    connection.onProgress((event) => {
      if (event.outcome) outcome = event.outcome;
    });
    expect(
      await connection.request(
        'build.start',
        {
          repo: 'app-1',
          project: '',
          platform: 'android',
          fingerprint: null,
          stimBuild: 'fixture',
          isExpo: false,
          native: {
            provider: 'gradle',
            sourceDigest: query.sourceDigest,
            inputs: query.inputs,
            cache: { read: true, write: true, remote: true },
          },
          android: query.android,
        },
        5000,
      ),
    ).toHaveProperty('result.job');
    await vi.waitFor(() => expect(outcome).toMatchObject({ ok: true, fingerprint: null }), { timeout: 5000 });
    const offered = await connection.request('build.offer', params, 5000);
    if (!('result' in offered) || !isJsonObject(offered.result) || !isJsonObject(offered.result.artifact))
      throw new Error('No completed artifact offer');
    const artifact = offered.result.artifact;
    expect(artifact).toMatchObject({ name: 'Sample.apk', androidPackage: 'dev.example.sample' });
    expect(JSON.stringify(offered)).not.toContain(privateInput);
    const frames: Buffer[] = [];
    connection.onBinary((frame) => frames.push(frame));
    const fetch = {
      repo: 'app-1',
      artifact: { fingerprint: artifact.fingerprint, cacheKey: artifact.cacheKey },
      gradleArtifact: query,
    };
    expect(await connection.request('build.cached-artifact', fetch, 5000)).toHaveProperty('result', artifact);
    const bytes = Buffer.concat(frames.map((frame) => frame.subarray(32)));
    expect(bytes.toString()).toBe('completed native archive');
    expect(frames[0]?.subarray(0, 32).toString('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    frames.length = 0;
    writeFileSync(privateInput, 'changed');
    expect(await connection.request('build.cached-artifact', fetch, 5000)).toHaveProperty('result', null);
    expect(await connection.request('build.offer', params, 5000)).toHaveProperty('result.artifact', null);
    expect(frames).toEqual([]);
    expect(readFileSync(counter, 'utf8')).toBe('compile\n');
  } finally {
    connection.close();
  }
}, 20_000);

test('a client that lost the reply to its first contact gets its approval on retry, and no other key can', async () => {
  const endpoint = await start();
  const ticket = newSecret();
  storeSetupSecret(decodeSecret(ticket)!, ['build', 'device-host'], new Date(Date.now() + 60_000).toISOString());
  const raw = new WebSocket(endpoint.url);
  await new Promise((resolve) => raw.once('open', resolve));
  const spent = await initiateNoise(raw, {
    keyPair: clientIdentity(),
    secret: decodeSecret(ticket)!,
    name: 'Laptop',
    timeoutMs: 5000,
  });
  await vi.waitFor(() => expect(readBuildClients()).toHaveLength(1));
  spent.terminate();

  const stranger = new WebSocket(endpoint.url);
  await new Promise((resolve) => stranger.once('open', resolve));
  const refused = new Promise<string>((resolve) =>
    stranger.once('close', (_code, reason) => resolve(reason.toString())),
  );
  await initiateNoise(stranger, { keyPair: generateNoiseKeyPair(), secret: decodeSecret(ticket)!, timeoutMs: 5000 });
  expect(await refused).toBe('unknown-secret');

  const pending = {
    machine: 'worker',
    transport: 'tailscale',
    address: 'worker.tail1.ts.net',
    state: 'pending',
    requestedAt: new Date().toISOString(),
    ticket,
  } as const;
  const build = await reachMachine(input(endpoint, pending));
  expect(build).toMatchObject({ state: 'approved', credential: { deviceId: readBuildClients()[0]!.id } });
  expect(await reachMachine({ ...input(endpoint, pending), access: 'device-host' })).toMatchObject({
    state: 'approved',
  });
  expect(readBuildClients()).toHaveLength(1);
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
