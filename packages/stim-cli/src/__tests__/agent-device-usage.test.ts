import { parseDu } from '../devices/report-only-usage.ts';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDeviceUsageFile, readAgentDeviceUsage, readStatsReport } from '@stim-cli/core/state';
import { workspaceStateDir } from '@stim-cli/core';
import {
  getAgentDeviceUsage,
  parseRunnerMetadata,
  runnerInUse,
  runnerLastUsedAt,
} from '../devices/agent-device-usage.ts';
import { agentDeviceLines } from '../devices/agent-device-usage-output.ts';
import { parseAgentDeviceRecord } from '../devices/activity.ts';
import { inspectProcessStart, type ProcessStart } from '../process-identity.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';

let home: string;
let state: string;
let runner: string;
let sizes: Map<string, number>;
let du: ReturnType<typeof vi.fn<(file: string, args: string[]) => Promise<string>>>;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-agent-usage-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('STIM_HOME', join(home, 'stim'));
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '');
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', '');
  state = join(home, '.agent-device');
  runner = join(state, 'apple-runner');
  sizes = new Map();
  du = vi.fn<(file: string, args: string[]) => Promise<string>>(async (_file, args) => {
    const paths = args.filter((arg) => !arg.startsWith('-') && arg !== '4');
    return [...sizes]
      .filter(([dir]) =>
        paths.some((path) => dir === path || dir.startsWith(`${path}/`) || dir.startsWith(`${path}\\`)),
      )
      .map(([dir, bytes]) => `${bytes / 1024}\t${dir}`)
      .join('\n');
  });
  setExecutor({ runFileAsync: du });
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function directory(dir: string, kib: number): string {
  mkdirSync(dir, { recursive: true });
  sizes.set(dir, kib * 1024);
  return dir;
}

function entry(platform: string, name: string, kib: number): string {
  return directory(join(runner, 'derived', platform, name), kib);
}

test('du preserves readable partial output and paths with spaces', () => {
  const path = join(home, 'with spaces');
  expect(parseDu(`4\t${path}\ndu: denied\n8\t${home}\nnot a size`)).toEqual(
    new Map([
      [path, 4096],
      [home, 8192],
    ]),
  );
});

test('metadata and plist tolerate missing, malformed and invalid dates, falling back to directory mtime', () => {
  expect(parseRunnerMetadata('{"packageVersion":"0.21.20","xcodeBuildVersion":"27A266a"}')).toEqual({
    packageVersion: '0.21.20',
    xcodeBuildVersion: '27A266a',
  });
  for (const raw of [null, '{', 'null', '[]', '{"packageVersion":42}'])
    expect(parseRunnerMetadata(raw)).toEqual({ packageVersion: null, xcodeBuildVersion: null });
  const at = Date.parse('2026-10-05T17:44:35Z');
  expect(runnerLastUsedAt('<key>LastAccessedDate</key>\n<date>2026-10-05T17:44:35Z</date>', 0)).toBe(
    new Date(at).toISOString(),
  );
  for (const raw of [null, 'bad plist', '<key>LastAccessedDate</key><date>bad</date>'])
    expect(runnerLastUsedAt(raw, at)).toBe(new Date(at).toISOString());
  expect(runnerLastUsedAt(null, null)).toBe(null);
});

