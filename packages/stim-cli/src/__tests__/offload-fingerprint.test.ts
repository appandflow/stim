import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildFingerprintParams } from '@stim-cli/core/protocol';
import { BuildHost } from '../job/offload/host.ts';

let home: string;
let host: BuildHost;
let session: ReturnType<BuildHost['session']>;
const source = (id: string) => ({ id, kind: 'file' as const, hash: 'a'.repeat(64) });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-fingerprint-chunks-'));
  vi.stubEnv('STIM_HOME', home);
  host = new BuildHost({ worker: 'unused', env: process.env, limits: { minFreeBytes: 0 } });
  session = host.session('client', { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {} }, () => {});
});

afterEach(async () => {
  session.close();
  await host.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const start = {
  repo: 'repo',
  project: '',
  platform: 'ios',
  runtime: 'iOS-27-0',
  stimBuild: 'b1',
  compat: 6,
  fingerprint: 'a'.repeat(64),
  fingerprintSchema: 2,
  fingerprintNative: 'tracked',
  fingerprintEnv: { set: {}, absent: [] },
  fingerprintLayout: { projectPath: null, gradleRoot: null, module: null },
  fingerprintRuntime: { node: '22.22', evaluator: '0'.repeat(64), packages: {} },
};

test.each(['no sync', 'incomplete sync', 'different repo', 'already started'])(
  'fingerprint chunks require a pending build: %s',
  async (state) => {
    if (state !== 'no sync') session.sync({ repo: 'repo', files: [], done: state !== 'incomplete sync' });
    if (state === 'already started') await session.start({});
    expect(
      session.fingerprint({ repo: state === 'different repo' ? 'other' : 'repo', fingerprintSources: [] }),
    ).toMatchObject({ error: { code: 'bad-request', message: expect.stringContaining('pending build') } });
  },
);

test.each([
  {
    name: 'sources',
    chunk: (offset: number): BuildFingerprintParams => ({
      repo: 'repo',
      fingerprintSources: Array.from({ length: 200 }, (_, i) => source(`input-${offset + i}`)),
    }),
    overflow: { fingerprintSources: [source('last')] },
  },
  {
    name: 'set environment',
    chunk: (offset: number): BuildFingerprintParams => ({
      repo: 'repo',
      fingerprintEnv: {
        set: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`APP_${offset + i}`, 'value'])),
        absent: [],
      },
    }),
    overflow: { fingerprintEnv: { set: { APP_LAST: 'value' }, absent: [] } },
  },
  {
    name: 'absent environment',
    chunk: (offset: number): BuildFingerprintParams => ({
      repo: 'repo',
      fingerprintEnv: { set: {}, absent: Array.from({ length: 200 }, (_, i) => `APP_${offset + i}`) },
    }),
    overflow: { fingerprintEnv: { set: {}, absent: ['APP_LAST'] } },
  },
  {
    name: 'declared paths',
    chunk: (): BuildFingerprintParams => ({
      repo: 'repo',
      fingerprintInputs: Array.from({ length: 200 }, (_, i) => `native/input-${i}`),
    }),
    overflow: { fingerprintInputs: ['last'] },
  },
])('caps cumulative $name rows across chunks', ({ chunk, overflow }) => {
  session.sync({ repo: 'repo', files: [], done: true });
  for (let offset = 0; offset < 20_000; offset += 200)
    expect(session.fingerprint(chunk(offset))).toEqual({ result: {} });
  expect(session.fingerprint({ repo: 'repo', ...overflow })).toMatchObject({ error: { code: 'limit-exceeded' } });
});

test.each([
  {
    name: 'duplicate source ids',
    first: { fingerprintSources: [source('same')] },
    next: { fingerprintSources: [source('same')] },
  },
  { name: 'invalid source hash', first: {}, next: { fingerprintSources: [{ ...source('input'), hash: 'bad' }] } },
  {
    name: 'duplicate set names',
    first: { fingerprintEnv: { set: { APP_NAME: 'one' }, absent: [] } },
    next: { fingerprintEnv: { set: { APP_NAME: 'two' }, absent: [] } },
  },
  {
    name: 'set and absent overlap',
    first: { fingerprintEnv: { set: { APP_NAME: 'one' }, absent: [] } },
    next: { fingerprintEnv: { set: {}, absent: ['APP_NAME'] } },
  },
])('rejects $name across chunks', ({ first, next }) => {
  session.sync({ repo: 'repo', files: [], done: true });
  expect(session.fingerprint({ repo: 'repo', ...first })).toEqual({ result: {} });
  expect(session.fingerprint({ repo: 'repo', ...next })).toMatchObject({ error: { code: 'bad-request' } });
});

test('caps bytes held across otherwise valid small chunks', () => {
  session.sync({ repo: 'repo', files: [], done: true });
  let reply: ReturnType<typeof session.fingerprint> = { result: {} };
  for (let i = 0; i < 400; i++) {
    const params = { repo: 'repo', fingerprintEnv: { set: { [`APP_${i}`]: 'x'.repeat(50_000) }, absent: [] } };
    expect(Buffer.byteLength(JSON.stringify({ id: i, method: 'build.fingerprint', params }))).toBeLessThan(64 * 1024);
    reply = session.fingerprint(params);
    if ('error' in reply) break;
  }
  expect(reply).toMatchObject({
    error: { code: 'limit-exceeded', message: expect.stringContaining('bytes per connection') },
  });
});

test.each(['disconnect', 'start', 'new sync'] as const)('drops held chunks on %s', async (action) => {
  const launch = vi.spyOn(host, 'launch').mockResolvedValue({ error: { code: 'build-refused', message: 'admitted' } });
  session.sync({ repo: 'repo', files: [], done: true });
  session.fingerprint({ repo: 'repo', fingerprintSources: [source('stale')] });
  if (action === 'disconnect') session.close();
  if (action === 'start') await session.start({});
  if (action === 'new sync') session.sync({ repo: 'repo', files: [], done: true });
  expect(await session.start(start)).toMatchObject({
    error: { code: 'bad-request', message: expect.stringContaining('fingerprint replay') },
  });
  expect(launch).not.toHaveBeenCalled();
  if (action === 'disconnect')
    session = host.session('client', { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {} }, () => {});
  session.sync({ repo: 'repo', files: [], done: true });
  expect(session.fingerprint({ repo: 'repo', fingerprintSources: [] })).toEqual({ result: {} });
  expect(await session.start(start)).toMatchObject({ error: { message: 'admitted' } });
  expect(launch.mock.calls[0]![0].job.expectedSources).toEqual([]);
});

test('assembled declared paths still need their matching fingerprint row', async () => {
  const launch = vi.spyOn(host, 'launch');
  session.sync({ repo: 'repo', files: [], done: true });
  session.fingerprint({
    repo: 'repo',
    fingerprintSources: [source('stim:fingerprintInputs')],
    fingerprintInputs: ['native/extra'],
  });
  expect(await session.start(start)).toMatchObject({
    error: { code: 'bad-request', message: expect.stringContaining('fingerprint replay') },
  });
  expect(launch).not.toHaveBeenCalled();
});
