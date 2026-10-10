import assert from 'node:assert';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { upsertProject, setDevice, saveConfig, getProject, claimMetroPort } from '../workspace/config.ts';
import { computeNextPort, createPortProbe, findReclaimablePort, allocatePort, reserveMetroPort } from '../ports.ts';
import * as listeners from '../listening-ports.ts';

const allFree = async () => true;

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

test('computeNextPort returns 8082 with no existing ports', async () => {
  expect(await computeNextPort(allFree)).toBe(8082);
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

test('allocatePort reuses a dead project port but keeps its devices and pending branch cleanup', async () => {
  const dead = join(tmpHome, 'dead-project');
  upsertProject(dead, {
    bundleId: 'a',
    androidPackage: 'a',
    isExpo: false,
    worktreeBranch: 'feature',
    worktreeBranchOwned: true,
    worktreeMainRoot: join(tmpHome, 'main'),
    worktreeRemovalComplete: true,
    worktreePendingBranchSha: 'abc123',
  });
  setDevice(dead, 'ios', { deviceUdid: 'U1', owned: true });
  claimMetroPort(dead, 8082);
  const port = await allocatePort('/new', async () => false, allFree);
  expect(port).toBe(8082);
  expect(getProject(dead)).toMatchObject({
    metroPort: null,
    platforms: { ios: { deviceUdid: 'U1', owned: true } },
    worktreeRemovalComplete: true,
    worktreePendingBranchSha: 'abc123',
  });
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

test('computeNextPort skips ports already in the registry AND occupied ports', async () => {
  saveConfig({
    version: 2,
    projects: { '/a': { metroPort: 8082 }, '/b': { metroPort: 8084 } },
    repos: {},
  });
  const occupied = new Set([8083]);
  const port = await computeNextPort(async (p) => !occupied.has(p));
  expect(port).toBe(8085);
});

test('computeNextPort reuses a gap left by a released project when it is genuinely free', async () => {
  saveConfig({ version: 2, projects: { '/a': { metroPort: 8083 } }, repos: {} });
  const port = await computeNextPort(async () => true);
  expect(port).toBe(8082);
});

test('computeNextPort throws rather than returning an occupied port when the range is exhausted', async () => {
  saveConfig({ version: 2, projects: {}, repos: {} });
  await expect(() => computeNextPort(async () => false)).rejects.toThrow(/no free Metro port/i);

  saveConfig({
    version: 2,
    projects: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`/reserved/${i}`, { metroPort: 8082 + i }])),
    repos: {},
  });
  const read = vi
    .spyOn(listeners, 'readListeningPorts')
    .mockRejectedValue(new Error('must not inspect reserved ports'));
  await expect(computeNextPort()).rejects.toThrow(/no free Metro port/i);
  expect(read).not.toHaveBeenCalled();
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

test('a netstat denied on stderr falls back and still detects a real listener', async () => {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: async (file, args, opts) => {
      if (file.endsWith('netstat')) {
        throw Object.assign(new Error('Command failed'), {
          status: 0,
          stdout: '',
          stderr: 'netstat: sysctl: net.inet.tcp.pcblist_n: Operation not permitted',
        });
      }
      return real.runFileAsync(file, args, opts);
    },
  });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    expect(await createPortProbe()(address.port)).toBe(false);
  } finally {
    server.close();
    await once(server, 'close');
  }
  expect(await createPortProbe()(address.port)).toBe(true);
});

test('without a listener table, a port is free only when lsof or both loopback connects answer', async () => {
  vi.spyOn(listeners, 'readListeningPorts').mockRejectedValue(new Error('no table'));
  const lsof = vi.spyOn(listeners, 'readLsofListeningPorts').mockResolvedValue(null);
  const connect = vi.spyOn(listeners, 'probeLoopback').mockResolvedValue('free');
  expect(await createPortProbe()(8082)).toBe(true);

  connect.mockImplementation(async (_port, host) => (host === '::1' ? 'unknown' : 'free'));
  await expect(createPortProbe()(8082)).rejects.toMatchObject({ code: 'STIM_PORT_INSPECTION_FAILED' });

  lsof.mockResolvedValue(new Set([8083]));
  expect(await createPortProbe()(8082)).toBe(true);
  expect(await createPortProbe()(8083)).toBe(false);
});

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

test('allocatePort does not delete the entry of a project on an unmounted volume', async () => {
  const unmounted = '/Volumes/NotPluggedIn/worktree';
  upsertProject(unmounted, { bundleId: 'a', androidPackage: 'a', isExpo: false });
  setDevice(unmounted, 'ios', { deviceUdid: 'U1', owned: true });
  claimMetroPort(unmounted, 8082);
  const port = await allocatePort('/new', async () => false, allFree);
  expect(port).not.toBe(8082);
  expect(getProject(unmounted)).toBeTruthy();
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

test('reserveMetroPort records the port it hands back', async () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const port = await reserveMetroPort('/a', async () => false, allFree);
  expect(port).toBe(8082);
  const rec = getProject('/a');
  assert(rec);
  expect(rec.metroPort).toBe(8082);
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
