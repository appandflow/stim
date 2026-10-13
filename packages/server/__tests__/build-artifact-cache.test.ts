import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildArtifactCache } from '../src/build-artifact-cache.ts';
import { BuildHost } from '../src/build.ts';
import type { WebSocket } from 'ws';

const identity = { fingerprint: 'source', cacheKey: 'source-xcode-sdk-arch-target' };
const signal = () => new AbortController().signal;
const descriptor = (bytes: string) => ({
  name: 'Sample.app',
  size: Buffer.byteLength(bytes),
  sha256: createHash('sha256').update(bytes).digest('hex'),
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stim-peer-cache-'));
  vi.stubEnv('STIM_HOME', join(root, 'home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

test('only exact verified archives are reusable; corruption or pruning is a miss', async () => {
  const directory = join(root, 'catalog');
  const cache = new BuildArtifactCache(directory);
  const source = join(root, 'archive');
  await writeFile(source, 'verified');
  const artifact = descriptor('verified');
  await cache.store(identity, { sdk: '27', arch: 'arm64' }, source, artifact, signal());
  expect(await cache.lookup({ ...identity, cacheKey: 'other-target' }, signal())).toBeNull();
  const fetched = await cache.fetch(identity, join(root, 'download'), signal());
  if (!fetched) throw new Error('Expected a verified cached archive');
  expect(await readFile(fetched.path, 'utf8')).toBe('verified');
  const filename = (await readdir(join(directory, 'files')))[0];
  if (!filename) throw new Error('Expected a stored archive');
  await writeFile(join(directory, 'files', filename), 'corrupt!');
  expect(await cache.fetch(identity, join(root, 'corrupt-download'), signal())).toBeNull();
  expect(await readdir(join(root, 'corrupt-download'))).toEqual([]);
  await cache.store(identity, {}, source, artifact, signal());
  expect(await cache.fetch(identity, join(root, 'repaired'), signal())).not.toBeNull();
  await rm(join(directory, 'files', filename));
  expect(await cache.lookup(identity, signal())).toBeNull();
  await cache.store(identity, {}, source, descriptor('different'), signal());
  expect(await cache.lookup(identity, signal())).toBeNull();
  await expect(cache.fetch(identity, root, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
});

test('a completed worker archive survives job cleanup, is client/repository scoped and streams while builds are refused', async () => {
  const worker = join(root, 'worker.mjs');
  await writeFile(
    worker,
    `
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] !== 'build') {
  console.log(JSON.stringify({ stimBuild: 'b1', arch: 'arm64', xcode: 'Xcode 27', simulatorSdk: '27', runtimes: ['iOS-27-0'] }));
} else {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const job = JSON.parse(text);
  const output = join(job.area, 'out', job.job);
  mkdirSync(output, { recursive: true });
  const bytes = 'verified archive';
  writeFileSync(join(output, 'app.tgz'), bytes);
  console.log(JSON.stringify({ type: 'result', ok: true, fingerprint: job.expectedFingerprint, sourceDigest: job.native.sourceDigest,
    artifact: { name: 'Sample.app', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, compilationCache: {}, timings: {} }));
}
`,
  );
  await mkdir(join(root, 'home'), { recursive: true });
  await writeFile(join(root, 'home', 'config.json'), JSON.stringify({ server: { maxLoadPerCore: 100_000 } }));
  const host = new BuildHost({ worker, env: process.env });
  const frames: Buffer[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (frame: Buffer) => frames.push(frame),
  } as unknown as WebSocket;
  const session = host.session('builder', socket, () => {});
  try {
    const job = host.launch({
      client: 'builder',
      repo: 'app-1',
      session,
      send: () => {},
      job: {
        platform: 'ios',
        expectedFingerprint: identity.fingerprint,
        native: {
          provider: 'xcode',
          sourceDigest: 'a'.repeat(64),
          cacheKey: identity.cacheKey,
          parameters: { sdk: '27' },
        },
      },
    });
    if ('error' in job) throw new Error(job.error.message);
    await job.done;
    host.forget(job);
    await rm(join(host.clientDir('builder'), 'repos', 'app-1', 'out'), { recursive: true, force: true });
    host.drain('maintenance');
    const artifact = descriptor('verified archive');
    expect(await host.offer('builder', { repo: 'app-1', native: 'xcode', artifact: identity })).toMatchObject({
      result: { artifact: { ...identity, ...artifact }, capacity: { declined: 'maintenance' } },
    });
    expect(await host.offer('other-client', { repo: 'app-1', native: 'xcode', artifact: identity })).toHaveProperty(
      'result.artifact',
      null,
    );
    expect(await host.offer('builder', { repo: 'other-repo', native: 'xcode', artifact: identity })).toHaveProperty(
      'result.artifact',
      null,
    );
    expect(await session.cachedArtifact({ repo: 'app-1', artifact: identity })).toEqual({
      result: { ...identity, ...artifact },
    });
    expect(Buffer.concat(frames.map((frame) => frame.subarray(32))).toString()).toBe('verified archive');
    expect(host.running()).toBe(0);
    expect(await session.cachedArtifact({ repo: '../outside', artifact: identity })).toHaveProperty(
      'error.code',
      'bad-request',
    );
    expect(await session.cachedArtifact({ repo: 'app-1', artifact: { ...identity, fingerprint: 'changed' } })).toEqual({
      result: null,
    });
    await host.remove('builder');
    expect(await session.cachedArtifact({ repo: 'app-1', artifact: identity })).toEqual({ result: null });
  } finally {
    session.close(false);
    await host.close();
  }
});
