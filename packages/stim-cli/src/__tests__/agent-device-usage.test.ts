import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceStateDir } from '@stim-cli/core';
import { getAgentDeviceUsage, runnerInUse } from '../devices/agent-device-usage.ts';
import { agentDeviceLines } from '../devices/agent-device-usage-output.ts';
import { parseAgentDeviceRecord } from '../devices/activity.ts';
import { inspectProcessStart } from '../process-identity.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
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
    inUseReason: 'unreadable',
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
  expect(report.hosted).toEqual({ dir: hosted, bytes: 9216, sessions: 1 });
  expect(du.mock.calls.map((call) => call[1])).toEqual([
    ['-k', '-d', '4', state],
    ['-sk', workspace, hosted],
  ]);
  expect(agentDeviceLines(report, true).join('\n')).toContain('in use (unreadable)');
});

function lease(dir: string, fields: Record<string, unknown> = {}) {
  return parseAgentDeviceRecord(
    'runner-lease',
    join(home, 'lease.json'),
    JSON.stringify({ deviceId: 'device', xctestrunPath: join(dir, 'Build', 'runner.xctestrun'), ...fields }),
  );
}

test('unknown lease identities keep their runner entry in use', () => {
  const dir = join(runner, 'derived', 'ios-simulator', 'cache-a');
  const at = 'Tue Sep 29 10:12:06 2026';
  for (const fields of [
    { ownerPid: 42, ownerStartTime: at },
    { runnerPid: 42, runnerStartTime: at },
  ]) {
    expect(runnerInUse(dir, [lease(dir, fields)], false, null, () => ({ status: 'unknown' }))).toEqual({
      inUse: true,
      inUseReason: 'unreadable',
    });
  }
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
    rmSync(join(leaseDir, 'live.json'));
    directory(`${dir}.lock`, 1);
    const ownerFile = join(`${dir}.lock`, 'owner.json');
    writeFileSync(
      ownerFile,
      JSON.stringify({ pid: process.pid, startTime: new Date(start.startedAtMs).toISOString() }),
    );
    expect((await getAgentDeviceUsage({ maxAgeMs: 0 })).runnerBuilds.platforms[0]!.entries[0]!.inUseReason).toBe(
      'lock',
    );
    writeFileSync(
      ownerFile,
      JSON.stringify({ pid: process.pid, startTime: new Date(start.startedAtMs - 2000).toISOString() }),
    );
    expect((await getAgentDeviceUsage({ maxAgeMs: 0 })).runnerBuilds.platforms[0]!.entries[0]!.inUse).toBe(false);
  },
);
