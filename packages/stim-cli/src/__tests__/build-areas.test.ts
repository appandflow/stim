import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMachinesFile, MACHINE_CREDENTIALS_VERSION, type BuildAreaRecord } from '@stim-cli/core/state';
import * as buildMachines from '../offload/build-machines.ts';
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

const record = (machine: string, checkout: string): BuildAreaRecord => ({ machine, repo: `app-${machine}`, checkout });

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

test('skips a worker that is older, closes, cannot be reached, never answers or is no longer paired, within one deadline', async () => {
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
});
