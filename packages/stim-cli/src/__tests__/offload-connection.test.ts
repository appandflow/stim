import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BuildMachineCredential, MachineCapacity } from '@stim-cli/core/state';
import { chooseBuildMachine, offloadBuild, type BuildOffer } from '../offload/client.ts';
import { manifestDigest } from '../offload/manifest.ts';
import type { BuildTarget } from '../offload/toolchain.ts';

const ports = new Map<string, number>();

vi.mock('../offload/build-machines.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../offload/build-machines.ts')>()),
  pinnedEndpoint: (credential: BuildMachineCredential) => ({
    url: `ws://127.0.0.1:${ports.get(credential.machine)}`,
    servername: credential.dnsName,
    host: credential.dnsName,
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
  local: { stimBuild: 'b1', arch: 'arm64', xcode: 'Xcode 27.0', simulatorSdk: '27.0', cocoapods: '1.16.2' },
  runtime: 'iOS-27-0',
  cocoapodsPinned: false,
};

const HERE: MachineCapacity = { cpus: 10, loadPerCore: 0.1, builds: 1, maxBuilds: 1, maxLoadPerCore: 2 };

interface FakeMachine {
  methods: string[];
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  closed: Promise<void>;
  stop: () => Promise<void>;
}

const FAILED = { ok: false, code: 'worker-failed', message: 'xcodebuild failed' };

/**
 * A build machine that offers `offer` and answers `build.start` with `start`, then reports a failed build. With
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
  }: {
    drop?: boolean;
    closeAfterStart?: number | null;
    dropOnSync?: boolean;
    attach?: object;
    hello?: () => object;
    artifact?: { archive: Buffer; digest: string } | null;
  } = {},
): Promise<FakeMachine> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  ports.set(machine, (server.address() as AddressInfo).port);
  const methods: string[] = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let closed!: () => void;
  const done = new Promise<void>((resolve) => (closed = resolve));
  server.on('connection', (socket: WebSocket) => {
    socket.on('close', () => closed());
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const { id, method, params } = JSON.parse(String(data)) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      requests.push({ method, params });
      methods.push(method);
      const reply = (body: object) => socket.send(JSON.stringify({ id, ...body }));
      if (method === 'hello') return reply(hello());
      if (method === 'build.cancel') return;
      if (method === 'build.offer') return reply({ result: offer });
      if (method === 'build.sync') return dropOnSync ? socket.terminate() : reply({ result: { missing: [] } });
      const fail = (job: string) =>
        socket.send(
          JSON.stringify({
            event: 'build.progress',
            job,
            outcome: artifact
              ? {
                  ok: true,
                  artifact: { name: 'Sample.app', size: artifact.archive.length, sha256: artifact.digest },
                  compilationCache: {},
                }
              : FAILED,
          }),
        );
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
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const credential = (machine: string): BuildMachineCredential => ({
  machine,
  nodeId: `n-${machine}`,
  dnsName: `${machine}.example.ts.net`,
  deviceId: 'd1',
  deviceToken: 't1',
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
const machines: FakeMachine[] = [];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'stim-offload-'));
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'package.json'), '{}');
});

afterEach(async () => {
  await Promise.all(machines.splice(0).map((machine) => machine.stop()));
  rmSync(repo, { recursive: true, force: true });
  ports.clear();
});

async function run(names: string[], note: (line: string) => void) {
  const choice = await chooseBuildMachine({
    projectRoot: repo,
    target: TARGET,
    mode: 'auto',
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
  it('moves to the next machine in placement order when the chosen one refuses build.start', async () => {
    const busy = await fakeMachine('busy', offer(0.1), {
      error: { code: 'build-busy', message: 'This Mac declines the build: all 1 build slots busy.' },
    });
    const next = await fakeMachine('next', offer(0.5), { result: { job: 'j1' } });
    machines.push(busy, next);

    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target: TARGET,
      mode: 'auto',
      here: HERE,
      note: () => {},
      machines: [credential('next'), credential('busy')],
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
      'placement: next (busy could not take the build: start: build-busy: This Mac declines the build: all 1 build slots busy.)',
    ]);
    expect(outcome).toEqual({ ok: false, machine: 'next', reason: 'worker-failed: xcodebuild failed' });
    expect(busy.methods).toEqual(['hello', 'build.offer', 'build.sync', 'build.start']);
    expect(next.methods).toEqual(['hello', 'build.offer', 'build.sync', 'build.start']);
    await busy.closed;
  });

  it('builds here when every machine refuses build.start', async () => {
    const refusal = { error: { code: 'build-busy', message: 'busy' } };
    const first = await fakeMachine('first', offer(0.1), refusal);
    const second = await fakeMachine('second', offer(0.5), refusal);
    machines.push(first, second);
    const choice = await chooseBuildMachine({
      projectRoot: repo,
      target: TARGET,
      mode: 'auto',
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
      mode: 'auto',
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

  it('keeps reconnecting while the machine cannot identify this Mac for a moment', async () => {
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

  it('stops reconnecting when the machine turns this Mac away', async () => {
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
            : { error: { code: 'unauthorized', message: 'This Mac does not recognize this device token.' } },
      },
    );
    machines.push(machine);
    expect(await run(['mini'], () => {})).toEqual({
      ok: false,
      machine: 'mini',
      reason:
        'closed: the connection closed (1006); the machine turned this Mac away (This Mac does not recognize this device token.)',
    });
    expect(hellos).toBe(2);
  });
});

describe('macOS artifact transfer', () => {
  it.each(['valid', 'missing-plist', 'missing-executable', 'bad-digest'])(
    'accepts only a complete macOS app with the verified archive digest: %s',
    async (kind) => {
      const contents = join(repo, 'archive-source', 'Sample.app', 'Contents');
      mkdirSync(join(contents, 'MacOS'), { recursive: true });
      if (kind !== 'missing-plist') writeFileSync(join(contents, 'Info.plist'), '{}');
      if (kind !== 'missing-executable') writeFileSync(join(contents, 'MacOS', 'Sample'), 'binary');
      const archivePath = join(repo, 'artifact.tgz');
      execFileSync('tar', ['-czf', archivePath, '-C', join(repo, 'archive-source'), 'Sample.app']);
      const archive = readFileSync(archivePath);
      const digest = kind === 'bad-digest' ? '00'.repeat(32) : createHash('sha256').update(archive).digest('hex');
      const machine = await fakeMachine(
        'mini',
        offer(0.1),
        { result: { job: 'j1' } },
        { artifact: { archive, digest } },
      );
      machines.push(machine);
      const choice = await chooseBuildMachine({
        projectRoot: repo,
        target: { platform: 'macos', local: { stimBuild: 'b1', arch: 'arm64', xcode: 'Xcode 27.0', macosSdk: '27.0' } },
        mode: 'force',
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
        kind === 'bad-digest' ? 'sha256' : kind === 'missing-plist' ? 'Contents/Info.plist' : 'Contents/MacOS/Sample',
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
