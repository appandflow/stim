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
import {
  chooseBuildMachine,
  closeOffload,
  offloadBuild,
  pickOffer,
  type BuildOffer,
  type BuildRequest,
} from '../offload/client.ts';
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
    artifact?: { archive: Buffer; digest: string; fingerprint?: string; sourceDigest?: string } | null;
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
            pause === 'build.artifact' ? { archive, digest: createHash('sha256').update(archive).digest('hex') } : null,
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

  it('moves to the next machine in placement order when the chosen one refuses build.start', async () => {
    const busy = await fakeMachine('busy', offer(0.1), {
      error: { code: 'build-busy', message: 'This machine declines the build: all 1 build slots busy.' },
    });
    const next = await fakeMachine('next', offer(0.5), { result: { job: 'j1' } });
    machines.push(busy, next);

    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target: TARGET,
      here: HERE,
      note: () => {},
      machines: [credential('busy'), credential('next')],
    });
    if (typeof choice === 'string') throw new Error(choice);
    expect(choice.machine).toBe('busy');

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

    expect(placements).toEqual([
      'placement: next (busy could not take the build: start: build-busy: This machine declines the build: all 1 build slots busy.)',
    ]);
    expect(outcome).toEqual({ ok: false, machine: 'next', reason: 'worker-failed: xcodebuild failed' });
    expect(busy.methods).toEqual(['hello', 'build.offer', 'build.sync', 'build.start']);
    expect(next.methods).toEqual(['hello', 'build.offer', 'build.sync', 'build.start']);
    await busy.closed;
  });

  it.each([
    { features: ['fingerprint-sources', 'fingerprint-ignored', 'fingerprint-tracked'], ignored: true, tracked: true },
    { features: ['fingerprint-sources', 'fingerprint-ignored'], ignored: true, tracked: false },
    { features: [], ignored: false, tracked: false },
  ])(
    'sends the paths the client git ignored or tracked only to a machine with the matching feature: $features',
    async ({ features, ignored, tracked }) => {
      const machine = await fakeMachine(
        'mini',
        offer(0.1),
        { result: { job: 'j1' } },
        {
          hello: () => ({
            result: {
              capabilities: ['build'],
              features,
            },
          }),
        },
      );
      machines.push(machine);
      const choice = await chooseBuildMachine({
        projectRoot: repo,
        target: TARGET,
        here: HERE,
        note: () => {},
        machines: [credential('mini')],
      });
      if (typeof choice === 'string') throw new Error(choice);
      await offloadBuild({
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
        fingerprintInputs: async () => ({
          sources: [],
          ignored: [],
          ignoredPaths: ['.env.local', 'ios/main.jsbundle'],
          trackedPaths: ['GoogleService-Info.plist'],
        }),
        stagingDir: join(repo, 'staging'),
        onPhase: () => {},
        onEnter: () => {},
        onRecord: () => {},
        note: () => {},
      });
      const start = machine.requests.find((entry) => entry.method === 'build.start')?.params;
      expect(start?.fingerprintIgnored).toEqual(ignored ? ['.env.local', 'ios/main.jsbundle'] : undefined);
      expect(start?.fingerprintTracked).toEqual(tracked ? ['GoogleService-Info.plist'] : undefined);
    },
  );

  it('builds here when every machine refuses build.start', async () => {
    const refusal = { error: { code: 'build-busy', message: 'busy' } };
    const first = await fakeMachine('first', offer(0.1), refusal);
    const second = await fakeMachine('second', offer(0.5), refusal);
    machines.push(first, second);
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target: TARGET,
      here: HERE,
      note: () => {},
      machines: [credential('first'), credential('second')],
    });
    if (typeof choice === 'string') throw new Error(choice);
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
      note: () => {},
    });
    expect(outcome).toEqual({ ok: false, machine: 'second', reason: 'start: build-busy: busy' });
  });

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

  it("keeps the worker's whole message when its build failed on a corrupt compilation cache", async () => {
    const message = `The shared compilation cache at /w/cas was corrupt (the compiler reported: ${'x'.repeat(300)}). Stim emptied it. Run the same command again.`;
    machines.push(
      await fakeMachine(
        'mini',
        offer(0.1),
        { result: { job: 'j1' } },
        {
          failure: { ok: false, code: 'STIM_COMPILATION_CACHE_CORRUPT', message },
        },
      ),
    );
    expect(await run(['mini'], () => {})).toEqual({
      ok: false,
      machine: 'mini',
      reason: `STIM_COMPILATION_CACHE_CORRUPT: ${message}`.slice(0, 300),
      compilationCacheCorrupt: message,
    });
  });

  it('reconnects and reattaches to the build when the connection drops while it runs', async () => {
    const machine = await fakeMachine('mini', offer(0.1), { result: { job: 'j1' } }, { drop: true });
    machines.push(machine);
    const lines: string[] = [];
    const outcome = await run(['mini'], (line) => lines.push(line));
    expect(outcome).toEqual({ ok: false, machine: 'mini', reason: 'worker-failed: xcodebuild failed' });
    expect(lines).toEqual([
      expect.stringMatching(/^offload: the connection to mini dropped \(the connection closed \(1006\)\); reattaching/),
      'offload: reattached to the build on mini',
    ]);
    expect(machine.methods.slice(-2)).toEqual(['hello', 'build.attach']);
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

  it('builds here at once when the machine closes the connection on purpose, as on a revocation', async () => {
    const machine = await fakeMachine('mini', offer(0.1), { result: { job: 'j1' } }, { closeAfterStart: 4401 });
    machines.push(machine);
    const lines: string[] = [];
    expect(await run(['mini'], (line) => lines.push(line))).toEqual({
      ok: false,
      machine: 'mini',
      reason: 'closed: the connection closed (4401 device revoked)',
    });
    expect(lines).toEqual([]);
    expect(machine.methods).not.toContain('build.attach');
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
  test.each([
    { native: true, scoped: true },
    { native: true, scoped: false },
    { native: false, scoped: true },
  ])('requests the native report only for a native target and capable peer: %j', async ({ native, scoped }) => {
    const machine = await fakeMachine(
      'worker',
      offer(0.1),
      { result: { job: 'unused' } },
      {
        hello: () => ({
          result: {
            capabilities: ['build'],
            features: ['native-xcode-build', ...(scoped ? ['native-xcode-toolchain'] : [])],
          },
        }),
      },
    );
    machines.push(machine);
    writeFileSync(join(repo, '.ruby-version'), 'ruby-3.3.4\n');
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target: native ? { ...TARGET, native: 'xcode' } : TARGET,
      here: HERE,
      note: () => {},
      machines: [credential('worker')],
    });
    if (typeof choice === 'string') throw new Error(choice);
    try {
      const request = machine.requests.find((entry) => entry.method === 'build.offer');
      expect(request?.params.native).toBe(native && scoped ? 'xcode' : undefined);
      expect(request?.params.rubyVersion).toBe(native && scoped ? undefined : '3.3.4');
      expect(machine.methods).toEqual(['hello', 'build.offer']);
    } finally {
      closeOffload(choice);
    }
  });

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

describe('native Gradle worker transfer', () => {
  const target: BuildTarget = {
    platform: 'android',
    native: 'gradle',
    local: { stimBuild: 'b1', compat: 1, arch: 'arm64', jdk: '17' },
    requires: { ndk: null, buildTools: null, compileSdk: null },
  };
  test.each([
    { capable: false, cache: false },
    { capable: true, cache: false },
    { capable: true, cache: true },
  ])('negotiates source upload and artifact policy (capable=$capable, cache=$cache)', async ({ capable, cache }) => {
    const policy = { read: false, write: true, remote: true };
    const machine = await fakeMachine(
      'gradle',
      {
        ...offer(0.1),
        toolchain: { ...TOOLCHAIN, jdk: '17', androidSdk: { ndk: [], buildTools: [], platforms: ['android-35'] } },
      },
      { result: { job: 'j-gradle' } },
      {
        hello: () => ({
          result: {
            capabilities: ['build'],
            features: capable
              ? ['native-gradle-build', ...(cache ? ['native-gradle-artifact-cache', 'build-jdk'] : [])]
              : ['native-xcode-build'],
          },
        }),
      },
    );
    machines.push(machine);
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target,
      here: HERE,
      note: () => {},
      machines: [credential('gradle')],
    });
    expect(typeof choice).toBe(capable ? 'object' : 'string');
    const refusal = expect.stringContaining('does not support native Gradle builds');
    expect(typeof choice === 'string' ? choice : 'qualified').toEqual(capable ? 'qualified' : refusal);
    expect(machine.methods).toEqual(capable ? ['hello', 'build.offer'] : ['hello']);
    if (!capable) return;
    if (typeof choice === 'string') throw new Error(choice);
    writeFileSync(join(repo, '.gitignore'), 'generated.json\nsecret.txt\n');
    writeFileSync(join(repo, 'generated.json'), 'declared');
    writeFileSync(join(repo, 'secret.txt'), 'private');
    const transfer = await nativeGradleTransfer(repo, { complete: true, ignored: ['generated.json'], outputs: [] });
    const outcome = await offloadBuild({
      choice,
      expectedFingerprint: null,
      request: {
        platform: 'android',
        isExpo: false,
        native: { provider: 'gradle', transfer, cache: policy },
        android: { variant: 'freeRelease', abi: null, gradleBuildCache: true, pch: 'auto', compilerCache: 'none' },
      },
      stagingDir: join(repo, 'staging'),
      onPhase: () => {},
      onEnter: () => {},
      onRecord: () => {},
      note: () => {},
    });
    expect(outcome.ok).toBe(false);
    const start = machine.requests.find((entry) => entry.method === 'build.start')!.params;
    expect(start).toMatchObject({
      platform: 'android',
      fingerprint: null,
      native: { provider: 'gradle', sourceDigest: transfer.digest, inputs: transfer.declaration },
    });
    expect(start.jdk).toBe(cache ? '17' : undefined);
    expect(start.native).toEqual({
      provider: 'gradle',
      sourceDigest: transfer.digest,
      inputs: transfer.declaration,
      ...(cache ? { cache: policy } : {}),
    });
    const paths = machine.requests
      .filter((entry) => entry.method === 'build.sync')
      .flatMap((entry) => (entry.params.files as Array<{ path: string }>).map((file) => file.path));
    expect(paths).toContain('generated.json');
    expect(paths).not.toContain('secret.txt');
  });
});