test('the fixture tree reports platforms, shared builds, small entries, locks, other state, workspace and hosted totals once', async () => {
  directory(state, 4_600_000);
  directory(runner, 4_400_000);
  directory(join(runner, 'derived'), 4_399_000);
  directory(join(runner, 'derived', 'Build'), 100_000);
  directory(join(runner, 'derived', 'ios-simulator'), 400_000);
  const big = entry('ios-simulator', 'cache-big', 230_000);
  const small = entry('ios-simulator', 'cache-nometa', 84);
  directory(`${big}.lock`, 4);
  writeFileSync(
    join(big, '.agent-device-runner-cache.json'),
    '{"packageVersion":"0.21.20","xcodeBuildVersion":"27A266a"}',
  );
  writeFileSync(join(big, 'info.plist'), '<key>LastAccessedDate</key>\n<date>2026-10-05T17:44:35Z</date>');
  utimesSync(small, new Date('2026-09-28T12:00:00Z'), new Date('2026-09-28T12:00:00Z'));
  directory(join(runner, 'derived', 'macos'), 200_000);
  entry('macos', 'cache-mac', 200_000);
  directory(join(state, 'sessions'), 100_000);
  directory(join(state, 'sessions', 'one'), 90_000);
  directory(join(state, 'logs'), 14_000);
  directory(join(state, 'ios-runner'), 119_000);
  for (let i = 1; i <= 6; i++) directory(join(state, `other-${i}`), i);
  const project = join(home, 'project');
  directory(project, 0);
  ensureWorkspaceStorage(project);
  const workspace = directory(join(workspaceStateDir(project), 'agent-device'), 8);
  const hosted = directory(join(process.env.STIM_HOME!, 'server', 'agent-device'), 9);
  directory(join(hosted, 'driver'), 9);
  writeFileSync(join(hosted, 'token'), 'secret');
  const report = await getAgentDeviceUsage();
  expect(report.bytes).toBe((4_600_000 + 8 + 9) * 1024);
  expect(report.runnerBuilds.sharedBytes).toBe((4_399_000 - 600_000) * 1024);
  expect(report.runnerBuilds.platforms.map((platform) => platform.platform)).toEqual(['ios-simulator', 'macos']);
  expect(report.runnerBuilds.platforms[0]!.entries.map((cache) => cache.name)).toEqual(['cache-big', 'cache-nometa']);
  expect(report.runnerBuilds.platforms[0]!.entries[0]).toMatchObject({
    packageVersion: '0.21.20',
    xcodeBuildVersion: '27A266a',
    lastUsedAt: '2026-10-05T17:44:35.000Z',
    inUseReason: 'lock',
  });
  expect(report.runnerBuilds.platforms[0]!.entries[1]).toMatchObject({
    packageVersion: null,
    lastUsedAt: '2026-09-28T12:00:00.000Z',
    inUse: false,
  });
  expect(report.stateDir.other.bytes).toBe(86_000 * 1024);
  expect(report.stateDir.other.largest.map((child) => child.name)).toEqual([
    'ios-runner',
    'other-6',
    'other-5',
    'other-4',
    'other-3',
  ]);
  expect(report.stateDir.sessions.count).toBe(1);
  expect(report.workspaces).toEqual([{ dir: workspace, projectRoot: project, bytes: 8192 }]);
  expect(report.hosted).toEqual({ dir: hosted, bytes: 9216, sessions: 2 });
  expect(du.mock.calls.map((call) => call[1])).toEqual([
    ['-k', '-d', '4', state],
    ['-sk', workspace, hosted],
  ]);
  expect(agentDeviceLines(report, true).join('\n')).toContain('in use (lock)');
});

test('an overridden state root measures runner builds separately without counting them in other state', async () => {
  state = directory(join(home, 'custom state'), 100);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', state);
  directory(join(state, 'sessions'), 60);
  directory(join(state, 'logs'), 10);
  directory(runner, 400);
  directory(join(runner, 'derived'), 390);
  const report = await getAgentDeviceUsage();
  expect(report.bytes).toBe(500 * 1024);
  expect(report.stateDir.other.bytes).toBe(30 * 1024);
  expect(du.mock.calls.map((call) => call[1])).toEqual([
    ['-k', '-d', '4', state],
    ['-k', '-d', '4', runner],
  ]);
});

function lease(dir: string, fields: Record<string, unknown> = {}) {
  return parseAgentDeviceRecord(
    'runner-lease',
    join(home, 'lease.json'),
    JSON.stringify({ deviceId: 'device', xctestrunPath: join(dir, 'Build', 'runner.xctestrun'), ...fields }),
  );
}

test('lease liveness accepts either owner or runner, compares start seconds and rejects dead or reused pids and path siblings', () => {
  const dir = join(runner, 'derived', 'ios-simulator', 'cache-a');
  const at = Date.parse('2026-09-28T11:55:59Z');
  const start = (pid: number): ProcessStart =>
    pid === 42 ? { status: 'running', startedAtMs: at + 234 } : { status: 'gone' };
  const live = lease(dir, {
    ownerPid: 42,
    ownerStartTime: new Date(at).toISOString(),
    runnerPid: 43,
    runnerStartTime: new Date(at).toISOString(),
  });
  expect(runnerInUse(dir, [live], false, false, start)).toEqual({ inUse: true, inUseReason: 'lease' });
  expect(runnerInUse(`${dir}-sibling`, [live], false, false, start).inUse).toBe(false);
  expect(
    runnerInUse(
      dir,
      [lease(`${dir}-sibling`, { ownerPid: 42, ownerStartTime: new Date(at).toISOString() })],
      false,
      false,
      start,
    ).inUse,
  ).toBe(false);
  const dead = lease(dir, { ownerPid: 43, ownerStartTime: new Date(at).toISOString() });
  expect(runnerInUse(dir, [dead], false, false, start).inUse).toBe(false);
  expect(
    runnerInUse(
      dir,
      [lease(dir, { runnerPid: 42, runnerStartTime: new Date(at + 2000).toISOString() })],
      false,
      false,
      start,
    ).inUse,
  ).toBe(false);
  expect(runnerInUse(dir, [], false, true, start)).toEqual({ inUse: true, inUseReason: 'lock' });
  expect(runnerInUse(dir, [], true, false, start)).toEqual({ inUse: true, inUseReason: 'unreadable' });
  expect(runnerInUse(dir, [parseAgentDeviceRecord('runner-lease', 'bad.json', '{')], false, false, start)).toEqual({
    inUse: true,
    inUseReason: 'unreadable',
  });
});

