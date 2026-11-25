import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMachinesFile, MACHINE_CREDENTIALS_VERSION, type BuildAreaRecord } from '@stim-cli/core/state';
import * as buildMachines from '../offload/build-machines.ts';
import * as tailnet from '../offload/tailnet.ts';
import { BuildConnection, type Reply } from '../offload/client.ts';
import { dropBuildAreas } from '../offload/build-areas.ts';

let home: string;

function pair(...machines: string[]): void {
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    buildMachinesFile(),
    JSON.stringify({
      version: MACHINE_CREDENTIALS_VERSION,
      machines: machines.map((machine) => ({
        machine,
        transport: 'tailscale',
        address: machine,
        state: 'approved',
        requestedAt: '2026-11-01T00:00:00.000Z',
        serverKey: `${'K'.repeat(42)}A`,
        deviceId: machine,
      })),
    }),
  );
}

/** Each machine's worker answers `build.area.drop` with `answer`; `open` stands in for one that cannot be reached. */
function workers(answers: Record<string, (() => Promise<Reply>) | 'unreachable'>) {
  const requests: Array<{ machine: string; method: string; params: unknown }> = [];
  const closed: string[] = [];
  const open = vi.spyOn(BuildConnection, 'open').mockImplementation(async (target) => {
    const machine = target.host;
    const answer = answers[machine];
    if (answer === 'unreachable' || answer === undefined) return { failure: 'it did not answer', refused: false };
    return Object.assign(Object.create(BuildConnection.prototype), {
      request: (method: string, params: unknown) => {
        requests.push({ machine, method, params });
        return answer();
      },
      close: () => closed.push(machine),
    });
  });
  return { open, requests, closed };
}

const record = (machine: string, checkout: string): BuildAreaRecord => ({
  machine,
  repo: `app-${machine}`,
  checkout,
  device: statSync(home).dev,
});

