import { withAmbientContext } from '@stim-cli/core';
import { testContext } from './_context.ts';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { acceptNoiseConnections, FAKE_SERVER_PUBLIC } from './_noise-server.ts';
import type { BuildMachineCredential, MachineCapacity } from '@stim-cli/core/state';
import { chooseBuildMachine, offloadBuild, pickOffer, type BuildOffer, type BuildRequest } from '../offload/client.ts';
import { manifestDigest } from '../offload/manifest.ts';
import { nativeGradleTransfer } from '../integrations/native-gradle-inputs.ts';
import { fingerprintNativeInputs } from '../integrations/native-inputs.ts';
import type { BuildTarget } from '../offload/toolchain.ts';
import { requestNativeRunCancel, withNativeBuildRun } from '../engine/native-run.ts';
import { getExecutor } from '../exec.ts';

const ports = new Map<string, number>();

vi.mock('../offload/build-machines.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../offload/build-machines.ts')>()),
  resolveEndpoint: (credential: BuildMachineCredential) => ({
    url: `ws://127.0.0.1:${ports.get(credential.machine)}`,
    servername: `${credential.machine}.example.ts.net`,
    host: `${credential.machine}.example.ts.net`,
  }),
}));

const TOOLCHAIN = {
  stimBuild: 'b1',
  arch: 'arm64',
  xcode: 'Xcode 27.0',
  simulatorSdk: '27.0',
  macosSdk: '27.0',
  cocoapods: '1.16.2',
  bundler: null,
  runtimes: ['iOS-27-0'],
  jdk: null,
  androidSdk: null,
};

const TARGET: BuildTarget = {
  platform: 'ios',
  local: { stimBuild: 'b1', compat: 1, arch: 'arm64', xcode: 'Xcode 27.0', simulatorSdk: '27.0', cocoapods: '1.16.2' },
  runtime: 'iOS-27-0',
  cocoapodsPinned: false,
};

const HERE: MachineCapacity = { cpus: 10, loadPerCore: 0.1, builds: 1, maxBuilds: 1, maxLoadPerCore: 2 };

interface FakeMachine {
  methods: string[];
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  closed: Promise<void>;
  closeCodes: number[];
  release: () => void;
  stop: () => Promise<void>;
}

const FAILED = { ok: false, code: 'worker-failed', message: 'xcodebuild failed' };

/**
 * A remote machine that offers `offer` and answers `build.start` with `start`, then reports a failed build. With
 * `drop`, it drops the connection after the start instead, and answers `build.attach` with `attach`.
 */
async function fakeMachine(
  machine: string,
  offer: BuildOffer,
  start: { error: { code: string; message: string } } | { result: { job: string } },
  {
    drop = false,
    closeAfterStart = null,
    hello = () => ({ result: { capabilities: ['build'] } }),
    dropOnSync = false,
    attach = { result: { outcome: null } },
    artifact = null,
    pause = null,
    cachedFetch = 'hit',
    failure = FAILED,
  }: {
    drop?: boolean;
    closeAfterStart?: number | null;
    dropOnSync?: boolean;
    attach?: object;
    hello?: () => object;
    artifact?: {
      archive: Buffer;
      digest: string;
      fingerprint?: string;
      sourceDigest?: string;
      reused?: true;
    } | null;
    pause?: string | null;
    cachedFetch?: 'hit' | 'miss' | 'corrupt';
    failure?: typeof FAILED;
  } = {},
): Promise<FakeMachine> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  ports.set(machine, (server.address() as AddressInfo).port);
  const methods: string[] = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const closeCodes: number[] = [];
  const pending: Array<() => void> = [];
  const deliver = (method: string, send: () => void) => {
    if (method === pause) pending.push(send);
    else send();
  };
  let closed!: () => void;
  const done = new Promise<void>((resolve) => (closed = resolve));
  acceptNoiseConnections(server, (socket) => {
    socket.on('close', (code: number) => {
      closeCodes.push(code);
      closed();
    });
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const { id, method, params } = JSON.parse(String(data)) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      requests.push({ method, params });
      methods.push(method);
      const reply = (body: object) => deliver(method, () => socket.send(JSON.stringify({ id, ...body })));
      if (method === 'hello') return reply(hello());
      if (method === 'build.cancel') return;
      if (method === 'build.offer') return reply({ result: offer });
      if (method === 'build.sync') return dropOnSync ? socket.terminate() : reply({ result: { missing: [] } });
      const fail = (job: string) =>
        deliver(pause === 'build.start' || pause === 'build.attach' ? pause : 'build.progress', () =>
          socket.send(
            JSON.stringify({
              event: 'build.progress',
              job,
              outcome: artifact
                ? {
                    ok: true,
                    artifact: { name: 'Sample.app', size: artifact.archive.length, sha256: artifact.digest },
                    compilationCache: {},
                    ...(artifact.reused ? { reused: true } : {}),
                    fingerprint: artifact.fingerprint,
                    sourceDigest: artifact.sourceDigest,
                  }
                : failure,
            }),
          ),
        );
      if (method === 'build.cached-artifact') {
        if (!artifact || cachedFetch === 'miss') return reply({ result: null });
        const bytes = cachedFetch === 'corrupt' ? Buffer.alloc(artifact.archive.length) : artifact.archive;
        const cachedDigest = artifact.digest;
        deliver(method, () => {
          socket.send(Buffer.concat([Buffer.from(cachedDigest, 'hex'), bytes]));
          socket.send(JSON.stringify({ id, result: { ...offer.artifact } }));
        });
        return;
      }
      if (method === 'build.artifact' && artifact) {
        socket.send(Buffer.concat([Buffer.from(artifact.digest, 'hex'), artifact.archive]));
        return reply({ result: { size: artifact.archive.length, sha256: artifact.digest } });
      }
      if (method === 'build.start') {
        reply(start);
        if ('result' in start && closeAfterStart !== null) return socket.close(closeAfterStart, 'device revoked');
        if ('result' in start) return drop ? socket.terminate() : fail(start.result.job);
      }
      if (method === 'build.attach') {
        reply(attach);
        if ('result' in attach && 'result' in start) fail(start.result.job);
        return;
      }
      reply({ error: { code: 'unknown-method', message: `Unknown method ${method}.` } });
    });
  });
  return {
    methods,
    requests,
    closed: done,
    closeCodes,
    release: () => {
      pause = null;
      for (const send of pending.splice(0)) send();
      artifact = null;
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const credential = (machine: string): BuildMachineCredential => ({
  machine,
  transport: 'tailscale',
  address: `${machine}.example.ts.net`,
  serverKey: FAKE_SERVER_PUBLIC,
  deviceId: 'd1',
  state: 'approved',
  requestedAt: '2026-09-28T00:00:00.000Z',
});

const offer = (loadPerCore: number): BuildOffer => ({
  toolchain: TOOLCHAIN,
  capacity: {
    running: 0,
    max: 1,
    diskFreeBytes: null,
    minDiskFreeBytes: 0,
    cpus: 10,
    loadPerCore,
    builds: 0,
    maxBuilds: 1,
    maxLoadPerCore: 2,
    declined: null,
  },
  warm: { checkout: false, dependencies: false, build: false },
});

let repo: string;
let home: string;
const machines: FakeMachine[] = [];

beforeEach(() => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-offload-')));
  home = mkdtempSync(join(tmpdir(), 'stim-offload-home-'));
  vi.stubEnv('STIM_HOME', home);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'package.json'), '{}');
});