describe('exact peer artifacts', () => {
  test.each([
    { name: 'React Native', target: TARGET, dependencies: true },
    {
      name: 'SwiftPM',
      target: {
        platform: 'macos',
        local: { stimBuild: 'b1', compat: 1, arch: 'arm64', xcode: 'Xcode 27.0', macosSdk: '27.0' },
      } satisfies BuildTarget,
      dependencies: false,
    },
    { name: 'native Xcode', target: { ...TARGET, native: 'xcode' } satisfies BuildTarget, dependencies: false },
  ])(
    '$name only asks for dependency hints relevant to its build and supported by its worker, and keeps the configured order',
    async ({ target, dependencies }) => {
      const projectRoot = join(repo, 'apps', 'mobile');
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(join(projectRoot, 'package.json'), '{"name":"app"}');
      writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfile');
      const legacy = await fakeMachine(
        'legacy',
        { ...offer(0.1), warm: { checkout: true, dependencies: true, build: true } },
        { result: { job: 'unused' } },
        {
          hello: () => ({
            result: { capabilities: ['build'], features: ['native-xcode-build', 'native-xcode-toolchain'] },
          }),
        },
      );
      const modern = await fakeMachine(
        'modern',
        { ...offer(0.2), warm: { checkout: false, dependencies: true, build: false } },
        { result: { job: 'unused' } },
        {
          hello: () => ({
            result: {
              capabilities: ['build'],
              features: ['build-dependency-cache', 'native-xcode-build', 'native-xcode-toolchain'],
            },
          }),
        },
      );
      machines.push(legacy, modern);
      const choice = await chooseBuildMachine({
        projectRoot,
        target,
        selected: 'remote',
        here: HERE,
        machines: [credential('legacy'), credential('modern')],
        note: () => {},
      });
      if (typeof choice === 'string') throw new Error(choice);
      try {
        expect(choice.machine).toBe('legacy');
        expect(legacy.requests.find((request) => request.method === 'build.offer')?.params).not.toHaveProperty(
          'dependencies',
        );
        expect(modern.requests.find((request) => request.method === 'build.offer')?.params.dependencies).toEqual(
          dependencies ? { project: 'apps/mobile', packageName: 'app' } : undefined,
        );
      } finally {
        closeOffload(choice);
      }
    },
  );

  test.each(['offer', 'fetch'] as const)('Stop interrupts the SwiftPM %s source scan', async (stage) => {
    const machine = await fakeMachine(
      'swiftpm',
      {
        ...offer(3),
        artifact: {
          fingerprint: 'f'.repeat(64),
          cacheKey: `swiftpm-peer-${'f'.repeat(64)}`,
          name: 'Sample.app',
          size: 1,
          sha256: 'a'.repeat(64),
        },
      },
      { result: { job: 'unused' } },
      { hello: () => ({ result: { capabilities: ['build'], features: ['swiftpm-peer-cache', 'build-compat'] } }) },
    );
    machines.push(machine);
    const request: Extract<BuildRequest, { platform: 'macos' }> = {
      platform: 'macos',
      product: 'App',
      infoPlist: 'Info.plist',
      bundleId: 'dev.example.App',
      cacheArtifact: true,
      artifactInputs: { complete: true, ignored: [], outputs: [], localFiles: [], environment: [] },
    };
    const choose = () =>
      chooseBuildMachine({
        projectRoot: repo,
        target: {
          platform: 'macos',
          local: { stimBuild: 'b1', compat: 1, arch: 'arm64', xcode: 'Xcode 27.0', macosSdk: '27.0' },
        },
        here: { ...HERE, builds: 0 },
        machines: [credential('swiftpm')],
        swiftpmArtifact: request,
        cacheOnly: true,
        note: () => {},
      });
    const choice = stage === 'fetch' ? await choose() : null;
    if (typeof choice === 'string') throw new Error(choice);
    const before = [...machine.methods];
    const executor = getExecutor();
    const original = executor.runFileAsync.bind(executor);
    let scanning = false;
    let release = () => {};
    const spy = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
      if (file !== 'git' || !args.includes('ls-files')) return original(file, args, options);
      scanning = true;
      return new Promise<string>((resolve, reject) => {
        const abort = () => reject(options.signal?.reason);
        options.signal?.addEventListener('abort', abort, { once: true });
        release = () => {
          options.signal?.removeEventListener('abort', abort);
          resolve('package.json\0');
        };
      });
    });
    const context = testContext();
    try {
      await withAmbientContext(context, () =>
        withNativeBuildRun(
          context,
          repo,
          { command: 'macos', platform: 'macos' },
          async (claim) => {
            let finished: unknown;
            const work = choice
              ? offloadBuild({
                  choice,
                  request,
                  stagingDir: join(home, 'staging'),
                  onPhase: () => {},
                  onEnter: () => {},
                  onRecord: () => {},
                  note: () => {},
                })
              : choose();
            const pending = work.then(
              (value) => (finished = { value }),
              (error: unknown) => (finished = { error }),
            );
            try {
              await vi.waitUntil(() => scanning);
              requestNativeRunCancel(repo, claim.claimId);
              await vi.waitFor(() => expect(finished).toHaveProperty('error'));
              expect(machine.methods).toEqual(before);
            } finally {
              release();
              await pending;
            }
          },
          { write: () => {} },
        ),
      );
    } finally {
      spy.mockRestore();
      if (choice) closeOffload(choice);
    }
  });

  test.each(['hit', 'miss', 'corrupt', 'old-worker', 'changed-source', 'changed-during-fetch', 'crlf-listing'] as const)(
    'SwiftPM cache-only %s never uploads sources or starts a compiler job',
    async (scenario) => {
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
      const tarSpy = scenario === 'crlf-listing'
        ? vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) =>
            file === 'tar' && args[0] === '-tf'
              ? Promise.resolve('Sample.app/\r\nSample.app/Contents/\r\nSample.app/Contents/Info.plist\r\nSample.app/Contents/MacOS/\r\nSample.app/Contents/MacOS/App\r\n')
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
    },
  );

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

  test.each(['hit', 'miss', 'corrupt', 'escaping-link', 'extra-file', 'changed-request', 'old-worker'] as const)(
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
              features: ['native-gradle-build', ...(scenario === 'old-worker' ? [] : ['native-gradle-peer-cache'])],
            },
          }),
          artifact: { archive, digest },
          cachedFetch: scenario === 'miss' || scenario === 'corrupt' ? scenario : 'hit',
        },
      );
      machines.push(machine);
      const query = { sourceDigest: transfer.digest, inputs: transfer.declaration, android };
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
      expect(typeof choice).toBe(scenario === 'old-worker' ? 'string' : 'object');
      expect(offerRequest.params.gradleArtifact).toEqual(
        scenario === 'old-worker' ? undefined : { ...query, project: '' },
      );
      expect(machine.methods).toEqual(['hello', 'build.offer']);
      if (scenario === 'old-worker') return;
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

  test.each(['auto', 'remote', 'named'] as const)(
    'a vanished Gradle APK reapplies %s placement before compiling, so only a named machine compiles while saturated',
    async (selection) => {
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
            result: { capabilities: ['build'], features: ['native-gradle-build', 'native-gradle-peer-cache'] },
          }),
          cachedFetch: 'miss',
        },
      );
      machines.push(machine);
      const choice = await chooseBuildMachine({
        projectRoot: repo,
        target: gradleTarget,
        selected: selection === 'named' ? 'gradle' : selection,
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
      expect(machine.methods.includes('build.start')).toBe(selection === 'named');
      expect(
        machine.requests
          .filter((entry) => entry.method === 'build.offer')
          .map((entry) => Boolean(entry.params.gradleArtifact)),
      ).toEqual([true, false]);
    },
  );

  it.each(['hit', 'miss', 'corrupt', 'escaping-link', 'extra-file'] as const)(
    'reuses verified bytes without syncing or compiling; %s',
    async (cachedFetch) => {
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

  it('old workers receive no new parameters and are skipped for cache-only lookups', async () => {
    const machine = await fakeMachine(
      'old',
      offer(0.1),
      { result: { job: 'unused' } },
      {
        hello: () => ({ result: { capabilities: ['build'], features: ['native-xcode-build'] } }),
      },
    );
    machines.push(machine);
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target: { ...TARGET, native: 'xcode' },
      here: HERE,
      machines: [credential('old')],
      artifact: { fingerprint: 'native', cacheKey: 'other-sdk' },
      cacheOnly: true,
      note: () => {},
    });
    expect(typeof choice).toBe('string');
    const lookup = machine.requests.find((entry) => entry.method === 'build.offer');
    expect(lookup?.params).toEqual(expect.not.objectContaining({ artifact: expect.anything() }));
    expect(machine.methods).not.toContain('build.start');
  });
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