/** A connection to `machine` that records each request it is sent and its close. */
function connectionTo(machine: string, requests: string[], closed: string[]) {
  return Object.assign(Object.create(BuildConnection.prototype), {
    request: async () => {
      requests.push(machine);
      return { result: { dropped: true } };
    },
    close: () => closed.push(machine),
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-build-areas-'));
  process.env.STIM_HOME = join(home, 'config');
  vi.spyOn(buildMachines, 'resolveEndpoint').mockImplementation(async (credential) => ({
    url: credential.machine,
    servername: credential.machine,
    host: credential.machine,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('asks each worker that built a removed checkout to drop its area, and none for a checkout that still exists', async () => {
  pair('mini', 'studio', 'kept');
  const live = join(home, 'live');
  mkdirSync(live);
  const gone = join(home, 'gone');
  const { requests, closed } = workers({
    mini: async () => ({ result: { dropped: true } }),
    studio: async () => ({ result: { dropped: false, kept: 'a Gradle daemon is running in it' } }),
    kept: async () => ({ result: { dropped: true } }),
  });

  const drops = await dropBuildAreas([record('mini', gone), record('studio', gone), record('kept', live)]);

  expect(drops).toEqual([
    { ...record('mini', gone), dropped: true },
    { ...record('studio', gone), kept: 'a Gradle daemon is running in it' },
  ]);
  expect(requests).toEqual([
    { machine: 'mini', method: 'build.area.drop', params: { repo: 'app-mini' } },
    { machine: 'studio', method: 'build.area.drop', params: { repo: 'app-studio' } },
  ]);
  expect(closed.toSorted()).toEqual(['mini', 'studio']);
});

test('skips a worker that is older, closes, cannot be reached, never answers or is no longer paired, within one deadline, and a quiet one for a while after', async () => {
  pair('old', 'closing', 'offline', 'silent');
  const gone = join(home, 'gone');
  let asked!: () => void;
  const silentAsked = new Promise<void>((resolve) => (asked = resolve));
  const { open, closed } = workers({
    old: async () => ({
      error: { code: 'forbidden', message: 'build.area.drop needs read access, which this connection does not have.' },
    }),
    closing: async () => ({ error: { code: 'closed', message: 'the connection closed (1006)' } }),
    offline: 'unreachable',
    silent: () =>
      new Promise<Reply>(() => {
        asked();
      }),
  });
  const machines = ['old', 'closing', 'offline', 'silent', 'unpaired'];

  const dropping = dropBuildAreas(machines.map((machine) => record(machine, gone)));
  await silentAsked;
  await vi.advanceTimersByTimeAsync(5_000);
  const drops = await dropping;

  expect(drops).toMatchObject([
    { machine: 'old', skipped: expect.stringMatching(/^forbidden/) },
    { machine: 'closing', skipped: expect.stringMatching(/^closed/) },
    { machine: 'offline', skipped: 'it did not answer' },
    { machine: 'silent', skipped: 'it did not answer in time' },
    { machine: 'unpaired', skipped: 'it is no longer paired for builds' },
  ]);
  expect(open.mock.calls.map(([target]) => target.host)).not.toContain('unpaired');
  expect(closed).toContain('silent');

  open.mockClear();
  const again = await dropBuildAreas(['offline', 'silent'].map((machine) => record(machine, gone)));
  expect(again).toMatchObject([
    { machine: 'offline', skipped: 'it did not answer a recent request' },
    { machine: 'silent', skipped: 'it did not answer a recent request' },
  ]);
  expect(open).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await dropBuildAreas([record('offline', gone)]);
  expect(open).toHaveBeenCalledTimes(1);
});

test('a worker that connects after the deadline is closed without being asked', async () => {
  pair('slow');
  const requests: string[] = [];
  const closed: string[] = [];
  let connecting!: () => void;
  const started = new Promise<void>((resolve) => (connecting = resolve));
  vi.spyOn(BuildConnection, 'open').mockImplementation(
    (_target, _key, _timeout, _capability, signal) =>
      new Promise((resolve) => {
        connecting();
        signal?.addEventListener('abort', () => resolve(connectionTo('slow', requests, closed)));
      }),
  );

  const dropping = dropBuildAreas([record('slow', join(home, 'gone'))]);
  await started;
  await vi.advanceTimersByTimeAsync(5_000);

  expect(await dropping).toMatchObject([{ machine: 'slow', skipped: 'it did not answer in time' }]);
  await vi.waitFor(() => expect(closed).toEqual(['slow']));
  expect(requests).toEqual([]);
});

test('a checkout that is back, or whose volume is not the one recorded, is never dropped', async () => {
  pair('mini', 'studio');
  const requests: string[] = [];
  const closed: string[] = [];
  const back = join(home, 'back');
  vi.spyOn(BuildConnection, 'open').mockImplementation(async (target) => {
    mkdirSync(back, { recursive: true });
    return connectionTo(target.host, requests, closed);
  });
  const unmounted = { ...record('studio', join(home, 'mnt', 'ssd', 'wt')), device: statSync(home).dev + 1 };

  const drops = await dropBuildAreas([record('mini', back), unmounted]);

  expect(drops).toMatchObject([{ machine: 'mini', skipped: 'its checkout is back' }]);
  expect(requests).toEqual([]);
  expect(closed).toEqual(['mini']);
});

describe('the hello of a build connection', () => {
  test('ends when its signal aborts, closing the socket', async () => {
    const socket = Object.assign(Object.create(EventEmitter.prototype), {
      send: vi.fn<(data: string) => void>(),
      terminate: vi.fn<() => void>(),
      ping: vi.fn<() => void>(),
    });
    vi.spyOn(tailnet, 'openAuthenticated').mockResolvedValue(socket);
    const controller = new AbortController();

    const opening = BuildConnection.open(
      { url: 'ws://mini', host: 'mini', servername: 'mini' },
      'key',
      60_000,
      'build',
      controller.signal,
    );
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
    controller.abort();

    expect(await opening).toMatchObject({ failure: 'the hello was cancelled' });
    expect(socket.terminate).toHaveBeenCalled();
  });
});