afterEach(async () => {
  await Promise.all(machines.splice(0).map((machine) => machine.stop()));
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  ports.clear();
});

async function run(names: string[], note: (line: string) => void) {
  const choice = await chooseBuildMachine({
    projectRoot: repo,
    target: TARGET,
    here: HERE,
    note: () => {},
    machines: names.map(credential),
  });
  if (typeof choice === 'string') throw new Error(choice);
  return offloadBuild({
    choice,
    expectedFingerprint: 'f00d',
    request: {
      platform: 'ios',
      runtime: 'iOS-27-0',
      configuration: null,
      scheme: null,
      iosProjectPath: 'ios',
      isExpo: false,
      optimizations: null,
    },
    stagingDir: join(repo, 'staging'),
    onPhase: () => {},
    onEnter: () => {},
    onRecord: () => {},
    note,
  });
}

describe('offloadBuild', () => {
  it.each(['build.sync', 'build.start', 'build.progress', 'build.attach', 'build.artifact'])(
    'cancels a stopped workspace while waiting for %s without fallback or further requests',
    async (pause) => {
      const archive = Buffer.from('partial artifact');
      const machine = await fakeMachine(
        'mini',
        offer(0.1),
        { result: { job: 'j1' } },
        {
          pause,
          drop: pause === 'build.attach',
          artifact:
            pause === 'build.artifact'
              ? { archive, digest: createHash('sha256').update(archive).digest('hex'), fingerprint: 'f00d' }
              : null,
        },
      );
      const backup = await fakeMachine('backup', offer(0.5), { result: { job: 'j2' } });
      machines.push(machine, backup);
      const controller = new AbortController();
      const context = testContext({ signal: controller.signal });
      await withAmbientContext(context, () =>
        withNativeBuildRun(
          context,
          repo,
          { command: 'ios', platform: 'ios' },
          async (claim) => {
            let finished: unknown;
            const operation = run(['mini', 'backup'], () => {}).then(
              (value) => {
                finished = { value };
                return finished;
              },
              (error: unknown) => {
                finished = { error };
                return finished;
              },
            );
            try {
              await vi.waitFor(
                () => expect(machine.methods).toContain(pause === 'build.progress' ? 'build.start' : pause),
                { timeout: 30_000 },
              );
              const before = [...machine.methods];
              requestNativeRunCancel(repo, claim.claimId);
              controller.abort('SIGINT');
              await vi.waitFor(() => expect(finished).toMatchObject({ error: { code: 'STIM_CANCELLED' } }));
              await vi.waitFor(() => expect(machine.closeCodes).toContain(1000));
              await backup.closed;
              expect(machine.methods).toEqual(before);
              expect(backup.methods).toEqual(['hello', 'build.offer']);
            } finally {
              machine.release();
              await operation;
            }
          },
          { write: () => {} },
        ),
      );
      await withNativeBuildRun(
        testContext(),
        repo,
        { command: 'ios', platform: 'ios' },
        async () =>
          expect(await run(['mini'], () => {})).toEqual({
            ok: false,
            machine: 'mini',
            reason: 'worker-failed: xcodebuild failed',
          }),
        { write: () => {} },
      );
    },
  );

  it('moves past a machine whose connection dies during the sync', async () => {
    const busy = await fakeMachine('busy', offer(0.1), { error: { code: 'build-busy', message: 'busy' } });
    const dead = await fakeMachine('dead', offer(0.3), { result: { job: 'j0' } }, { dropOnSync: true });
    const next = await fakeMachine('next', offer(0.5), { result: { job: 'j1' } });
    machines.push(busy, dead, next);
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target: TARGET,
      here: HERE,
      note: () => {},
      machines: [credential('busy'), credential('dead'), credential('next')],
    });
    if (typeof choice === 'string') throw new Error(choice);
    const placements: string[] = [];
    const outcome = await offloadBuild({
      choice,
      expectedFingerprint: 'f00d',
      request: {
        platform: 'ios',
        runtime: 'iOS-27-0',
        configuration: null,
        scheme: null,
        iosProjectPath: 'ios',
        isExpo: false,
        optimizations: null,
      },
      stagingDir: join(repo, 'staging'),
      onPhase: () => {},
      onEnter: () => {},
      onRecord: () => {},
      note: (line) => placements.push(line),
    });
    expect(outcome).toEqual({ ok: false, machine: 'next', reason: 'worker-failed: xcodebuild failed' });
    expect(placements).toEqual([
      'placement: dead (busy could not take the build: start: build-busy: busy)',
      expect.stringMatching(/^placement: next \(dead could not take the build: sync: /),
    ]);
  });

  it('builds here when the machine does not hand the build back', async () => {
    const machine = await fakeMachine(
      'old',
      offer(0.1),
      { result: { job: 'j1' } },
      { drop: true, attach: { error: { code: 'unknown-method', message: 'Unknown method build.attach.' } } },
    );
    machines.push(machine);
    expect(await run(['old'], () => {})).toEqual({
      ok: false,
      machine: 'old',
      reason:
        'closed: the connection closed (1006); the machine did not hand the build back (unknown-method: Unknown method build.attach.)',
    });
  });

  it('keeps reconnecting while the machine cannot identify this machine for a moment', async () => {
    let hellos = 0;
    const machine = await fakeMachine(
      'mini',
      offer(0.1),
      { result: { job: 'j1' } },
      {
        drop: true,
        hello: () =>
          ++hellos === 2
            ? { error: { code: 'identity-unavailable', message: 'tailscale whois failed' } }
            : { result: { capabilities: ['build'] } },
      },
    );
    machines.push(machine);
    const lines: string[] = [];
    expect(await run(['mini'], (line) => lines.push(line))).toEqual({
      ok: false,
      machine: 'mini',
      reason: 'worker-failed: xcodebuild failed',
    });
    expect(lines.at(-1)).toBe('offload: reattached to the build on mini');
    expect(hellos).toBe(3);
  });

  it('stops reconnecting when the machine turns this machine away', async () => {
    let hellos = 0;
    const machine = await fakeMachine(
      'mini',
      offer(0.1),
      { result: { job: 'j1' } },
      {
        drop: true,
        hello: () =>
          ++hellos === 1
            ? { result: { capabilities: ['build'] } }
            : { error: { code: 'unauthorized', message: 'This machine does not recognize this device token.' } },
      },
    );
    machines.push(machine);
    expect(await run(['mini'], () => {})).toEqual({
      ok: false,
      machine: 'mini',
      reason:
        'closed: the connection closed (1006); it turned this machine away (This machine does not recognize this device token.)',
    });
    expect(hellos).toBe(2);
  });
});

