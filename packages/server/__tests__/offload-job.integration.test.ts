import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSecret, newSecret } from '@stim-cli/core/noise-session';
import { stimBuildId, type Endpoint, type MachineCredential } from '@stim-cli/core/state';
import { startServer, type RunningServer } from '../src/server.ts';
import { readBuildClients, revokeDevice, storeSetupSecret } from '../src/registry.ts';
import { BuildConnection } from '../../stim-cli/src/offload/client.ts';
import { reachMachine, realIo } from '../../stim-cli/src/offload/tailnet.ts';
import { removeTree } from '../../stim-cli/src/engine-store/tree.ts';

const stimPackage = fileURLToPath(new URL('../../stim-cli/', import.meta.url));
const stimCli = join(stimPackage, 'dist', 'cli.mjs');
const { version } = JSON.parse(readFileSync(join(stimPackage, 'package.json'), 'utf8'));

let home: string;
let server: RunningServer | null = null;
let port = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-job-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('STIM_ENGINE_ROOT', join(home, 'engine'));
  vi.stubEnv('STIM_ACCESS_TICKET', undefined);
});

afterEach(async () => {
  await server?.close();
  server = null;
  vi.unstubAllEnvs();
  removeTree(home);
});

async function paired(attached = false): Promise<{ endpoint: Endpoint; credential: MachineCredential }> {
  server = await startServer({
    hosts: ['127.0.0.1'],
    port: 0,
    stimCli,
    name: 'Worker',
    attached,
    stimVersion: version,
    serverVersion: version,
    env: { ...process.env, npm_config_offline: 'false' },
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
  port = server.addresses[0]!.port;
  const endpoint = { url: `ws://127.0.0.1:${port}`, servername: 'worker', host: `127.0.0.1:${port}` };
  const ticket = newSecret();
  storeSetupSecret(decodeSecret(ticket)!, ['build'], new Date(Date.now() + 60_000).toISOString());
  const outcome = await reachMachine({
    machine: 'worker',
    access: 'build',
    endpoint,
    address: 'worker.tail1.ts.net',
    credential: {
      machine: 'worker',
      transport: 'tailscale',
      address: 'worker.tail1.ts.net',
      state: 'pending',
      requestedAt: new Date().toISOString(),
      ticket,
    },
    other: () => undefined,
    persist: () => {},
    fix: false,
    deviceName: 'Laptop',
    setupFlags: ['build'],
    serverVersion: version,
    io: realIo,
    tickets: new Map(),
  });
  if (outcome.state !== 'approved') throw new Error(`not approved: ${outcome.state}`);
  return { endpoint, credential: outcome.credential };
}

async function open(endpoint: Endpoint, credential: MachineCredential): Promise<BuildConnection> {
  const connection = await BuildConnection.open(endpoint, credential.serverKey!, 5000);
  if (!(connection instanceof BuildConnection)) throw new Error(connection.failure);
  return connection;
}

const runningJobs = async (): Promise<number> =>
  ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { busy: { builds: number } }).busy.builds;

test('an attached server refuses each offload job before starting it or accepting a package', async () => {
  const { endpoint, credential } = await paired(true);
  const connection = await open(endpoint, credential);
  const base = { stim: version, build: 'a'.repeat(12), repo: 'app' };
  for (const kind of ['offload-build', 'offload-probe']) {
    for (const payload of [{ pack: true }, { package: { name: 'stim.tgz', size: 1, sha256: 'a'.repeat(64) } }]) {
      expect(await connection.request('job.start', { ...base, kind, ...payload })).toMatchObject({
        error: { code: 'build-busy', message: expect.stringContaining('stim serve') },
      });
    }
  }
  expect(await runningJobs()).toBe(0);
  expect(existsSync(join(home, 'engine'))).toBe(false);
  connection.close();
});

test('job.start runs the running build as __job: frames pass both ways, EOF and SIGTERM end the job', async () => {
  const { endpoint, credential } = await paired();
  const connection = await open(endpoint, credential);
  expect(await connection.startJob('offload-build', 'app', false)).toBeNull();
  const offer = await connection.request('build.offer', { repo: 'app' }, 60_000);
  expect(offer).toMatchObject({ result: { capacity: { running: 0 }, warm: { checkout: false } } });
  expect(await connection.request('build.attach', { job: 'none' })).toMatchObject({
    error: { code: 'bad-request', message: 'No such build job for this device; it ended or was cancelled.' },
  });
  const big = 'x'.repeat(40_000);
  expect(await connection.request('build.cancel', { job: big })).toMatchObject({ error: { code: 'bad-request' } });
  expect(await runningJobs()).toBe(1);
  connection.close();
  await vi.waitFor(async () => expect(await runningJobs()).toBe(0), { timeout: 10_000 });

  const dropped = await open(endpoint, credential);
  expect(await dropped.startJob('offload-build', 'app', false)).toBeNull();
  const job = dropped.job!;
  dropped.drop();
  const again = await open(endpoint, credential);
  expect(await again.attachJob(job)).toMatchObject({ result: { job } });
  expect(await again.request('build.offer', { repo: 'app' }, 60_000)).toHaveProperty('result.capacity');
  revokeDevice(readBuildClients()[0]!.id);
  await vi.waitFor(() => expect(again.failure).not.toBeNull(), { timeout: 10_000 });
  await vi.waitFor(async () => expect(await runningJobs()).toBe(0), { timeout: 10_000 });
}, 120_000);

test('a probe job answers only build.offer', async () => {
  const { endpoint, credential } = await paired();
  const connection = await open(endpoint, credential);
  expect(await connection.startJob('offload-probe', 'app', false)).toBeNull();
  expect(await connection.request('build.sync', { repo: 'app', files: [], done: true })).toMatchObject({
    error: { code: 'unknown-method' },
  });
  expect(await connection.request('build.offer', { repo: 'app' }, 60_000)).toHaveProperty('result.toolchain');
  connection.close();
}, 120_000);

test('a build the worker lacks runs from the packed tarball only under server.acceptClientBuilds', async () => {
  const { endpoint, credential } = await paired();
  const copy = join(home, 'checkout');
  for (const entry of ['package.json', 'bin', 'dist', 'shim', 'skill', 'README.md', 'LICENSE'])
    cpSync(join(stimPackage, entry), join(copy, entry), { recursive: true });
  writeFileSync(join(copy, 'dist', 'zz-job-test.mjs'), 'export {};\n');
  const build = stimBuildId(join(copy, 'dist'))!;
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', home], { cwd: copy, stdio: 'ignore' });
  const name = readdirSync(home).find((each) => each.endsWith('.tgz'))!;
  const bytes = readFileSync(join(home, name));
  const pack = { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const base = { kind: 'offload-probe', stim: version, build, repo: 'app' };

  const connection = await open(endpoint, credential);
  expect(await connection.request('job.start', { ...base, pack: true })).toMatchObject({
    error: {
      code: 'forbidden',
      message:
        'This machine takes only published Stim builds. To take this build, run stim settings set server.acceptClientBuilds true on it.',
    },
  });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ server: { acceptClientBuilds: true } }));
  expect(await connection.request('job.start', { ...base, pack: true })).toMatchObject({
    error: { code: 'job-needs-package' },
  });
  const asked = await connection.request('job.start', { ...base, package: pack });
  const upload = (asked as { result: { upload: string } }).result.upload;
  for (let offset = 0; offset < bytes.length; offset += 60 * 1024)
    await connection.sendBinary(bytes.subarray(offset, offset + 60 * 1024));
  const reply = await connection.request('job.start', { ...base, upload }, 600_000);
  expect(reply).toHaveProperty('result.job');
  expect(readFileSync(join(home, 'engine', build, '.stim-manifest.json'), 'utf8')).toContain(`"build": "${build}"`);
  expect(await connection.request('build.offer', { repo: 'app' }, 60_000)).toHaveProperty('result.toolchain');
  connection.close();
}, 660_000);
