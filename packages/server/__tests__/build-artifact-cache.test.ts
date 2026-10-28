import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reactNativeArtifactIdentity, reactNativeArtifactQuery } from '@stim-cli/core';
import { BuildArtifactCache } from 'stim/build-artifact-cache';
import { BuildHost } from '../src/build.ts';
import * as artifactQuery from '../src/artifact-query.ts';
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
  vi.restoreAllMocks();
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
  await cache.storeCompleted(query, identity, receipt, source, artifact, signal());
  expect(await cache.receipt(query, signal())).toEqual(receipt);
  for (const different of [
    { ...query, project: 'other' },
    { ...query, sourceDigest: 'b'.repeat(64) },
    { ...query, inputs: { ...query.inputs, outputs: ['other/build'] } },
    { ...query, android: { ...query.android, variant: 'release' } },
  ])
    expect(await cache.receipt(different, signal())).toBeNull();
  expect(await cache.lookup(identity, signal())).toEqual({ ...identity, ...artifact });
  await cache.storeCompleted(
    query,
    identity,
    { source: 'unverified' },
    source,
    { ...artifact, ...descriptor('wrong'), name: 'Sample.apk' },
    signal(),
  );
  expect(await cache.receipt(query, signal())).toEqual(receipt);
  await expect(cache.receipt(query, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
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
  } else if (existsSync(join(area, 'hold-build'))) {
    writeFileSync(join(area, 'build-pid.partial'), String(process.pid));
    renameSync(join(area, 'build-pid.partial'), join(area, 'build-pid'));
    setInterval(() => {}, 1000);
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

test('revocation cancels connected builds even when another repository query cannot confirm cleanup', async () => {
  const { host, session, query, revoke } = await gradleWorkerFixture();
  const area = join(host.clientDir('builder'), 'repos', 'other-repo');
  await mkdir(area, { recursive: true });
  await writeFile(join(area, 'hold-build'), '');
  const job = host.launch({
    client: 'builder',
    repo: 'other-repo',
    session,
    send: () => {},
    job: {
      platform: 'android',
      project: '',
      expectedFingerprint: null,
      android: query.android,
      native: { provider: 'gradle', sourceDigest: query.sourceDigest, inputs: query.inputs },
    },
  });
  if ('error' in job) throw new Error(job.error.message);
  try {
    await vi.waitFor(() => expect(existsSync(join(area, 'build-pid'))).toBe(true));
    const pid = Number(readFileSync(join(area, 'build-pid'), 'utf8'));
    const captured = captureProcessIdentity(pid);
    if (!captured.ok) throw new Error(captured.reason);
    vi.spyOn(artifactQuery, 'runArtifactQuery').mockReturnValue({
      done: Promise.resolve({ identity: null, settled: false }),
      cancel: () => {},
    });
    await expect(host.offer('builder', { repo: 'app-1', native: 'gradle', gradleArtifact: query })).rejects.toThrow(
      'could not verify',
    );
    revoke();
    host.abandonDetached(() => false, true);
    await host.remove('builder');
    expect(inspectProcessIdentity({ pid, processToken: captured.token })).toBe('gone');
    expect(job.outcome).toMatchObject({ ok: false, code: 'cancelled' });
    expect(host.running()).toBe(0);
    expect(existsSync(host.clientDir('builder'))).toBe(true);
    expect(existsSync(area)).toBe(true);
  } finally {
    job.cancel();
    await job.done;
    session.close(false);
    await host.close();
  }
});

test('React Native offers distinguish an exact cache miss from malformed or mixed queries', async () => {
  const worker = join(root, 'offer-worker.mjs');
  await writeFile(worker, `console.log(JSON.stringify({stimBuild:'b1',arch:'arm64',runtimes:[]}));`);
  const host = new BuildHost({ worker, env: process.env });
  const query = {
    project: 'app',
    fingerprint: 'native-fingerprint',
    platform: 'ios',
    isExpo: false,
    toolchain: { stimBuild: 'b1', arch: 'arm64', xcode: 'Xcode 27', simulatorSdk: '27', cocoapods: '1.16.2' },
    ios: {
      runtime: 'iOS-27-0',
      configuration: 'Debug',
      scheme: null,
      projectPath: 'ios',
      optimizations: { compilationCache: true, swiftCompilationCache: false, prefixMapping: true },
    },
  };
  try {
    const offered = await host.offer('builder', { repo: 'app-1', reactNativeArtifact: query });
    expect(offered).toMatchObject({ result: { artifact: null } });
    for (const params of [
      { reactNativeArtifact: { ...query, project: '../other' } },
      { reactNativeArtifact: { ...query, ios: { ...query.ios, configuration: 'Release' } } },
      { native: 'xcode', reactNativeArtifact: query },
      { artifact: identity, reactNativeArtifact: query },
    ])
      expect(await host.offer('builder', { repo: 'app-1', ...params })).toMatchObject({
        error: { code: 'bad-request' },
      });
  } finally {
    await host.close();
  }
});

test.each(['ios', 'android'] as const)(
  'completed RN %s bytes survive job cleanup and later worker changes without a compiler slot',
  async (platform) => {
    const tools = {
      stimBuild: 'b1',
      arch: 'arm64',
      xcode: 'Xcode 27',
      simulatorSdk: '27',
      cocoapods: '1.16.2',
      jdk: '17',
    };
    const query =
      platform === 'ios'
        ? {
            project: '',
            fingerprint: 'native-inputs',
            platform,
            isExpo: false,
            toolchain: {
              stimBuild: tools.stimBuild,
              arch: tools.arch,
              xcode: tools.xcode,
              simulatorSdk: tools.simulatorSdk,
              cocoapods: tools.cocoapods,
            },
            ios: {
              runtime: 'iOS-27-0',
              configuration: 'Debug',
              scheme: null,
              projectPath: 'ios',
              optimizations: { compilationCache: true, swiftCompilationCache: false, prefixMapping: true },
            },
          }
        : {
            project: '',
            fingerprint: 'native-inputs',
            platform,
            isExpo: false,
            toolchain: { stimBuild: tools.stimBuild, jdk: tools.jdk },
            android: {
              variant: 'debug',
              abi: null,
              compilerCache: 'none',
              gradleBuildCache: true,
              pch: 'auto',
              gradleRoot: 'android',
              module: ':app',
            },
          };
    const worker = join(root, 'rn-worker.mjs');
    await writeFile(
      worker,
      `
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const query = JSON.parse(process.env.TEST_RN_QUERY);
const receipt={query,toolchain:{sdk:'original-worker-sdk'}};
const hash = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
const identity = {hash,key:'react-native-'+query.platform+'-'+hash};
if (process.argv[2].startsWith('offer')) console.log(JSON.stringify(${JSON.stringify({ ...tools, runtimes: ['iOS-27-0'], androidSdk: { ndk: [], platforms: [], buildTools: [] } })}));
else {
 let text=''; for await (const chunk of process.stdin) text+=chunk; const input=JSON.parse(text);
   const out=join(input.area,'out',input.job); mkdirSync(out,{recursive:true});
   const bytes='verified RN archive'; writeFileSync(join(out,'app.tgz'),bytes); writeFileSync(join(input.area,'toolchain-seal'),'original');
   console.log(JSON.stringify({type:'result',ok:true,fingerprint:input.expectedFingerprint,
    artifact:{name:query.platform==='ios'?'Sample.app':'Sample.apk',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},
    ...(query.platform==='android'?{androidPackage:'dev.example.sample'}:{}),compilationCache:{},timings:{},
    reactNativeArtifact:{identity,receipt}}));
}
`,
    );
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', 'config.json'), JSON.stringify({ server: { maxLoadPerCore: 100000 } }));
    const host = new BuildHost({
      worker,
      env: { ...process.env, TEST_RN_QUERY: JSON.stringify(reactNativeArtifactQuery(query)) },
    });
    const frames: Buffer[] = [];
    const session = host.session(
      'builder',
      { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (frame: Buffer) => frames.push(frame) },
      () => {},
    );
    try {
      const job = host.launch({
        client: 'builder',
        repo: 'rn-1',
        session,
        send: () => {},
        job: { platform, project: '', expectedFingerprint: query.fingerprint, cacheArtifact: true },
      });
      if ('error' in job) throw new Error(job.error.message);
      await job.done;
      host.forget(job);
      const area = join(host.clientDir('builder'), 'repos', 'rn-1');
      await rm(join(area, 'out'), { recursive: true, force: true });
      host.drain('maintenance');
      const offered = await host.offer('builder', { repo: 'rn-1', reactNativeArtifact: query });
      if ('error' in offered || !offered.result.artifact) throw new Error('Expected completed RN bytes.');
      const artifact = offered.result.artifact;
      expect(offered.result.capacity.declined).toBe('maintenance');
      expect(host.running()).toBe(0);
      for (const [client, repo, changed] of [
        ['other', 'rn-1', query],
        ['builder', 'other', query],
        ['builder', 'rn-1', { ...query, fingerprint: 'changed' }],
        ['builder', 'rn-1', { ...query, toolchain: { ...query.toolchain, stimBuild: 'b2' } }],
      ] as const)
        expect(await host.offer(client, { repo, reactNativeArtifact: changed })).toHaveProperty(
          'result.artifact',
          null,
        );
      await writeFile(join(area, 'toolchain-seal'), 'changed');
      expect(await session.cachedArtifact({ repo: 'rn-1', artifact, reactNativeArtifact: query })).toEqual({
        result: artifact,
      });
      expect(Buffer.concat(frames.map((frame) => frame.subarray(32))).toString()).toBe('verified RN archive');
      frames.length = 0;
      await writeFile(join(area, 'toolchain-seal'), 'original');
      expect(await session.cachedArtifact({ repo: 'rn-1', artifact })).toHaveProperty('error.code', 'bad-request');
      expect(await session.cachedArtifact({ repo: 'rn-1', artifact, reactNativeArtifact: query })).toEqual({
        result: artifact,
      });
      expect(Buffer.concat(frames.map((frame) => frame.subarray(32))).toString()).toBe('verified RN archive');
      expect(host.running()).toBe(0);
    } finally {
      session.close(false);
      await host.close();
    }
  },
);

test.each([true, false])(
  'an RN build under the fingerprint after the worker pod install is kept under that fingerprint only for a client that left pod install there: %s',
  async (podsOnWorker) => {
    const query = reactNativeArtifactQuery({
      project: '',
      fingerprint: 'after-pods',
      platform: 'ios',
      isExpo: false,
      toolchain: { stimBuild: 'b1', arch: 'arm64', xcode: 'Xcode 27', simulatorSdk: '27', cocoapods: '1.16.2' },
      ios: {
        runtime: 'iOS-27-0',
        configuration: 'Debug',
        scheme: null,
        projectPath: 'ios',
        optimizations: { compilationCache: true, swiftCompilationCache: false, prefixMapping: true },
      },
    });
    if (!query) throw new Error('Invalid fixture query.');
    const worker = join(root, 'rn-worker.mjs');
    await writeFile(
      worker,
      `
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const query = JSON.parse(process.env.TEST_RN_QUERY);
const receipt={query,toolchain:{}};
const hash = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
if (process.argv[2].startsWith('offer')) console.log(JSON.stringify({...query.toolchain,runtimes:['iOS-27-0']}));
else {
 let text=''; for await (const chunk of process.stdin) text+=chunk; const input=JSON.parse(text);
 const out=join(input.area,'out',input.job); mkdirSync(out,{recursive:true});
 const bytes='rn archive'; writeFileSync(join(out,'app.tgz'),bytes);
 console.log(JSON.stringify({type:'result',ok:true,fingerprint:query.fingerprint,
  artifact:{name:'Sample.app',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},
  compilationCache:{},timings:{},reactNativeArtifact:{identity:{hash,key:'react-native-ios-'+hash},receipt}}));
}
`,
    );
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', 'config.json'), JSON.stringify({ server: { maxLoadPerCore: 100000 } }));
    const host = new BuildHost({ worker, env: { ...process.env, TEST_RN_QUERY: JSON.stringify(query) } });
    const session = host.session('builder', { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {} }, () => {});
    try {
      const job = host.launch({
        client: 'builder',
        repo: 'rn-1',
        session,
        send: () => {},
        job: {
          platform: 'ios',
          project: '',
          expectedFingerprint: 'before-pods',
          cacheArtifact: true,
          ...(podsOnWorker ? { podsOnWorker } : {}),
        },
      });
      if ('error' in job) throw new Error(job.error.message);
      await job.done;
      const offered = async (fingerprint: string) => {
        const result = await host.offer('builder', { repo: 'rn-1', reactNativeArtifact: { ...query, fingerprint } });
        if ('error' in result) throw new Error(result.error.message);
        return result.result.artifact !== null;
      };
      expect({ before: await offered('before-pods'), after: await offered('after-pods') }).toEqual({
        before: false,
        after: podsOnWorker,
      });
    } finally {
      session.close(false);
      await host.close();
    }
  },
);

test('a changed completed receipt cannot alias the original archive identity', async () => {
  const cache = new BuildArtifactCache(join(root, 'catalog'));
  const query = reactNativeArtifactQuery({
    project: '',
    fingerprint: 'native-inputs',
    isExpo: false,
    platform: 'android',
    toolchain: { stimBuild: 'b1', jdk: '17' },
    android: { variant: 'debug', abi: null, gradleBuildCache: true, pch: 'auto', compilerCache: 'none' },
  });
  if (!query) throw new Error('Invalid fixture query.');
  const receipt = { query, toolchain: { sdk: 'worker-sdk' } };
  const completedIdentity = reactNativeArtifactIdentity(receipt);
  const archive = join(root, 'app.tgz');
  await writeFile(archive, 'verified');
  const artifact = { ...descriptor('verified'), name: 'Sample.apk', androidPackage: 'dev.example.sample' };
  await cache.storeCompleted(query, completedIdentity, receipt, archive, artifact, signal());
  expect(await cache.lookupReactNative(query, signal())).toEqual({ ...completedIdentity, ...artifact });
  const filename = (await readdir(join(root, 'catalog'))).find((name) => name.endsWith('.react-native.json'));
  if (!filename) throw new Error('The completed receipt was not written.');
  const path = join(root, 'catalog', filename);
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.receipt.toolchain.sdk = 'different-sdk';
  await writeFile(path, JSON.stringify(record));
  expect(await cache.lookupReactNative(query, signal())).toBeNull();
});
