import assert from 'node:assert';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'node:url';

import { getExecutor, resetExecutor } from '../exec.ts';
import { upsertProject, saveConfig, getProject, claimMetroPort } from '../workspace/config.ts';
import { computeNextPort, createPortProbe, findReclaimablePort, allocatePort, reserveMetroPort } from '../ports.ts';
import * as listeners from '../listening-ports.ts';

const allFree = async () => true;

test.each([null, 25062])('cancelled port reservation does not claim a port (pinned %s)', async (pinned) => {
  upsertProject('/a', { metroPort: null });
  await expect(reserveMetroPort('/a', async () => false, allFree, pinned, AbortSignal.abort())).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(getProject('/a')?.metroPort).toBeNull();
});

test('cancellation after a reclaim probe preserves the old workspace reservation', async () => {
  const root = join(tmpHome, 'gone');
  upsertProject(root, { metroPort: 25063 });
  const controller = new AbortController();
  await expect(
    allocatePort(
      root + '-new',
      async () => false,
      async () => {
        controller.abort();
        return true;
      },
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(getProject(root)?.metroPort).toBe(25063);
});

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  resetExecutor();
});

test('computeNextPort skips registry-claimed ports', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  claimMetroPort('/a', 8082);
  claimMetroPort('/b', 8083);
  expect(await computeNextPort(allFree)).toBe(8084);
});

test('findReclaimablePort returns null when no projects', async () => {
  const r = await findReclaimablePort('/excluded');
  expect(r).toBe(null);
});

test('findReclaimablePort skips the excluded project path', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  const r = await findReclaimablePort('/a', async () => false);
  expect(r).toBe(null);
});

test('findReclaimablePort returns first dead port and its owner', async () => {
  const a = join(tmpHome, 'gone-a');
  const b = join(tmpHome, 'gone-b');
  upsertProject(a, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject(b, { bundleId: 'b', androidPackage: 'b', isExpo: false });
  claimMetroPort(a, 8082);
  claimMetroPort(b, 8083);
  const probe = async (port: number) => port === 8082;
  const r = await findReclaimablePort(join(tmpHome, 'gone-c'), probe);
  expect(r).toEqual({ port: 8083, ownerPath: b });
});

test('findReclaimablePort does not reclaim live-path projects even with dead Metro', async () => {
  const liveDir = join(tmpHome, 'live-project');
  mkdirSync(liveDir, { recursive: true });
  upsertProject(liveDir, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort(liveDir, 8082);
  const r = await findReclaimablePort('/new', async () => false);
  expect(r).toBe(null);
});

test('allocatePort assigns a fresh port when nothing is reclaimable', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  const probe = async () => true;
  const port = await allocatePort('/new', probe, allFree);
  expect(port).toBe(8083);
});

test('computeNextPort skips a port that is occupied by a foreign process', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  const occupied = new Set([8082, 8083]);
  const port = await computeNextPort(async (p) => !occupied.has(p));
  expect(port).toBe(8084);
});

test('port probes observe a foreign IPv6 listener and refresh after it exits', async (t) => {
  const child = getExecutor().spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/ipv6-listener.mts', import.meta.url))],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(20_000) });
  try {
    const [port] = await once(child, 'message', { signal: AbortSignal.timeout(15_000) });
    if (port === null) t.skip('IPv6 loopback is unavailable');
    expect(typeof port).toBe('number');
    expect(await createPortProbe()(port)).toBe(false);
    child.kill();
    await exited;
    expect(await createPortProbe()(port)).toBe(true);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}, 30_000);

test('findReclaimablePort skips a project whose volume is not mounted', async () => {
  const unmounted = '/Volumes/NotPluggedIn/worktree';
  upsertProject(unmounted, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort(unmounted, 8082);
  const r = await findReclaimablePort('/new', async () => false, { isMounted: () => false });
  expect(r).toBe(null);
});

test('findReclaimablePort still reclaims a dead project on a mounted volume', async () => {
  upsertProject('/definitely/gone', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/definitely/gone', 8082);
  const r = await findReclaimablePort('/new', async () => false, { isMounted: () => true });
  expect(r).toEqual({ port: 8082, ownerPath: '/definitely/gone' });
});

test('reserveMetroPort moves on when another project claims the port first', async () => {
  const dirA = join(tmpHome, 'a');
  const dirB = join(tmpHome, 'b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  upsertProject(dirA, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject(dirB, { bundleId: 'b', androidPackage: 'b', isExpo: false });
  vi.spyOn(listeners, 'readListeningPorts')
    .mockImplementationOnce(async () => {
      claimMetroPort(dirA, 8082);
      return new Set<number>();
    })
    .mockResolvedValueOnce(new Set([8083]));
  const port = await reserveMetroPort(dirB, async () => false);
  expect(port).toBe(8084);
  const recB = getProject(dirB);
  const recA = getProject(dirA);
  assert(recB);
  assert(recA);
  expect(recB.metroPort).toBe(8084);
  expect(recA.metroPort).toBe(8082);
});

test('reserveMetroPort records a pinned port and refuses one another workspace reserved', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  expect(await reserveMetroPort('/a', async () => false, allFree, 25062)).toBe(25062);
  expect(getProject('/a')?.metroPort).toBe(25062);
  await expect(reserveMetroPort('/b', async () => false, allFree, 25062)).rejects.toThrow(/already reserved/);
  expect(getProject('/b')?.metroPort).toBeFalsy();
});

test('allocatePort does not reuse a reclaimable port that is now occupied', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  const deadMetro = async () => false;
  const isFree = async (p: number) => p !== 8082;
  const port = await allocatePort('/new', deadMetro, isFree);
  expect(port).not.toBe(8082);
  expect(port).toBe(8083);
});