test.each(['auto', 'remote', 'named'] as const)(
  'a vanished artifact reapplies %s placement before compiling on the same peer, so only a named machine compiles while saturated',
  async (selection) => {
    const archive = Buffer.from('cached bytes');
    const identity = { fingerprint: 'native', cacheKey: 'native-sdk27-arm64-target' };
    const cachedOffer = {
      ...offer(4),
      artifact: {
        ...identity,
        name: 'Sample.app',
        size: archive.length,
        sha256: createHash('sha256').update(archive).digest('hex'),
      },
    };
    const machine = await fakeMachine(
      'mini',
      cachedOffer,
      { result: { job: 'new-build' } },
      {
        hello: () => ({
          result: {
            capabilities: ['build'],
            features: ['native-xcode-build', 'native-xcode-toolchain', 'build-artifact-cache'],
          },
        }),
        cachedFetch: 'miss',
      },
    );
    machines.push(machine);
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target: { ...TARGET, native: 'xcode' },
      selected: selection === 'named' ? 'mini' : selection,
      here: { ...HERE, builds: 0, loadPerCore: 3 },
      machines: [credential('mini')],
      artifact: identity,
      note: () => {},
    });
    if (typeof choice === 'string') throw new Error(choice);
    const result = await offloadBuild({
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
      stagingDir: join(repo, 'staging'),
      onEnter: () => {},
      onPhase: () => {},
      onRecord: () => {},
      note: () => {},
    });
    expect(result.ok).toBe(false);
    expect(machine.methods.includes('build.start')).toBe(selection === 'named');
    expect(machine.methods.filter((method) => method === 'build.offer')).toHaveLength(2);
  },
);