describe('macOS artifact transfer', () => {
  it.each(['valid', 'missing-plist', 'missing-executable', 'bad-digest', 'symlinked-app', 'symlinked-contents'])(
    'accepts only a complete macOS app with the verified archive digest: %s',
    async (kind) => {
      const linked = kind.startsWith('symlinked');
      const app = linked ? join(repo, 'outside', 'Sample.app') : join(repo, 'archive-source', 'Sample.app');
      const contents = join(app, 'Contents');
      mkdirSync(join(contents, 'MacOS'), { recursive: true });
      if (kind !== 'missing-plist') writeFileSync(join(contents, 'Info.plist'), '{}');
      if (kind !== 'missing-executable') writeFileSync(join(contents, 'MacOS', 'Sample'), 'binary');
      if (kind === 'symlinked-app') {
        mkdirSync(join(repo, 'archive-source'), { recursive: true });
        symlinkSync(app, join(repo, 'archive-source', 'Sample.app'));
      }
      if (kind === 'symlinked-contents') {
        mkdirSync(join(repo, 'archive-source', 'Sample.app'), { recursive: true });
        symlinkSync(contents, join(repo, 'archive-source', 'Sample.app', 'Contents'));
      }
      const archivePath = join(repo, 'artifact.tgz');
      execFileSync('tar', ['-czf', archivePath, '-C', join(repo, 'archive-source'), 'Sample.app']);
      const archive = readFileSync(archivePath);
      const digest = kind === 'bad-digest' ? '00'.repeat(32) : createHash('sha256').update(archive).digest('hex');
      const machine = await fakeMachine(
        'mini',
        offer(0.1),
        { result: { job: 'j1' } },
        {
          artifact: { archive, digest },
          hello: () => ({ result: { capabilities: ['build'], features: kind === 'valid' ? ['build-compat'] : [] } }),
        },
      );
      machines.push(machine);
      const choice = await chooseBuildMachine({
        projectRoot: repo,
        target: {
          platform: 'macos',
          local: { stimBuild: 'b1', compat: 1, arch: 'arm64', xcode: 'Xcode 27.0', macosSdk: '27.0' },
        },
        selected: 'remote',
        here: HERE,
        machines: [credential('mini')],
        note: () => {},
      });
      if (typeof choice === 'string') throw new Error(choice);
      const outcome = await offloadBuild({
        choice,
        request: {
          platform: 'macos',
          product: 'Sample',
          infoPlist: 'Info.plist',
          bundleId: 'dev.sample.stim.test',
          resources: { 'AppIcon.icns': 'Support/icon.icns' },
          assetCatalog: 'Support/Assets.xcassets',
        },
        stagingDir: join(repo, 'fetched'),
        onPhase: () => {},
        onEnter: () => {},
        onRecord: () => {},
        note: () => {},
      });
      const start = machine.requests.find((entry) => entry.method === 'build.start')!.params;
      const files = machine.requests
        .filter((entry) => entry.method === 'build.sync')
        .flatMap((entry) => entry.params.files as Array<{ path: string; kind: string; sha256: string }>);
      expect(start).toEqual({
        repo: choice.identity.repo,
        project: '',
        platform: 'macos',
        macos: {
          product: 'Sample',
          infoPlist: 'Info.plist',
          bundleId: 'dev.sample.stim.test',
          resources: { 'AppIcon.icns': 'Support/icon.icns' },
          assetCatalog: 'Support/Assets.xcassets',
        },
        fingerprint: manifestDigest(files),
        stimBuild: 'b1',
        ...(kind === 'valid' ? { compat: 1 } : {}),
      });
      expect(outcome.ok).toBe(kind === 'valid');
      const observed = outcome.ok
        ? {
            binary: readFileSync(join(outcome.artifactPath, 'Contents', 'MacOS', 'Sample'), 'utf8'),
            compilationCache: outcome.compilationCache.status,
            ccache: outcome.ccache.status,
          }
        : { reason: outcome.reason };
      const failureReason = expect.stringContaining(
        kind === 'bad-digest'
          ? 'sha256'
          : linked
            ? 'mini returned Sample.app as or through a symbolic link'
            : kind === 'missing-plist'
              ? 'Contents/Info.plist'
              : 'Contents/MacOS/Sample',
      );
      expect(observed).toEqual(
        kind === 'valid'
          ? {
              binary: 'binary',
              compilationCache: 'unavailable',
              ccache: 'unavailable',
            }
          : {
              reason: failureReason,
            },
      );
    },
  );
});