test('malformed leases and unreadable lease directories protect every entry', async () => {
  directory(state, 100);
  directory(runner, 90);
  directory(join(runner, 'derived'), 80);
  directory(join(runner, 'derived', 'ios-simulator'), 80);
  entry('ios-simulator', 'cache-live', 80);
  const leaseDir = directory(join(runner, 'leases'), 1);
  writeFileSync(join(leaseDir, 'bad.json'), '{');
  expect((await getAgentDeviceUsage({ maxAgeMs: 0 })).runnerBuilds.platforms[0]!.entries[0]!.inUseReason).toBe(
    'unreadable',
  );
  const file = join(home, 'not-a-directory');
  writeFileSync(file, '');
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', file);
  expect((await getAgentDeviceUsage({ maxAgeMs: 0 })).runnerBuilds.platforms[0]!.entries[0]!.inUseReason).toBe(
    'unreadable',
  );
});

test.skipIf(process.platform !== 'darwin')(
  'a lease with the current process and its real start time protects a runner entry',
  async () => {
    directory(state, 100);
    directory(runner, 90);
    directory(join(runner, 'derived'), 80);
    directory(join(runner, 'derived', 'ios-simulator'), 80);
    const dir = entry('ios-simulator', 'cache-live', 80);
    const leaseDir = directory(join(runner, 'leases'), 1);
    const start = inspectProcessStart(process.pid);
    assert(start.status === 'running');
    writeFileSync(
      join(leaseDir, 'live.json'),
      JSON.stringify({
        deviceId: 'device',
        runnerPid: process.pid,
        runnerStartTime: new Date(start.startedAtMs).toISOString(),
        xctestrunPath: join(dir, 'runner.xctestrun'),
      }),
    );
    expect((await getAgentDeviceUsage()).runnerBuilds.platforms[0]!.entries[0]!.inUseReason).toBe('lease');
  },
);

test('fresh cache avoids du, stale or changed roots remeasure and atomically replace the cache', async () => {
  directory(state, 100);
  const first = await getAgentDeviceUsage();
  du.mockClear();
  expect(await getAgentDeviceUsage()).toEqual(first);
  expect(du).not.toHaveBeenCalled();
  const file = agentDeviceUsageFile();
  const cached = JSON.parse(readFileSync(file, 'utf8'));
  cached.measuredAt = '2026-01-01T00:00:00Z';
  writeFileSync(file, JSON.stringify(cached));
  sizes.set(state, 200 * 1024);
  expect((await getAgentDeviceUsage()).bytes).toBe(200 * 1024);
  expect(readdirSync(process.env.STIM_HOME!)).toEqual(['agent-device-usage.json']);
  expect(readStatsReport(null, Date.now()).report.agentDevice?.bytes).toBe(200 * 1024);
  state = directory(join(home, 'moved-state'), 5);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', state);
  expect((await getAgentDeviceUsage()).stateDir.dir).toBe(state);
  expect(du).toHaveBeenCalledTimes(2);
});

test.each(['ETIMEDOUT', 'ENOENT'])(
  'du %s leaves unknown bytes and an incomplete report without throwing',
  async (code) => {
    directory(state, 100);
    du.mockRejectedValue(Object.assign(new Error(code), { code, status: 1, stdout: `100\t${state}` }));
    const report = await getAgentDeviceUsage();
    expect(report.stateDir.bytes).toBe(null);
    expect(report.stateDir.other.bytes).toBe(null);
    expect(report.complete).toBe(false);
    expect(readAgentDeviceUsage()).toEqual(report);
  },
);

test('du exit 1 retains measured partial sizes but marks the result incomplete', async () => {
  directory(state, 100);
  directory(join(state, 'logs'), 10);
  du.mockRejectedValue(Object.assign(new Error('denied'), { status: 1, stdout: `100\t${state}` }));
  const report = await getAgentDeviceUsage();
  expect(report.stateDir.bytes).toBe(100 * 1024);
  expect(report.stateDir.logs.bytes).toBe(null);
  expect(report.complete).toBe(false);
});

test('absent state is silent and corrupt or unsupported cache versions are null for core stats readers', async () => {
  const report = await getAgentDeviceUsage();
  expect(report.bytes).toBe(0);
  expect(report.complete).toBe(true);
  expect(du).not.toHaveBeenCalled();
  expect(agentDeviceLines(report)).toEqual([]);
  for (const text of ['{', '{"version":0}', '{"version":1}', 'null']) {
    writeFileSync(agentDeviceUsageFile(), text);
    expect(readStatsReport(null, Date.now()).report.agentDevice).toBe(null);
  }
  rmSync(agentDeviceUsageFile());
  expect(readAgentDeviceUsage()).toBe(null);
  expect(existsSync(state)).toBe(false);
});

test('the real du invocation works on a temporary tree when du is available', async () => {
  resetExecutor();
  if (!getExecutor().findExecutable('du')) return;
  directory(state, 0);
  writeFileSync(join(state, 'data'), Buffer.alloc(8192, 1));
  const report = await getAgentDeviceUsage();
  expect(report.complete).toBe(true);
  expect(report.stateDir.bytes).toBeGreaterThan(0);
});
