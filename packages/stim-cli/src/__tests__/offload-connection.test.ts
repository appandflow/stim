import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BuildMachineCredential, MachineCapacity } from '@stim-cli/core/state';
import { chooseBuildMachine, offloadBuild, type BuildOffer } from '../offload/client.ts';
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
  cocoapods: '1.16.2',
  runtimes: ['iOS-27-0'],
  jdk: null,
  androidSdk: null,
};

const TARGET: BuildTarget = {
  platform: 'ios',
  local: { stimBuild: 'b1', arch: 'arm64', xcode: 'Xcode 27.0', simulatorSdk: '27.0', cocoapods: '1.16.2' },
  runtime: 'iOS-27-0',
};

const HERE: MachineCapacity = { cpus: 10, loadPerCore: 0.1, builds: 1, maxBuilds: 1, maxLoadPerCore: 2 };

interface FakeMachine {
  methods: string[];
  closed: Promise<void>;
  stop: () => Promise<void>;
}

/** A build machine that offers `offer` and answers `build.start` with `start`, then reports a failed build. */
async function fakeMachine(
  machine: string,
  offer: BuildOffer,
  start: { error: { code: string; message: string } } | { result: { job: string } },
): Promise<FakeMachine> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  ports.set(machine, (server.address() as AddressInfo).port);
  const methods: string[] = [];
  let closed!: () => void;
  const done = new Promise<void>((resolve) => (closed = resolve));
  server.on('connection', (socket: WebSocket) => {
    socket.on('close', () => closed());
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const { id, method } = JSON.parse(String(data)) as { id: number; method: string };
      methods.push(method);
      const reply = (body: object) => socket.send(JSON.stringify({ id, ...body }));
      if (method === 'hello') return reply({ result: { capabilities: ['build'] } });
      if (method === 'build.offer') return reply({ result: offer });
      if (method === 'build.sync') return reply({ result: { missing: [] } });
      if (method === 'build.start') {
        reply(start);
        if ('result' in start) {
          socket.send(
            JSON.stringify({
              event: 'build.progress',
              job: start.result.job,
              outcome: { ok: false, code: 'worker-failed', message: 'xcodebuild failed' },
            }),
          );
        }
      }
    });
  });
  return {
    methods,
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
      'placement: next (busy refused the build: start: build-busy: This Mac declines the build: all 1 build slots busy.)',
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
});