describe('native Xcode worker selection', () => {
  test('an old worker is refused before offer or source upload', async () => {
    const machine = await fakeMachine('old', offer(0.1), { result: { job: 'unused' } });
    machines.push(machine);
    const result = await chooseBuildMachine({
      projectRoot: repo,
      target: { ...TARGET, native: 'xcode' },
      here: HERE,
      note: () => {},
      machines: [credential('old')],
    });
    expect(typeof result).toBe('string');
    expect(String(result)).toContain('does not support native Xcode builds');
    expect(machine.methods).toEqual(['hello']);
  });

  test('ignored native bytes refuse before the supported worker receives any source', async () => {
    const machine = await fakeMachine(
      'native',
      offer(0.1),
      { result: { job: 'unused' } },
      {
        hello: () => ({ result: { capabilities: ['build'], features: ['native-xcode-build'] } }),
      },
    );
    machines.push(machine);
    writeFileSync(join(repo, '.gitignore'), 'private.key\n');
    writeFileSync(join(repo, 'private.key'), 'not authorized for transport');
    const snapshot = await fingerprintNativeInputs([{ name: 'repository', path: repo }], {
      excluded: [join(repo, '.git')],
      parameters: null,
    });
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target: { ...TARGET, native: 'xcode' },
      here: HERE,
      note: () => {},
      machines: [credential('native')],
    });
    if (typeof choice === 'string') throw new Error(choice);
    const result = await offloadBuild({
      choice,
      expectedFingerprint: snapshot.hash,
      request: {
        platform: 'ios',
        runtime: 'iOS-27-0',
        configuration: 'Debug',
        scheme: 'App',
        isExpo: false,
        optimizations: null,
        native: { provider: 'xcode', snapshot, cacheKey: 'a'.repeat(64), arch: 'arm64' },
      },
      stagingDir: join(repo, 'staging'),
      onPhase: () => {},
      onEnter: () => {},
      onRecord: () => {},
      note: () => {},
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('private.key is ignored or absent') });
    expect(machine.methods).toEqual(['hello', 'build.offer']);
  });
});

test('native results with a different transfer digest are refused before artifact fetch', async () => {
  const snapshot = await fingerprintNativeInputs([{ name: 'repository', path: repo }], {
    excluded: [join(repo, '.git')],
    parameters: null,
  });
  const machine = await fakeMachine(
    'native',
    offer(0.1),
    { result: { job: 'j-native' } },
    {
      hello: () => ({ result: { capabilities: ['build'], features: ['native-xcode-build'] } }),
      artifact: {
        archive: Buffer.from('not fetched'),
        digest: 'b'.repeat(64),
        fingerprint: snapshot.hash,
        sourceDigest: 'c'.repeat(64),
      },
    },
  );
  machines.push(machine);
  const choice = await chooseBuildMachine({
    projectRoot: repo,
    target: { ...TARGET, native: 'xcode' },
    here: HERE,
    note: () => {},
    machines: [credential('native')],
  });
  if (typeof choice === 'string') throw new Error(choice);
  const result = await offloadBuild({
    choice,
    expectedFingerprint: snapshot.hash,
    request: {
      platform: 'ios',
      runtime: 'iOS-27-0',
      configuration: 'Debug',
      scheme: 'App',
      isExpo: false,
      optimizations: null,
      native: { provider: 'xcode', snapshot, cacheKey: 'a'.repeat(64), arch: 'arm64' },
    },
    stagingDir: join(repo, 'staging'),
    onPhase: () => {},
    onEnter: () => {},
    onRecord: () => {},
    note: () => {},
  });
  expect(result).toMatchObject({
    ok: false,
    reason: 'The worker returned a different native source or artifact identity.',
  });
  expect(machine.methods).toEqual(['hello', 'build.offer', 'build.sync', 'build.start']);
});

test.each([
  { client: 'without Xcode', xcode: null, returned: 'b'.repeat(40), built: 'b'.repeat(40) },
  { client: 'with Xcode', xcode: 'Xcode 27.0', returned: 'b'.repeat(40), built: null },
  { client: 'without Xcode', xcode: null, returned: '../escape', built: null },
])(
  'a client $client takes a build under the fingerprint after the worker pod install only when it left pod install there: $returned',
  async ({ xcode, returned, built }) => {
    mkdirSync(join(repo, 'archive-source', 'Sample.app'), { recursive: true });
    writeFileSync(join(repo, 'archive-source', 'Sample.app', 'Info.plist'), 'plist');
    const archivePath = join(repo, 'artifact.tgz');
    execFileSync('tar', ['-czf', archivePath, '-C', join(repo, 'archive-source'), 'Sample.app']);
    const archive = readFileSync(archivePath);
    const digest = createHash('sha256').update(archive).digest('hex');
    const machine = await fakeMachine(
      'mini',
      offer(0.1),
      { result: { job: 'j1' } },
      { artifact: { archive, digest, fingerprint: returned } },
    );
    machines.push(machine);
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target: { ...TARGET, local: { ...TARGET.local, xcode, simulatorSdk: xcode ? '27.0' : null } },
      here: HERE,
      note: () => {},
      machines: [credential('mini')],
    });
    if (typeof choice === 'string') throw new Error(choice);
    const result = await offloadBuild({
      choice,
      expectedFingerprint: 'f00d',
      request: {
        platform: 'ios',
        runtime: 'iOS-27-0',
        configuration: null,
        scheme: null,
        iosProjectPath: 'ios',
        isExpo: false,
        optimizations: null,
      },
      stagingDir: join(repo, 'staging'),
      onPhase: () => {},
      onEnter: () => {},
      onRecord: () => {},
      note: () => {},
    });
    const start = machine.requests.find((entry) => entry.method === 'build.start');
    expect(start?.params.podsOnWorker).toBe(xcode ? undefined : true);
    expect(result.ok ? { ok: true, builtFingerprint: result.builtFingerprint } : result).toEqual(
      built
        ? { ok: true, builtFingerprint: built }
        : { ok: false, machine: 'mini', reason: 'The worker returned a different fingerprint.' },
    );
  },
);

