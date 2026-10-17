import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildHost } from '../src/build.ts';
import type { BuildSwiftpmArtifactQuery } from '@stim-cli/core/protocol';

test('a paused worker retains an exact SwiftPM archive after checkout pruning and rechecks private inputs before fetch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stim-swiftpm-peer-server-'));
  vi.stubEnv('STIM_HOME', join(root, 'home'));
  const worker = join(root, 'worker.mjs');
  await writeFile(
    worker,
    `
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.argv[2];
if (mode === 'offer') {
  console.log(JSON.stringify({ stimBuild: 'b1', os: process.platform, arch: process.arch, xcode: 'Xcode 27', macosSdk: '27', runtimes: [], jdk: null, androidSdk: null }));
} else {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  const area = process.cwd();
  const privateFile = join(area, 'worker-private');
  if (mode === 'build' && !existsSync(privateFile)) writeFileSync(privateFile, 'private-pinned-value');
  const query = mode === 'build' ? { project: input.project, sourceDigest: input.expectedFingerprint, stimBuild: input.stimBuild, inputs: input.macos.artifactInputs, build: { product: input.macos.product, infoPlist: input.macos.infoPlist, resources: {}, assetCatalog: null } } : input.query;
  const hash = createHash('sha256').update(JSON.stringify([query, readFileSync(privateFile, 'utf8')])).digest('hex');
  const identity = { hash, key: 'swiftpm-peer-' + hash };
  if (mode === 'swiftpm-artifact') console.log(JSON.stringify({ identity }));
  else if (mode === 'build') {
    appendFileSync(join(area, 'compiler-called'), 'compile\\n');
    mkdirSync(join(area, 'src'), { recursive: true });
    const output = join(area, 'out', input.job);
    mkdirSync(output, { recursive: true });
    const bytes = 'verified SwiftPM archive';
    writeFileSync(join(output, 'app.tgz'), bytes);
    console.log(JSON.stringify({ type: 'result', ok: true, fingerprint: input.expectedFingerprint,
      swiftpmArtifact: { identity, receipt: { query, identity } },
      artifact: { name: 'App.app', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, compilationCache: {}, timings: {} }));
  } else throw new Error('Unexpected worker mode ' + mode);
}
`,
  );
  await mkdir(join(root, 'home'));
  await writeFile(join(root, 'home', 'config.json'), JSON.stringify({ server: { maxLoadPerCore: 100_000 } }));
  const host = new BuildHost({ worker, env: process.env, limits: { killGraceMs: 50 } });
  const frames: Buffer[] = [];
  const session = host.session(
    'builder',
    {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      send: (frame: Buffer) => {
        frames.push(frame);
      },
    },
    () => {},
  );
  const query: BuildSwiftpmArtifactQuery = {
    project: '',
    sourceDigest: 'a'.repeat(64),
    stimBuild: 'b1',
    inputs: { complete: true, ignored: [], outputs: [], localFiles: [], environment: [] },
    build: { product: 'App', infoPlist: 'Info.plist', resources: {}, assetCatalog: null },
  };
  try {
    const job = host.launch({
      client: 'builder',
      repo: 'app-1',
      session,
      send: () => {},
      job: {
        platform: 'macos',
        project: query.project,
        expectedFingerprint: query.sourceDigest,
        stimBuild: query.stimBuild,
        cacheArtifact: true,
        macos: { ...query.build, bundleId: 'dev.example.App', artifactInputs: query.inputs },
      },
    });
    if ('error' in job) throw new Error(job.error.message);
    await job.done;
    if (!job.outcome?.ok) throw new Error(JSON.stringify(job.outcome));
    host.forget(job);
    const area = join(host.clientDir('builder'), 'repos', 'app-1');
    await rm(join(area, 'src'), { recursive: true });
    await rm(join(area, 'out'), { recursive: true });
    host.drain('maintenance');
    const response = await host.offer('builder', { repo: 'app-1', swiftpmArtifact: query });
    if ('error' in response || !response.result.artifact) throw new Error('Expected the retained SwiftPM artifact.');
    const artifact = response.result.artifact;
    expect(response.result.capacity.declined).toBe('maintenance');
    expect(host.running()).toBe(0);
    for (const [client, repo, changed] of [
      ['other-client', 'app-1', query],
      ['builder', 'other-repo', query],
      ['builder', 'app-1', { ...query, sourceDigest: 'b'.repeat(64) }],
      ['builder', 'app-1', { ...query, build: { ...query.build, product: 'Other' } }],
    ] as const)
      expect(await host.offer(client, { repo, swiftpmArtifact: changed })).toHaveProperty('result.artifact', null);
    expect(await session.cachedArtifact({ repo: 'app-1', artifact })).toHaveProperty('error.code', 'bad-request');
    expect(await session.cachedArtifact({ repo: 'app-1', artifact, swiftpmArtifact: query })).toEqual({
      result: artifact,
    });
    expect(Buffer.concat(frames.map((frame) => frame.subarray(32))).toString()).toBe('verified SwiftPM archive');
    frames.length = 0;
    await writeFile(join(area, 'worker-private'), 'changed');
    expect(await host.offer('builder', { repo: 'app-1', swiftpmArtifact: query })).toHaveProperty(
      'result.artifact',
      null,
    );
    expect(await session.cachedArtifact({ repo: 'app-1', artifact, swiftpmArtifact: query })).toEqual({ result: null });
    expect(frames).toEqual([]);
    expect(await readFile(join(area, 'compiler-called'), 'utf8')).toBe('compile\n');
    expect(JSON.stringify(response)).not.toContain('private-pinned-value');
  } finally {
    session.close(false);
    await host.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
