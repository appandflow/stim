import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildArtifactCache } from '../src/build-artifact-cache.ts';
import { BuildHost } from '../src/build.ts';
import type { WebSocket } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { captureProcessIdentity, inspectProcessIdentity } from '@stim-cli/core/process-identity';

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

test.each(['app', 'apk'])(
  'only exact verified %s archives are reusable; corruption or pruning is a miss',
  async (extension) => {
    const directory = join(root, 'catalog');
    const cache = new BuildArtifactCache(directory);
    const source = join(root, 'archive');
    await writeFile(source, 'verified');
    const artifact = {
      ...descriptor('verified'),
      name: `Sample.${extension}`,
      ...(extension === 'apk' ? { androidPackage: 'dev.example.sample' } : {}),
    };
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
  },
);

test('Gradle receipts bind completed source, project, declarations and requested options without replacing verified bytes', async () => {
  const cache = new BuildArtifactCache(join(root, 'catalog'));
  const source = join(root, 'archive');
  await writeFile(source, 'verified');
  const query = {
    project: 'app',
    sourceDigest: 'a'.repeat(64),
    inputs: { complete: true as const, ignored: ['private.properties'], outputs: ['app/build'] },
    android: {
      variant: 'debug',
      abi: null,
      compilerCache: 'none' as const,
      pch: 'auto' as const,
      gradleBuildCache: true,
    },
  };
  const receipt = {
    source: 'verified-source',
    declaration: { localFiles: ['/worker/private/signing.jks'] },
    build: query.android,
  };
  const artifact = { ...descriptor('verified'), name: 'Sample.apk', androidPackage: 'dev.example.sample' };
  await cache.storeGradle(query, identity, receipt, source, artifact, signal());
  expect(await cache.gradleReceipt(query, signal())).toEqual(receipt);
  for (const different of [
    { ...query, project: 'other' },
    { ...query, sourceDigest: 'b'.repeat(64) },
    { ...query, inputs: { ...query.inputs, outputs: ['other/build'] } },
    { ...query, android: { ...query.android, variant: 'release' } },
  ])
    expect(await cache.gradleReceipt(different, signal())).toBeNull();
  expect(await cache.lookup(identity, signal())).toEqual({ ...identity, ...artifact });
  await cache.storeGradle(
    query,
    identity,
    { source: 'unverified' },
    source,
    { ...artifact, ...descriptor('wrong'), name: 'Sample.apk' },
    signal(),
  );
  expect(await cache.gradleReceipt(query, signal())).toEqual(receipt);
  await expect(cache.gradleReceipt(query, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
});

test.each(['update', 'operator'])(
  'a completed worker archive survives cleanup and streams while %s pauses builds',
  async (pause) => {
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
      const launch = () =>
        host.launch({
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
      const job = launch();
      if ('error' in job) throw new Error(job.error.message);
      if (pause === 'operator')
        await writeFile(
          join(root, 'home', 'config.json'),
          JSON.stringify({ server: { maxLoadPerCore: 100_000, buildsPaused: true } }),
        );
      await job.done;
      host.forget(job);
      await rm(join(host.clientDir('builder'), 'repos', 'app-1', 'out'), { recursive: true, force: true });
      if (pause === 'update') host.drain('maintenance');
      const reason = pause === 'update' ? 'maintenance' : 'server.buildsPaused';
      expect(launch()).toMatchObject({ error: { code: 'build-busy', message: expect.stringContaining(reason) } });
      const artifact = descriptor('verified archive');
      expect(await host.offer('builder', { repo: 'app-1', native: 'xcode', artifact: identity })).toMatchObject({
        result: { artifact: { ...identity, ...artifact }, capacity: { declined: expect.stringContaining(reason) } },
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
      expect(
        await session.cachedArtifact({ repo: 'app-1', artifact: { ...identity, fingerprint: 'changed' } }),
      ).toEqual({
        result: null,
      });
      host.drain(null);
      await writeFile(
        join(root, 'home', 'config.json'),
        JSON.stringify({ server: { maxLoadPerCore: 100_000, buildsPaused: false, devicesPaused: true } }),
      );
      const resumed = launch();
      if ('error' in resumed) throw new Error(resumed.error.message);
      await resumed.done;
      host.forget(resumed);
      await host.remove('builder');
      expect(await session.cachedArtifact({ repo: 'app-1', artifact: identity })).toEqual({ result: null });
    } finally {
      session.close(false);
      await host.close();
    }
  },
);

async function gradleWorkerFixture() {
  const worker = join(root, 'gradle-worker.mjs');
  await writeFile(
    worker,
    `
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2];
if (mode === 'offer-native-gradle') {
  console.log(JSON.stringify({ stimBuild: 'b1', arch: process.arch, jdk: '21', androidSdk: {} }));
} else {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  const area = process.cwd();
  const privateFile = join(process.env.GRADLE_USER_HOME, 'gradle.properties');
  const environment = Object.fromEntries(['STIM_HOME', 'CP_HOME_DIR', 'CP_CACHE_DIR', 'npm_config_store_dir', 'GRADLE_USER_HOME'].map(key => [key, process.env[key]]));
  if (mode === 'build') {
    mkdirSync(process.env.GRADLE_USER_HOME, { recursive: true });
    if (!existsSync(privateFile)) writeFileSync(privateFile, 'pinned=one');
    writeFileSync(join(area, 'environment.json'), JSON.stringify(environment));
    appendFileSync(join(area, 'compiler-called'), 'compiled\\n');
  } else if (JSON.stringify(environment) !== readFileSync(join(area, 'environment.json'), 'utf8')) {
    throw new Error('The query did not inherit the original worker environment.');
  }
  const receipt = mode === 'build' ? { source: input.native.sourceDigest } : input.receipt;
  const android = input.android;
  const hash = createHash('sha256').update(JSON.stringify([receipt.source, readFileSync(privateFile, 'utf8'), android.variant, android.abi, android.compilerCache, android.pch, android.gradleBuildCache])).digest('hex');
  const identity = { hash, key: hash + '-android' };
  if (mode === 'native-gradle-artifact') {
    if (existsSync(join(area, 'hold-query'))) {
      process.on('SIGTERM', () => {});
      writeFileSync(join(area, 'query-pid.partial'), String(process.pid));
      renameSync(join(area, 'query-pid.partial'), join(area, 'query-pid'));
      setInterval(() => {}, 1000);
    } else console.log(JSON.stringify({ identity }));
  } else {
    const output = join(area, 'out', input.job);
    mkdirSync(output, { recursive: true });
    const bytes = 'verified native archive';
    writeFileSync(join(output, 'app.tgz'), bytes);
    console.log(JSON.stringify({ type: 'result', ok: true, fingerprint: null, sourceDigest: input.native.sourceDigest,
      androidPackage: 'dev.example.sample', cacheArtifact: { identity, receipt },
      artifact: { name: 'Sample.apk', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, compilationCache: {}, timings: {} }));
  }
}
`,
  );
  await mkdir(join(root, 'home'), { recursive: true });
  await writeFile(join(root, 'home', 'config.json'), JSON.stringify({ server: { maxLoadPerCore: 100_000 } }));
  let allowed = true;
  const host = new BuildHost({ worker, env: process.env, allowed: () => allowed, limits: { killGraceMs: 50 } });
  const frames: Buffer[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (frame: Buffer) => {
      frames.push(frame);
    },
  };
  const session = host.session('builder', socket, () => {});
  const query = {
    project: '',
    sourceDigest: 'a'.repeat(64),
    inputs: { complete: true as const, ignored: [], outputs: ['build'] },
    android: {
      variant: 'debug',
      abi: null,
      compilerCache: 'none' as const,
      pch: 'auto' as const,
      gradleBuildCache: true,
    },
  };
  const job = host.launch({
    client: 'builder',
    repo: 'app-1',
    session,
    send: () => {},
    job: {
      platform: 'android',
      project: query.project,
      expectedFingerprint: null,
      android: query.android,
      native: {
        provider: 'gradle',
        sourceDigest: query.sourceDigest,
        inputs: query.inputs,
        cache: { read: true, write: true, remote: true },
      },
    },
  });
  if ('error' in job) throw new Error(job.error.message);
  await job.done;
  if (!job.outcome?.ok) {
    session.close(false);
    await host.close();
    throw new Error(JSON.stringify(job.outcome));
  }
  host.forget(job);
  const area = join(host.clientDir('builder'), 'repos', 'app-1');
  await rm(join(area, 'out'), { recursive: true, force: true });
  return {
    host,
    session,
    frames,
    query,
    area,
    revoke: () => {
      allowed = false;
    },
  };
}

test('a paused worker serves only an exact native APK and revalidates private inputs before fetch', async () => {
  const { host, session, query, frames, area } = await gradleWorkerFixture();
  try {
    host.drain('maintenance');
    const response = await host.offer('builder', { repo: 'app-1', native: 'gradle', gradleArtifact: query });
    if ('error' in response || !response.result.artifact) throw new Error('Expected an exact completed APK.');
    expect(
      await host.offer('builder', {
        repo: 'app-1',
        native: 'gradle',
        gradleArtifact: { ...query, android: { ...query.android, variant: null } },
      }),
    ).toHaveProperty('error.code', 'bad-request');
    const artifact = response.result.artifact;
    expect(artifact).toMatchObject({ name: 'Sample.apk', androidPackage: 'dev.example.sample' });
    expect(response.result.capacity.declined).toBe('maintenance');
    expect(host.running()).toBe(0);
    for (const [client, repo, asked] of [
      ['other-client', 'app-1', query],
      ['builder', 'other-repo', query],
      ['builder', 'app-1', { ...query, sourceDigest: 'b'.repeat(64) }],
      ['builder', 'app-1', { ...query, android: { ...query.android, variant: 'release' } }],
    ] as const) {
      expect(await host.offer(client, { repo, native: 'gradle', gradleArtifact: asked })).toHaveProperty(
        'result.artifact',
        null,
      );
    }
    const env: Record<string, string> = JSON.parse(readFileSync(join(area, 'environment.json'), 'utf8'));
    const gradleHome = env.GRADLE_USER_HOME;
    if (!gradleHome) throw new Error('The worker did not report its private Gradle home.');
    const privateFile = join(gradleHome, 'gradle.properties');
    await writeFile(privateFile, 'pinned=changed');
    expect(await host.offer('builder', { repo: 'app-1', native: 'gradle', gradleArtifact: query })).toHaveProperty(
      'result.artifact',
      null,
    );
    expect(await session.cachedArtifact({ repo: 'app-1', artifact, gradleArtifact: query })).toEqual({ result: null });
    expect(frames).toEqual([]);
    await writeFile(privateFile, 'pinned=one');
    expect(await session.cachedArtifact({ repo: 'app-1', artifact })).toHaveProperty('error.code', 'bad-request');
    expect(await session.cachedArtifact({ repo: 'app-1', artifact, gradleArtifact: query })).toEqual({
      result: artifact,
    });
    expect(Buffer.concat(frames.map((frame) => frame.subarray(32))).toString()).toBe('verified native archive');
    expect(readFileSync(join(area, 'compiler-called'), 'utf8')).toBe('compiled\n');
    expect(JSON.stringify(response.result)).not.toContain('receipt');
    expect(JSON.stringify(response.result)).not.toContain(root);
  } finally {
    session.close(false);
    await host.close();
  }
});

test.each(['disconnect', 'revoke', 'remove', 'close'])('a native artifact query drains on %s', async (reason) => {
  const { host, session, query, area, revoke } = await gradleWorkerFixture();
  await writeFile(join(area, 'hold-query'), '');
  const response = host
    .offer('builder', { repo: 'app-1', native: 'gradle', gradleArtifact: query }, session.signal)
    .catch(() => null);
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(join(area, 'query-pid'))) {
      if (Date.now() > deadline) throw new Error('The query did not start.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pid = Number(readFileSync(join(area, 'query-pid'), 'utf8'));
    const captured = captureProcessIdentity(pid);
    if (!captured.ok) throw new Error(captured.reason);
    if (reason === 'disconnect') session.close(true);
    else if (reason === 'close') await host.close();
    else {
      revoke();
      if (reason === 'remove') await host.remove('builder');
      else host.abandonDetached(() => false);
    }
    await response;
    expect(inspectProcessIdentity({ pid, processToken: captured.token })).toBe('gone');
  } finally {
    session.close(false);
    await host.close();
  }
});