describe('exact peer artifacts', () => {
  test.each([
    'hit',
    'miss',
    'corrupt',
    'old-worker',
    'changed-source',
    'changed-during-fetch',
    'crlf-listing',
  ] as const)('SwiftPM cache-only %s never uploads sources or starts a compiler job', async (scenario) => {
    const app = join(repo, 'archive-source', 'Sample.app');
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents/Info.plist'), 'SwiftPM plist');
    writeFileSync(join(app, 'Contents/MacOS/App'), 'SwiftPM executable');
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    writeFileSync(join(repo, '.env'), 'private-worker-value');
    const archivePath = join(repo, 'archive.tgz');
    execFileSync('tar', ['-czf', archivePath, '-C', join(repo, 'archive-source'), 'Sample.app']);
    const archive = readFileSync(archivePath);
    const digest = createHash('sha256').update(archive).digest('hex');
    const fingerprint = 'f'.repeat(64);
    const request: Extract<BuildRequest, { platform: 'macos' }> = {
      platform: 'macos',
      product: 'App',
      infoPlist: 'Info.plist',
      bundleId: 'dev.example.App',
      cacheArtifact: true,
      artifactInputs: { complete: true, ignored: [], outputs: [], localFiles: ['.env'], environment: ['FLAVOR'] },
    };
    const target: BuildTarget = {
      platform: 'macos',
      local: { stimBuild: 'b1', compat: 1, arch: 'arm64', xcode: 'Xcode 27.0', macosSdk: '27.0' },
    };
    const machine = await fakeMachine(
      'swiftpm',
      {
        ...offer(3),
        capacity: { ...offer(3).capacity, declined: 'busy' },
        artifact: {
          fingerprint,
          cacheKey: `swiftpm-peer-${fingerprint}`,
          name: 'Sample.app',
          size: archive.length,
          sha256: digest,
        },
      },
      { result: { job: 'unused' } },
      {
        hello: () => ({
          result: {
            capabilities: ['build'],
            features: ['swiftpm-peer-cache', ...(scenario === 'old-worker' ? [] : ['build-compat'])],
          },
        }),
        artifact: { archive, digest },
        cachedFetch: scenario === 'miss' || scenario === 'corrupt' ? scenario : 'hit',
        pause: scenario === 'changed-during-fetch' ? 'build.cached-artifact' : null,
      },
    );
    machines.push(machine);
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target,
      here: { ...HERE, builds: 0 },
      machines: [credential('swiftpm')],
      swiftpmArtifact: request,
      cacheOnly: true,
      note: () => {},
    });
    expect(typeof choice).toBe(scenario === 'old-worker' ? 'string' : 'object');
    const offered = machine.requests.find((entry) => entry.method === 'build.offer')?.params.swiftpmArtifact;
    expect(Boolean(offered)).toBe(scenario !== 'old-worker');
    expect(JSON.stringify(offered ?? {})).not.toContain('private-worker-value');
    if (typeof choice === 'string') return;
    if (scenario === 'changed-source') writeFileSync(join(repo, 'package.json'), '{"changed":true}');
    const executor = getExecutor();
    const original = executor.runFileAsync.bind(executor);
    const tarSpy =
      scenario === 'crlf-listing'
        ? vi
            .spyOn(executor, 'runFileAsync')
            .mockImplementation((file, args, options) =>
              file === 'tar' && args[0] === '-tf'
                ? Promise.resolve(
                    'Sample.app/\r\nSample.app/Contents/\r\nSample.app/Contents/Info.plist\r\nSample.app/Contents/MacOS/\r\nSample.app/Contents/MacOS/App\r\n',
                  )
                : original(file, args, options),
            )
        : null;
    const pending = offloadBuild({
      choice,
      request,
      stagingDir: join(home, 'staging'),
      onPhase: () => {},
      onEnter: () => {},
      onRecord: () => {},
      note: () => {},
    });
    if (scenario === 'changed-during-fetch') {
      await vi.waitUntil(() => machine.methods.includes('build.cached-artifact'));
      writeFileSync(join(repo, 'package.json'), '{"changedDuringFetch":true}');
      machine.release();
    }
    const outcome = await pending;
    tarSpy?.mockRestore();
    expect(outcome.ok).toBe(scenario === 'hit' || scenario === 'crlf-listing');
    const observed = outcome.ok
      ? {
          cacheHit: outcome.cacheHit,
          syncMs: outcome.timings.syncMs,
          uploadedBytes: outcome.timings.uploadedBytes,
          workerMs: outcome.timings.workerMs,
          contents: readFileSync(join(outcome.artifactPath, 'Contents/MacOS/App'), 'utf8'),
        }
      : { stagingRemoved: !existsSync(join(home, 'staging')) };
    expect(observed).toEqual(
      scenario === 'hit' || scenario === 'crlf-listing'
        ? { cacheHit: true, syncMs: 0, uploadedBytes: 0, workerMs: 0, contents: 'SwiftPM executable' }
        : { stagingRemoved: true },
    );
    expect(machine.methods).toEqual([
      'hello',
      'build.offer',
      ...(scenario === 'changed-source' ? [] : ['build.cached-artifact']),
    ]);
    expect(
      machine.requests.find((entry) => entry.method === 'build.cached-artifact')?.params.swiftpmArtifact ?? null,
    ).toEqual(scenario === 'changed-source' ? null : offered);
  });

  test.each(
    (['ios', 'android'] as const).flatMap((platform) =>
      (['hit', 'miss', 'corrupt', 'old-worker'] as const).map((scenario) => ({ platform, scenario })),
    ),
  )('RN $platform cache-only $scenario skips upload and compiler admission', async ({ platform, scenario }) => {
    const name = platform === 'ios' ? 'Sample.app' : 'Sample.apk';
    const app = join(repo, 'archive-source', name);
    mkdirSync(platform === 'ios' ? app : join(repo, 'archive-source'), { recursive: true });
    writeFileSync(platform === 'ios' ? join(app, 'Info.plist') : app, 'RN bytes');
    const archivePath = join(repo, 'archive.tgz');
    execFileSync('tar', ['-czf', archivePath, '-C', join(repo, 'archive-source'), name]);
    const archive = readFileSync(archivePath),
      digest = createHash('sha256').update(archive).digest('hex');
    const fingerprint = 'f'.repeat(64);
    const target: BuildTarget =
      platform === 'ios'
        ? TARGET
        : {
            platform: 'android',
            local: { stimBuild: 'b1', compat: 1, arch: 'arm64', jdk: '17' },
            requires: { ndk: null, buildTools: null, compileSdk: null },
          };
    const request: BuildRequest =
      platform === 'ios'
        ? {
            platform: 'ios',
            runtime: 'iOS-27-0',
            configuration: null,
            scheme: null,
            isExpo: false,
            optimizations: { compilationCache: true, swiftCompilationCache: null, prefixMapping: true },
            cacheArtifact: true,
          }
        : {
            platform: 'android',
            isExpo: false,
            cacheArtifact: true,
            android: { variant: null, abi: null, compilerCache: 'none', gradleBuildCache: true, pch: 'auto' },
          };
    const machine = await fakeMachine(
      'rn',
      {
        ...offer(3),
        capacity: { ...offer(3).capacity, declined: 'busy' },
        artifact: {
          fingerprint,
          cacheKey: `react-native-${platform}-${fingerprint}`,
          name,
          ...(platform === 'android' ? { androidPackage: 'dev.example.sample' } : {}),
          size: archive.length,
          sha256: digest,
        },
      },
      { result: { job: 'unused' } },
      {
        hello: () => ({
          result: {
            capabilities: ['build'],
            features: ['react-native-peer-cache', ...(scenario === 'old-worker' ? [] : ['build-compat'])],
          },
        }),
        artifact: { archive, digest },
        cachedFetch: scenario === 'old-worker' ? 'hit' : scenario,
      },
    );
    machines.push(machine);
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target,
      here: { ...HERE, builds: 0 },
      machines: [credential('rn')],
      reactNativeArtifact: { request, fingerprint: 'native-fingerprint' },
      cacheOnly: true,
      note: () => {},
    });
    expect(typeof choice).toBe(scenario === 'old-worker' ? 'string' : 'object');
    expect(Boolean(machine.requests.find((e) => e.method === 'build.offer')?.params.reactNativeArtifact)).toBe(
      scenario !== 'old-worker',
    );
    if (typeof choice === 'string') return;
    const outcome = await offloadBuild({
      choice,
      request,
      expectedFingerprint: 'native-fingerprint',
      stagingDir: join(repo, 'staging'),
      onPhase: () => {},
      onEnter: () => {},
      onRecord: () => {},
      note: () => {},
    });
    expect(outcome.ok).toBe(scenario === 'hit');
    const observed = outcome.ok
      ? {
          cacheHit: outcome.cacheHit,
          timings: {
            syncMs: outcome.timings.syncMs,
            uploadedBytes: outcome.timings.uploadedBytes,
            workerMs: outcome.timings.workerMs,
          },
          contents: readFileSync(
            platform === 'ios' ? join(outcome.artifactPath, 'Info.plist') : outcome.artifactPath,
            'utf8',
          ),
        }
      : null;
    expect(observed).toEqual(
      scenario === 'hit'
        ? { cacheHit: true, timings: { syncMs: 0, uploadedBytes: 0, workerMs: 0 }, contents: 'RN bytes' }
        : null,
    );
    expect(machine.methods).toEqual(['hello', 'build.offer', 'build.cached-artifact']);
    const offered = machine.requests.find((e) => e.method === 'build.offer')?.params.reactNativeArtifact;
    expect(offered).toMatchObject({
      fingerprint: 'native-fingerprint',
      platform,
      toolchain:
        platform === 'ios'
          ? { compat: 1, arch: 'arm64', xcode: 'Xcode 27.0', simulatorSdk: '27.0', cocoapods: '1.16.2' }
          : { compat: 1, jdk: '17' },
      ...(platform === 'ios' ? { ios: { configuration: 'Debug' } } : { android: { variant: 'debug', abi: null } }),
    });
    expect(machine.requests.find((e) => e.method === 'build.cached-artifact')?.params.reactNativeArtifact).toEqual(
      offered,
    );
  });

  const gradleTarget: BuildTarget = {
    platform: 'android',
    native: 'gradle',
    local: { stimBuild: 'b1', compat: 1, arch: 'arm64', jdk: '17' },
    requires: { ndk: null, buildTools: null, compileSdk: null },
  };
  const android = {
    variant: 'debug',
    abi: 'arm64-v8a',
    gradleBuildCache: true,
    pch: 'auto',
    compilerCache: 'none',
  } as const;
  const policy = { read: true, write: true, remote: true };
  test.each(['escaping-link', 'extra-file'])(
    'Gradle peer APK %s never syncs or compiles during a cache-only lookup',
    async (scenario) => {
      writeFileSync(join(repo, '.gitignore'), 'archive-source/\narchive.tgz\nstaging/\n');
      const source = join(repo, 'archive-source');
      mkdirSync(source);
      writeFileSync(join(source, 'Sample.apk'), 'verified APK bytes');
      if (scenario === 'escaping-link') {
        rmSync(join(source, 'Sample.apk'));
        symlinkSync(repo, join(source, 'Sample.apk'));
      }
      if (scenario === 'extra-file') writeFileSync(join(source, 'Other'), 'unexpected');
      const archivePath = join(repo, 'archive.tgz');
      execFileSync('tar', [
        '-czf',
        archivePath,
        '-C',
        source,
        'Sample.apk',
        ...(scenario === 'extra-file' ? ['Other'] : []),
      ]);
      const archive = readFileSync(archivePath);
      const digest = createHash('sha256').update(archive).digest('hex');
      const transfer = await nativeGradleTransfer(repo, {
        complete: true,
        ignored: [],
        outputs: ['archive-source', 'staging'],
      });
      const artifact = {
        fingerprint: 'a'.repeat(64),
        cacheKey: 'worker-private-key',
        name: 'Sample.apk',
        size: archive.length,
        sha256: digest,
        androidPackage: 'dev.example.sample',
      };
      const machine = await fakeMachine(
        'gradle',
        {
          ...offer(3),
          capacity: { ...offer(3).capacity, declined: 'all slots busy' },
          artifact,
        },
        { result: { job: 'unused' } },
        {
          hello: () => ({
            result: {
              capabilities: ['build'],
              features: [
                'native-gradle-build',
                ...(scenario === 'old-worker' ? [] : ['native-gradle-peer-cache']),
                ...(scenario === 'old-jdk-worker' ? [] : ['native-gradle-peer-jdk']),
              ],
            },
          }),
          artifact: { archive, digest },
          cachedFetch: scenario === 'miss' || scenario === 'corrupt' ? scenario : 'hit',
        },
      );
      machines.push(machine);
      const query = { sourceDigest: transfer.digest, inputs: transfer.declaration, android, jdk: '17' };
      const choice = await chooseBuildMachine({
        projectRoot: repo,
        target: gradleTarget,
        here: { ...HERE, builds: 0 },
        machines: [credential('gradle')],
        gradleArtifact: query,
        cacheOnly: true,
        note: () => {},
      });
      const offerRequest = machine.requests.find((entry) => entry.method === 'build.offer')!;
      const unsupported = scenario === 'old-worker' || scenario === 'old-jdk-worker';
      expect(typeof choice).toBe(unsupported ? 'string' : 'object');
      expect(offerRequest.params.gradleArtifact).toEqual(unsupported ? undefined : { ...query, project: '' });
      expect(machine.methods).toEqual(['hello', 'build.offer']);
      if (unsupported) return;
      if (typeof choice === 'string') throw new Error(choice);
      const stagingDir = join(repo, 'staging');
      const result = await offloadBuild({
        choice,
        expectedFingerprint: null,
        request: {
          platform: 'android',
          isExpo: false,
          native: { provider: 'gradle', transfer, cache: policy },
          android: scenario === 'changed-request' ? { ...android, abi: 'x86_64' } : android,
        },
        stagingDir,
        onPhase: () => {},
        onEnter: () => {},
        onRecord: () => {},
        note: () => {},
      });
      expect(result.ok).toBe(scenario === 'hit');
      const observed = result.ok
        ? {
            cacheHit: result.cacheHit,
            androidPackage: result.androidPackage,
            syncMs: result.timings.syncMs,
            uploadedBytes: result.timings.uploadedBytes,
            workerMs: result.timings.workerMs,
            bytes: readFileSync(result.artifactPath, 'utf8'),
          }
        : { stagingRemains: existsSync(stagingDir) };
      expect(observed).toEqual(
        scenario === 'hit'
          ? {
              cacheHit: true,
              androidPackage: 'dev.example.sample',
              syncMs: 0,
              uploadedBytes: 0,
              workerMs: 0,
              bytes: 'verified APK bytes',
            }
          : { stagingRemains: false },
      );
      expect(machine.methods).toEqual([
        'hello',
        'build.offer',
        ...(scenario === 'changed-request' ? [] : ['build.cached-artifact']),
      ]);
      expect(machine.requests.at(-1)?.params).toEqual(
        scenario === 'changed-request'
          ? offerRequest.params
          : {
              repo: choice.identity.repo,
              artifact: { fingerprint: artifact.fingerprint, cacheKey: artifact.cacheKey },
              gradleArtifact: { ...query, project: '' },
            },
      );
    },
  );

  test.each(['auto', 'remote', 'named', 'legacy'] as const)(
    'a missed Gradle APK reapplies %s placement before compiling, so only a named machine compiles while saturated',
    async (selection) => {
      const named = selection === 'named' || selection === 'legacy';
      writeFileSync(join(repo, '.gitignore'), 'staging/\n');
      const transfer = await nativeGradleTransfer(repo, { complete: true, ignored: [], outputs: [] });
      const machine = await fakeMachine(
        'gradle',
        {
          ...offer(4),
          artifact: {
            fingerprint: 'a'.repeat(64),
            cacheKey: 'worker-key',
            name: 'Sample.apk',
            size: 10,
            sha256: 'b'.repeat(64),
            androidPackage: 'dev.example.sample',
          },
          toolchain: { ...TOOLCHAIN, jdk: '17', androidSdk: { ndk: [], buildTools: [], platforms: [] } },
        },
        { result: { job: 'new-build' } },
        {
          hello: () => ({
            result: {
              capabilities: ['build'],
              features: [
                'native-gradle-build',
                'native-gradle-peer-cache',
                ...(selection === 'legacy' ? [] : ['native-gradle-peer-jdk']),
              ],
            },
          }),
          cachedFetch: 'miss',
        },
      );
      machines.push(machine);
      const choice = await chooseBuildMachine({
        projectRoot: repo,
        target: gradleTarget,
        selected: named ? 'gradle' : selection,
        here: { ...HERE, builds: 0, loadPerCore: 3 },
        machines: [credential('gradle')],
        gradleArtifact: { sourceDigest: transfer.digest, inputs: transfer.declaration, android },
        note: () => {},
      });
      if (typeof choice === 'string') throw new Error(choice);
      const result = await offloadBuild({
        choice,
        expectedFingerprint: null,
        request: {
          platform: 'android',
          isExpo: false,
          native: { provider: 'gradle', transfer, cache: policy },
          android,
        },
        stagingDir: join(repo, 'staging'),
        onPhase: () => {},
        onEnter: () => {},
        onRecord: () => {},
        note: () => {},
      });
      expect(result.ok).toBe(false);
      expect(machine.methods.includes('build.start')).toBe(named);
      expect(
        machine.requests
          .filter((entry) => entry.method === 'build.offer')
          .map((entry) => Boolean(entry.params.gradleArtifact)),
      ).toEqual(selection === 'legacy' ? [false] : [true, false]);
    },
  );

  it.each(['escaping-link'] as const)(
    'reuses verified bytes without syncing or compiling; %s',
    async (cachedFetch: 'hit' | 'miss' | 'corrupt' | 'escaping-link' | 'extra-file') => {
      const app = join(repo, 'archive-source', 'Sample.app');
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, 'Info.plist'), 'verified plist');
      if (cachedFetch === 'escaping-link') symlinkSync(repo, join(app, 'Outside'));
      if (cachedFetch === 'extra-file') writeFileSync(join(repo, 'archive-source', 'Other'), 'outside');
      const archivePath = join(repo, 'archive.tgz');
      execFileSync('tar', [
        '-czf',
        archivePath,
        '-C',
        join(repo, 'archive-source'),
        'Sample.app',
        ...(cachedFetch === 'extra-file' ? ['Other'] : []),
      ]);
      const archive = readFileSync(archivePath);
      const digest = createHash('sha256').update(archive).digest('hex');
      const identity = { fingerprint: 'native-source', cacheKey: 'native-source-sdk27-arm64-target' };
      const cachedOffer = {
        ...offer(3),
        toolchain: { ...TOOLCHAIN, simulatorSdk: '28.0' },
        capacity: { ...offer(3).capacity, declined: 'all slots busy' },
        artifact: { ...identity, name: 'Sample.app', size: archive.length, sha256: digest },
      };
      const machine = await fakeMachine(
        'cached',
        cachedOffer,
        { result: { job: 'unused' } },
        {
          hello: () => ({
            result: {
              capabilities: ['build'],
              features: ['native-xcode-build', 'native-xcode-toolchain', 'build-artifact-cache'],
            },
          }),
          artifact: { archive, digest },
          cachedFetch: cachedFetch === 'escaping-link' || cachedFetch === 'extra-file' ? 'hit' : cachedFetch,
        },
      );
      machines.push(machine);
      const choice = await chooseBuildMachine({
        projectRoot: repo,
        target: { ...TARGET, native: 'xcode' },
        here: { ...HERE, builds: 0 },
        machines: [credential('cached')],
        artifact: identity,
        cacheOnly: true,
        note: () => {},
      });
      if (typeof choice === 'string') throw new Error(choice);
      const stagingDir = join(repo, 'staging');
      const outcome = await offloadBuild({
        choice,
        expectedFingerprint: identity.fingerprint,
        request: {
          platform: 'ios',
          native: {
            provider: 'xcode',
            snapshot: { hash: identity.fingerprint, entries: [], parameters: {} },
            cacheKey: identity.cacheKey,
            arch: 'arm64',
          },
          runtime: 'iOS-27-0',
          configuration: 'Debug',
          scheme: 'Sample',
          isExpo: false,
          optimizations: null,
        },
        stagingDir,
        onPhase: () => {},
        onEnter: () => {},
        onRecord: () => {},
        note: () => {},
      });
      expect(outcome.ok).toBe(cachedFetch === 'hit');
      const observed = outcome.ok
        ? {
            cacheHit: outcome.cacheHit,
            timings: {
              syncMs: outcome.timings.syncMs,
              uploadedBytes: outcome.timings.uploadedBytes,
              workerMs: outcome.timings.workerMs,
            },
            plist: readFileSync(join(outcome.artifactPath, 'Info.plist'), 'utf8'),
          }
        : { stagingRemoved: !existsSync(stagingDir) };
      expect(observed).toEqual(
        cachedFetch === 'hit'
          ? { cacheHit: true, timings: { syncMs: 0, uploadedBytes: 0, workerMs: 0 }, plist: 'verified plist' }
          : { stagingRemoved: true },
      );
      expect(machine.methods).toEqual(['hello', 'build.offer', 'build.cached-artifact']);
      const lookup = machine.requests.find((entry) => entry.method === 'build.offer');
      expect(lookup?.params.artifact).toEqual(identity);
    },
  );
});

test('exact completed artifacts rank ahead of warm idle builders, but another target or SDK remains a miss', () => {
  const identity = { fingerprint: 'native', cacheKey: 'sdk27-arm64-targetA' };
  const cached = {
    ...offer(3),
    capacity: { ...offer(3).capacity, declined: 'busy' },
    artifact: { ...identity, name: 'Sample.app', size: 10, sha256: 'a'.repeat(64) },
  };
  const base = {
    mode: 'force' as const,
    here: HERE,
    target: TARGET,
    offers: [
      { machine: 'idle', offer: offer(0.1) },
      { machine: 'cached', offer: cached },
    ],
  };
  expect(pickOffer({ ...base, artifact: identity }).order).toEqual([1, 0]);
  expect(pickOffer({ ...base, artifact: { ...identity, cacheKey: 'sdk28-arm64-targetA' } }).order).toEqual([0]);
  expect(
    pickOffer({ ...base, artifact: { ...identity, cacheKey: 'sdk27-arm64-targetB' }, cacheOnly: true }).order,
  ).toEqual([]);
  expect(pickOffer({ ...base, artifact: identity, selected: 'idle' }).order).toEqual([0]);
});
