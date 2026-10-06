import { isRpcEvent } from '@stim-cli/core/receive-protocol';
import { writeHostedIos } from '../device-host/ios-state.ts';
import * as hostedClient from '../device-host/hosted-client.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import { Command } from 'commander';
import { getExecutor, setExecutor, resetExecutor } from '../exec.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { saveConfig, loadConfig } from '../workspace/config.ts';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert';
import { captureProcessToken } from '../process-identity.ts';
import { makeConfig } from './_factories.ts';
import statusCommand, { readVolumes } from '../commands/status.ts';
import type { NdjsonRecord } from '../ndjson.ts';
import {
  ensureWorkspaceStorage,
  workspaceLogsDir,
  workspaceAgentDeviceDir,
  workspaceStateFile,
} from '../workspace/paths.ts';
import { deviceLeasePath, deviceLocksDir } from '../engine/device-lease.ts';
import { findProjectRoot } from '../workspace/project.ts';
import { recordEasSessionClaim } from '../engine/eas-session-ledger.ts';
import { startBuildProgress } from '../engine/build-progress.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';

let tmpHome: string;
const realExecutor = getExecutor();

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  for (const udid of ['PARKED-1', 'UDID-ABC', 'UDID-DEF', 'UDID-GONE', 'stim-parked']) recordCreatedDevice('ios', udid);
  for (const name of ['stim-agent-1', 'stim-app', 'stim-parked', 'stim-projA']) recordCreatedDevice('android', name);
  const cwd = join(tmpHome, 'cwd-project');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'package.json'), '{}');
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);

  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        {
          udid: 'UDID-ABC',
          name: 'stim-projA',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: 'iphone-17',
        },
      ],
    },
  });
  setExecutor({
    runFile(_file, args = []) {
      const cmd = args.join(' ');
      if (cmd.includes('simctl list devices --json')) return listJson;
      return '';
    },
    async runFileAsync(_file, args = []) {
      if (args.join(' ').includes('simctl list devices --json')) return listJson;
      return '';
    },
    runQuiet(cmd) {
      if (cmd.includes('simctl list devices --json')) return listJson;
      return null;
    },
    runFileQuiet: () => null,
    spawn() {
      throw new Error('spawn should not be called from status');
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

async function runStatus() {
  const program = new Command();
  statusCommand(program);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await program.parseAsync(['node', 'stim', 'status']);
  } finally {
    console.log = originalLog;
  }
  return logs;
}

test('status tags owned devices and leaves unowned devices untagged', async () => {
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/proj/a': {
          label: 'agent-1',
          metroPort: 8083,
          platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } },
        },
        '/proj/b': {
          label: 'agent-2',
          metroPort: 8084,
          platforms: { android: { avdName: 'Pixel_6_API_34', consolePort: 5556 } },
        },
      },
    }),
  );

  const logs = await runStatus();

  const iosLine = logs.find((l) => /ios:/.test(l));
  expect(iosLine).toBeTruthy();
  expect(iosLine).toMatch(/\(owned\)/);

  const androidLine = logs.find((l) => /android:/.test(l));
  expect(androidLine).toBeTruthy();
  expect(androidLine).not.toMatch(/\(owned\)/);
});

test('status says nothing extra for a project that has only a Metro port', async () => {
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/proj/a': {
          label: 'agent-1',
          metroPort: 8083,
          platforms: {},
        },
      },
    }),
  );

  const logs = await runStatus();

  expect(logs.some((l) => /!/.test(l))).toBe(false);
});

test('status detects the framework of an app registered only through a named port', async () => {
  const app = join(tmpHome, 'expo-app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  writeFileSync(join(app, 'app.json'), JSON.stringify({ expo: { name: 'app' } }));
  saveConfig(makeConfig({ version: 2, projects: { [app]: { metroPort: null, platforms: {}, ports: { web: 8900 } } } }));

  const logs = await runStatus();

  expect(logs).toContainEqual(expect.stringMatching(/app: \? \(expo\)/));
});

test('status reports simctl as unreadable instead of warning that every sim is gone', async () => {
  setExecutor({
    runFile(_file, args = []) {
      const cmd = args.join(' ');
      if (cmd.includes('simctl list devices --json')) throw new Error('xcrun: simctl not found');
      return '';
    },
    async runFileAsync(_file, args = []) {
      if (args.join(' ').includes('simctl list devices --json')) throw new Error('xcrun: simctl not found');
      return '';
    },
    runQuiet() {
      return null;
    },
    runFileQuiet: () => null,
    spawn() {
      throw new Error('spawn should not be called from status');
    },
  });
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/proj/a': { label: 'agent-1', platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } } },
        '/proj/b': { label: 'agent-2', platforms: { ios: { deviceUdid: 'UDID-DEF', owned: true } } },
      },
    }),
  );

  const logs = await runStatus();

  expect(logs.some((l) => /no longer exists/.test(l))).toBe(false);
  const simctlLine = logs.find((l) => /simctl could not be read/.test(l));
  expect(simctlLine).toBeTruthy();
  expect(simctlLine).toMatch(/simctl not found/);
  expect(logs.some((l) => /ios:.*unknown/.test(l))).toBeTruthy();
});

test('status still warns about a recorded sim missing from a readable listing', async () => {
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/proj/a': { label: 'agent-1', platforms: { ios: { deviceUdid: 'UDID-GONE', owned: true } } },
      },
    }),
  );

  const logs = await runStatus();

  expect(logs.some((l) => /recorded sim UDID-GONE no longer exists/.test(l))).toBeTruthy();
});

test.each(['ios', 'android'] as const)(
  'status reports a parked %s device when no projects remain',
  async (platform) => {
    const env = platform === 'ios' ? 'STIM_POOL_IOS_PARKED_MAX' : 'STIM_POOL_ANDROID_PARKED_MAX';
    process.env[env] = '3';
    saveConfig(
      makeConfig({
        parked: {
          [platform]: [
            platform === 'android'
              ? {
                  udid: 'stim-parked',
                  name: 'stim-parked',
                  systemImage: 'system-images;android-36;google_apis;arm64-v8a',
                  configuration: '[]',
                  parkedAt: '2026-09-03T00:00:00.000Z',
                }
              : {
                  udid: 'PARKED-1',
                  name: 'stim-parked (iPhone 17 26.5) park',
                  deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
                  runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
                  parkedAt: '2026-09-03T00:00:00.000Z',
                  simslimManaged: false,
                },
          ],
        },
      }),
    );

    try {
      const logs = await runStatus();
      expect(logs).toContain(`pool: 1 parked ${platform === 'ios' ? 'iOS simulator' : 'Android emulator'} (max 3)`);
    } finally {
      delete process.env[env];
    }
  },
);

async function runStatusJson() {
  const program = new Command();
  statusCommand(program);
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await program.parseAsync(['node', 'stim', 'status', '--json']);
  } finally {
    console.log = originalLog;
  }
  expect(logs.length).toBe(1);
  const [line] = logs;
  assert(line);
  expect(line).not.toContain('\n');
  return JSON.parse(line);
}

function setBootedSims(ps: string | null, calls: string[] = [], state = 'Booted', footprints: string | null = null) {
  const listJson = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': ['UDID-ABC', 'UDID-DEF'].map((udid) => ({
        udid,
        name: `stim-${udid}`,
        state,
        isAvailable: true,
        deviceTypeIdentifier: 'iphone-17',
      })),
    },
  });
  setExecutor({
    runFile: (_file, args = []) => (args.join(' ').includes('simctl list devices --json') ? listJson : ''),
    runFileAsync: async (file, args = []) => {
      if (file === 'xcrun' && args[0] === 'swiftc') {
        calls.push('swiftc');
        writeFileSync(args[args.indexOf('-o') + 1]!, '');
      }
      return args.join(' ').includes('simctl list devices --json') ? listJson : '';
    },
    runQuiet: (cmd) => (cmd.includes('simctl list devices --json') ? listJson : null),
    runFileQuiet: (file) => {
      calls.push(file.includes('stim-footprint-') ? 'stim-footprint' : file);
      if (file === 'ps') return ps;
      if (footprints === null) return null;
      if (file === 'xcode-select') return '/Applications/Xcode.app/Contents/Developer';
      return file.includes('stim-footprint-') ? footprints : null;
    },
    spawn() {
      throw new Error('spawn should not be called from status');
    },
  });
}

const START = 'Sat Sep 26 15:33:49 2026';
const simPlist = (udid: string) =>
  `/Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap.plist`;
const TWO_SIMS_PS = [
  `  10     1  51200  9.0 ${START} /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/XPCServices/com.apple.CoreSimulator.CoreSimulatorService.xpc/Contents/MacOS/com.apple.CoreSimulator.CoreSimulatorService`,
  ` 100     1  10240  0.0 ${START} launchd_sim ${simPlist('UDID-ABC')}`,
  ` 101   100 512000  5.0 ${START} /runtime/SpringBoard`,
  ` 110     1  10240  0.0 ${START} launchd_sim ${simPlist('UDID-DEF')}`,
  ` 111   110 204800  1.0 ${START} /runtime/SpringBoard`,
].join('\n');

function saveTwoSimProjects() {
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/proj/a': { label: 'agent-1', platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } } },
        '/proj/b': { label: 'agent-2', platforms: { ios: { deviceUdid: 'UDID-DEF', owned: true } } },
      },
    }),
  );
}

test('status --json sets memoryMb from the footprint helper, compiling it once into STIM_HOME', async () => {
  const MB = 1024 * 1024;
  const calls: string[] = [];
  setBootedSims(TWO_SIMS_PS, calls, 'Booted', [`100 ${4 * MB}`, `101 ${96 * MB}`, `111 ${50 * MB}`].join('\n'));
  saveTwoSimProjects();

  const payload = await runStatusJson();

  expect(payload.machine.memorySource).toBe('footprint');
  expect(
    payload.environments.map((e: { memoryMb: number; memorySource: string }) => [e.memoryMb, e.memorySource]),
  ).toEqual([
    [100, 'footprint'],
    [60, 'footprint'],
  ]);
  expect(payload.capacity.committedMb).toBe(160);
  await runStatusJson();
  expect(calls.filter((call) => call === 'swiftc')).toHaveLength(1);
  expect(calls.filter((call) => call === 'stim-footprint')).toHaveLength(2);
});

test('without the helper, owners carry RSS and environments keep the estimate', async () => {
  setBootedSims(TWO_SIMS_PS);
  saveTwoSimProjects();

  const payload = await runStatusJson();

  expect(payload.machine.memorySource).toBe('rss');
  expect(payload.environments.map((e: { memoryMb: number }) => e.memoryMb)).toEqual([1500, 1500]);
  expect(payload.environments.map((e: { memorySource: string }) => e.memorySource)).toEqual(['estimate', 'estimate']);
  expect(
    payload.machine.owners.map(
      (o: { name: string; workspace: string | null; residentMb: number; cpuPercent: number }) => [
        o.name,
        o.workspace,
        o.residentMb,
        o.cpuPercent,
      ],
    ),
  ).toEqual([
    ['stim-UDID-ABC', '/proj/a', 510, 5],
    ['stim-UDID-DEF', '/proj/b', 210, 1],
    ['CoreSimulator services', null, 50, 9],
  ]);
});

test('an unreadable process table leaves machine null, and an idle machine reads no process table', async () => {
  setBootedSims(null);
  saveConfig(
    makeConfig({
      version: 2,
      projects: { '/proj/a': { label: 'agent-1', platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } } } },
    }),
  );
  expect((await runStatusJson()).machine).toBeNull();

  const calls: string[] = [];
  setBootedSims('', calls, 'Shutdown');
  const idle = await runStatusJson();
  expect(idle.environments[0].live).toBe(false);
  expect(idle.machine).toBeNull();
  expect(calls).not.toContain('ps');
});

function writeLogs(root: string, records: NdjsonRecord[]) {
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  writeFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeState(
  root: string,
  supervisor: { pid: number; processToken?: string | null; port: number; mode: string; startedAt: number },
) {
  ensureWorkspaceStorage(root);
  writeFileSync(workspaceStateFile(root), JSON.stringify({ supervisor }));
}

test('status reports a supervisor whose port answers as this project as healthy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  const server = createServer((_req, res) => res.end('packager-status:running'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const listenerPid = 999999901;
    setExecutor({
      run: () => '',
      async runFileAsync(file, args = []) {
        const cmd = [file, ...args].join(' ');
        if (cmd.includes(`-iTCP:${port} `)) return `p${listenerPid}\nf12\nn127.0.0.1:${port}`;
        if (cmd.includes(`-p ${listenerPid} -d cwd -Fn`)) return `p${listenerPid}\nfcwd\nn${root}`;
        throw new Error(`unexpected ${cmd}`);
      },
      runQuiet: () => null,
      runFileQuiet: () => null,
      spawn() {
        throw new Error('spawn should not be called from status');
      },
    });
    writeState(root, {
      pid: process.pid,
      processToken: captureProcessToken(process.pid),
      port,
      mode: 'bare-inproc',
      startedAt: 1700000000000,
    });
    writeLogs(root, [
      { ts: 1, src: 'metro', level: 'error', msg: 'before the marker' },
      { ts: 2, src: 'metro', level: 'info', msg: 'bundle built', marker: true },
      { ts: 3, src: 'metro', level: 'error', msg: 'after the marker' },
    ]);
    saveConfig(
      makeConfig({
        version: 2,
        projects: {
          [root]: {
            label: 'agent-1',
            metroPort: port,
            supervisor: {
              pid: process.pid,
              processToken: captureProcessToken(process.pid)!,
              port,
              startedAt: '1700000000000',
            },
            platforms: {},
          },
        },
      }),
    );

    const payload = await runStatusJson();
    const env = payload.environments[0];
    expect(env.supervisor).toEqual({
      pid: process.pid,
      mode: 'bare-inproc',
      startedAt: 1700000000000,
      healthy: true,
    });
    expect(env.logs.errorsSinceMarker).toBe(1);
    expect(env.logs.dir).toBe(workspaceLogsDir(root));
    expect(env.warnings).toEqual([]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('status counts a device-only noise storm as zero errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  try {
    mkdirSync(workspaceLogsDir(root), { recursive: true });
    const storm = [];
    for (let i = 0; i < 3004; i += 1) {
      storm.push({
        ts: 1700000000000 + i,
        src: 'device',
        level: 'error',
        proc: 'MyApp',
        msg: `nw_socket_handle_socket_event [C${i}:1] Socket SO_ERROR [54: Connection reset by peer]`,
      });
    }
    writeFileSync(join(workspaceLogsDir(root), 'device.ndjson'), storm.map((r) => JSON.stringify(r)).join('\n') + '\n');
    saveConfig(
      makeConfig({
        version: 2,
        projects: { [root]: { label: 'agent-1', metroPort: 8099, platforms: {} } },
      }),
    );

    const payload = await runStatusJson();
    expect(payload.environments[0].logs.errorsSinceMarker).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status reports the recorded tailscale Metro URL as tailnet-only', async () => {
  const root = join(tmpHome, 'tailnet-project');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{}');
  saveConfig(makeConfig({ projects: { [root]: { label: 'tailnet', metroPort: 8083, platforms: {} } } }));
  writeWorkspaceState(root, {
    metroTunnel: {
      kind: 'managed',
      provider: 'tailscale',
      pid: process.pid,
      processToken: 'linux:100',
      url: 'https://host.tail123.ts.net:8083',
      port: 8083,
      startedAt: 'T',
    },
  });
  const payload = await runStatusJson();
  expect(payload.environments[0].metro.tunnel).toEqual({
    provider: 'tailscale',
    url: 'https://host.tail123.ts.net:8083',
  });
  expect((await runStatus()).join('\n')).toContain('tunnel: tailscale (tailnet-only) https://host.tail123.ts.net:8083');
});

test('status drops a supervisor record whose process is gone and reports it vanished', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  try {
    writeState(root, { pid: 999999, port: 8083, mode: 'expo-child', startedAt: 5 });
    saveConfig(
      makeConfig({
        version: 2,
        projects: {
          [root]: { label: 'agent-1', metroPort: 8083, supervisor: { pid: 999999, port: 8083 }, platforms: {} },
        },
      }),
    );

    const logs = await runStatus();
    expect(logs.some((l) => /^\s*supervisor:/.test(l))).toBe(false);
    expect(logs.some((l) => /not running; supervisor pid 999999 is gone and recorded no cause/.test(l))).toBe(true);

    const payload = await runStatusJson();
    expect(payload.environments[0]).toMatchObject({
      supervisor: null,
      metro: { running: false, lastStop: { reason: 'vanished', pid: 999999, startedAt: null } },
      warnings: [],
      issues: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace with no supervisor and no logs reports both as null', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  try {
    saveConfig(makeConfig({ version: 2, projects: { [root]: { label: 'agent-1', platforms: {} } } }));
    const payload = await runStatusJson();
    expect(payload.environments[0].supervisor).toBe(null);
    expect(payload.environments[0].logs).toBe(null);
    expect(payload.environments[0].agentDevice).toEqual({ stateDir: workspaceAgentDeviceDir(root) });
    expect(existsSync(workspaceAgentDeviceDir(root))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the printed lines name the supervisor and the error count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  try {
    writeState(root, {
      pid: process.pid,
      processToken: captureProcessToken(process.pid),
      port: 8083,
      mode: 'expo-child',
      startedAt: 5,
    });
    writeLogs(root, [{ ts: 3, src: 'metro', level: 'error', msg: 'boom' }]);
    saveConfig(makeConfig({ version: 2, projects: { [root]: { label: 'agent-1', metroPort: 8083, platforms: {} } } }));

    const logs = await runStatus();
    expect(logs.some((l) => new RegExp(`supervisor: pid ${process.pid}`).test(l))).toBeTruthy();
    expect(logs.some((l) => /1 error/.test(l))).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status reports a recorded EAS session with its preview URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  const homeKeys = process.platform === 'win32' ? ['HOME', 'USERPROFILE'] : ['HOME'];
  const previousHome = homeKeys.map((key) => [key, process.env[key]] as const);
  for (const key of homeKeys) process.env[key] = tmpHome;
  try {
    ensureWorkspaceStorage(root);
    writeFileSync(
      workspaceStateFile(root),
      JSON.stringify({
        remoteDevice: {
          platform: 'ios',
          sessionId: 'drs_9',
          startedAt: '2026-09-24T00:00:00.000Z',
          webPreviewUrl: 'https://preview.example/9',
        },
      }),
    );
    recordEasSessionClaim({
      sessionId: 'drs_9',
      name: 'stim-agent-1',
      platform: 'ios',
      workspaceRoot: root,
      workspaceHome: tmpHome,
      stateFile: workspaceStateFile(root),
    });
    saveConfig(makeConfig({ version: 2, projects: { [root]: { label: 'agent-1', platforms: {} } } }));

    const payload = await runStatusJson();
    expect(payload.environments[0].live).toBe(true);
    expect(payload.environments[0].remoteDevices).toEqual([
      {
        platform: 'ios',
        backend: 'eas',
        sessionId: 'drs_9',
        state: 'claimed',
        startedAt: '2026-09-24T00:00:00.000Z',
        webPreviewUrl: 'https://preview.example/9',
      },
    ]);
    const logs = await runStatus();
    expect(logs).toContain('  remote ios: EAS session drs_9 billable -- watch: https://preview.example/9');
  } finally {
    for (const [key, value] of previousHome) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a label-only worktree root is flagged labelOnly in --json and relabelled in the human view', async () => {
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/wt/agent-1': { label: 'agent-1', worktreeRoot: true, platforms: {} },
        '/wt/agent-1/apps/mobile': {
          label: 'agent-1',
          bundleId: 'com.acme.app',
          metroPort: 8083,
          platforms: {},
        },
      },
    }),
  );

  const payload = await runStatusJson();
  expect(payload.environments.length).toBe(2);
  const rootEntry = payload.environments.find((e: { path: string }) => e.path === '/wt/agent-1');
  const appEntry = payload.environments.find((e: { path: string }) => e.path === '/wt/agent-1/apps/mobile');
  assert(rootEntry);
  assert(appEntry);
  expect(rootEntry.labelOnly).toBe(true);
  expect(rootEntry.platforms).toEqual([]);
  expect(appEntry.platforms).toEqual([]);
  expect('labelOnly' in appEntry).toBe(false);

  const logs = await runStatus();
  expect(logs.some((l) => /worktree root \(holds the label/.test(l))).toBeTruthy();
});

test('status reports detected platforms before a run, including resolved project settings', async () => {
  const root = process.cwd();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '54' } }));
  writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { platforms: ['ios'] } }));
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ web: { url: 'http://localhost:5173' } }));
  saveConfig(makeConfig({ version: 2, projects: { [root]: { label: 'fresh', platforms: {} } } }));
  expect((await runStatusJson()).environments[0].platforms).toEqual(['ios', 'web']);
});

test('a running build reports what its build tool is doing only while it compiles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-proj-'));
  const claim = tryAcquireClaim({
    root: join(tmpHome, 'run.lock'),
    mode: 'exclusive',
    label: 'native-run lock',
  }).acquired!;
  try {
    saveConfig(makeConfig({ version: 2, projects: { [root]: { label: 'agent-1', platforms: {} } } }));
    const progress = startBuildProgress({ root, platform: 'ios', slot: 'default', claim });
    progress.step('compile');
    progress.output({ src: 'build', level: 'debug', msg: 'note: Target dependency graph (3 targets)' });
    expect((await runStatusJson()).environments[0].build).toMatchObject({
      state: 'running',
      phase: 'compile',
      outcome: 'cold',
      outcomeKnown: true,
      detail: { unit: 'targets', done: 0, total: 3 },
    });

    progress.step('install');
    expect((await runStatusJson()).environments[0].build).toMatchObject({ phase: 'install' });
    expect((await runStatusJson()).environments[0].build).not.toHaveProperty('detail');
    progress.clear();
  } finally {
    releaseClaim(claim);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a workspace a warm just prepared reports phase ready in --json and [ready] in the human view', async () => {
  saveConfig(makeConfig({ version: 2, projects: { '/wt/warmed': { platforms: {} } } }));
  writeWorkspaceState('/wt/warmed', { warm: { phase: 'ready', at: new Date().toISOString() } });

  const payload = await runStatusJson();
  expect(payload.environments[0]).toMatchObject({ live: false, phase: 'ready' });
  expect((await runStatus()).some((line) => line.includes('warmed [ready]'))).toBe(true);
});

test('a worktree root that is itself the app is not flagged labelOnly', async () => {
  saveConfig(
    makeConfig({
      version: 2,
      projects: {
        '/wt/agent-2': {
          label: 'agent-2',
          worktreeRoot: true,
          bundleId: 'com.acme.solo',
          metroPort: 8084,
          platforms: {},
        },
      },
    }),
  );

  const payload = await runStatusJson();
  expect(payload.environments.length).toBe(1);
  expect('labelOnly' in payload.environments[0]).toBe(false);
});

function dfOutput({ totalKb, availableKb }: { totalKb: number; availableKb: number }) {
  const usedKb = totalKb - availableKb;
  const capacity = Math.round((usedKb / totalKb) * 100);
  return (
    `Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n` +
    `/dev/disk3s5 ${totalKb} ${usedKb} ${availableKb} ${capacity}% 100 200 1% /somewhere\n`
  );
}

function dfExecutor(byVolume: Record<string, string>) {
  const asked: string[] = [];
  setExecutor({
    run() {
      return '';
    },
    runQuiet(cmd) {
      const m = /^df -k '(.*)'$/.exec(cmd);
      if (!m) return null;
      const vol = m[1];
      assert(vol !== undefined);
      asked.push(vol);
      return byVolume[vol] ?? null;
    },
    runFileQuiet: () => null,
    spawn() {
      throw new Error('spawn should not be called from status');
    },
  });
  return asked;
}

test.skipIf(process.platform === 'win32')(
  'a project and STIM_HOME on the boot volume report one volume (macOS df and /Volumes; skipped on win32)',
  () => {
    process.env.STIM_HOME = '/Users/someone/.stim';
    const asked = dfExecutor({ '/': dfOutput({ totalKb: 926 * 1024 * 1024, availableKb: 38 * 1024 * 1024 }) });
    const volumes = readVolumes('/Users/someone/code/app');
    expect(asked).toEqual(['/']);
    expect(volumes.map((v) => v.volume)).toEqual(['/']);
  },
);

test.skipIf(process.platform === 'win32')(
  'a project on another volume reports that volume alongside the boot one (macOS df and /Volumes; skipped on win32)',
  () => {
    process.env.STIM_HOME = '/Users/someone/.stim';
    const asked = dfExecutor({
      '/': dfOutput({ totalKb: 926 * 1024 * 1024, availableKb: 38 * 1024 * 1024 }),
      '/Volumes/ExternalSSD': dfOutput({ totalKb: 2048 * 1024 * 1024, availableKb: 1536 * 1024 * 1024 }),
    });
    const volumes = readVolumes('/Volumes/ExternalSSD/Developer/app');
    expect(asked).toEqual(['/', '/Volumes/ExternalSSD']);
    expect(volumes.map((v) => v.volume)).toEqual(['/', '/Volumes/ExternalSSD']);
    const v1 = volumes[1];
    assert(v1?.disk);
    expect(v1.disk.availableMb).toBe(1536 * 1024);
  },
);

test.skipIf(process.platform === 'win32')(
  'an STIM_HOME on another volume is reported even when the project is on the boot volume (macOS df and /Volumes; skipped on win32)',
  () => {
    const previousHome = process.env.STIM_HOME;
    process.env.STIM_HOME = '/Volumes/StateSSD/Stim';
    try {
      const asked = dfExecutor({
        '/': dfOutput({ totalKb: 926 * 1024 * 1024, availableKb: 38 * 1024 * 1024 }),
        '/Volumes/StateSSD': dfOutput({ totalKb: 2048 * 1024 * 1024, availableKb: 1536 * 1024 * 1024 }),
      });
      const volumes = readVolumes('/Users/someone/code/app');
      expect(asked).toEqual(['/', '/Volumes/StateSSD']);
      expect(volumes.map((v) => v.volume)).toEqual(['/', '/Volumes/StateSSD']);
    } finally {
      if (previousHome === undefined) delete process.env.STIM_HOME;
      else process.env.STIM_HOME = previousHome;
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'a volume df cannot answer for is dropped, not reported as empty (macOS df and /Volumes; skipped on win32)',
  async () => {
    dfExecutor({ '/': dfOutput({ totalKb: 926 * 1024 * 1024, availableKb: 38 * 1024 * 1024 }) });
    const volumes = readVolumes('/Volumes/Unplugged/app');
    expect(volumes.map((v) => v.volume)).toEqual(['/']);
  },
);

function writeLease({
  platform = 'ios',
  id,
  holder,
  expiresInMs,
  body = null,
}: {
  platform?: string;
  id: string;
  holder?: string;
  expiresInMs?: number;
  body?: string | null;
}) {
  mkdirSync(deviceLocksDir(), { recursive: true });
  writeFileSync(
    deviceLeasePath(platform, id),
    body ??
      JSON.stringify({
        version: 1,
        platform,
        id,
        deviceName: 'Old iPhone',
        holder,
        token: `token-${id}`,
        grantedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + (expiresInMs ?? 60_000)).toISOString(),
      }),
  );
}

describe('the device lease section', () => {
  test('lists every lease file, whose it is and whether it expired', async () => {
    saveConfig(makeConfig({ version: 2, projects: {} }));
    const mine = findProjectRoot(process.cwd());
    assert(mine);
    writeLease({ id: 'UDID-MINE', holder: mine, expiresInMs: 60_000 });
    writeLease({ platform: 'android', id: 'R5CT', holder: '/gone/workspace', expiresInMs: -5000 });

    const logs = await runStatus();
    const text = logs.join('\n');
    expect(text).toMatch(/Device leases \(2\)/);
    expect(text).toMatch(/ios UDID-MINE \(Old iPhone\)[^\n]*\[this workspace\]/);
    expect(text).toMatch(/android R5CT[^\n]*\/gone\/workspace expired at/);

    const payload = await runStatusJson();
    expect(payload.deviceLeases).toHaveLength(2);
    const [android, ios] = payload.deviceLeases;
    expect(ios).toMatchObject({ platform: 'ios', id: 'UDID-MINE', holder: mine, mine: true, expired: false });
    expect(android).toMatchObject({
      platform: 'android',
      id: 'R5CT',
      holder: '/gone/workspace',
      mine: false,
      expired: true,
    });
    expect(typeof ios.expiresAt).toBe('string');
  });

  test('an unreadable lease file still shows, so nothing looks free that is not', async () => {
    saveConfig(makeConfig({ version: 2, projects: {} }));
    writeLease({ id: 'UDID-BROKEN', body: '{ not a lease' });

    const logs = await runStatus();
    expect(logs.join('\n')).toMatch(/unreadable lease file/);
    const payload = await runStatusJson();
    expect(payload.deviceLeases[0]).toMatchObject({ parsed: false, holder: null, mine: false, expired: false });
  });
});

test.each(['moved', 'absent', 'launched', 'missing', 'unavailable'] as const)(
  'status observes owned Android serials without changing state (%s)',
  async (scenario) => {
    saveConfig(
      makeConfig({
        projects: {
          '/proj/android': {
            label: 'android',
            platforms: { android: { avdName: 'stim-app', consolePort: 5554, owned: true } },
          },
        },
      }),
    );
    if (scenario === 'launched') {
      ensureWorkspaceStorage('/proj/android');
      const launch = { appId: 'com.app', deviceId: 'emulator-5554', metroPort: null, release: true };
      writeFileSync(
        workspaceStateFile('/proj/android'),
        JSON.stringify({ launches: { android: { ...launch, launchedAt: new Date().toISOString() } } }),
      );
    }
    const before = loadConfig();
    const commands: string[] = [];
    setExecutor({
      run(cmd, options) {
        commands.push(cmd);
        if (cmd.includes('simctl list')) return '{"devices":{}}';
        if (cmd.includes('-list-avds')) {
          expect(options.timeoutMs).toBeGreaterThan(0);
          expect(options.timeoutMs).toBeLessThanOrEqual(5000);
          if (scenario === 'unavailable') throw new Error('emulator listing unavailable');
          return scenario === 'missing' ? '' : 'stim-app\n';
        }
        if (cmd.endsWith(' devices'))
          return scenario === 'moved'
            ? 'List of devices attached\nemulator-5556\tdevice\n'
            : 'List of devices attached\n';
        return '';
      },
      runQuiet(cmd) {
        commands.push(cmd);
        return cmd.includes('-s emulator-5556 emu avd name') ? 'stim-app\nOK' : null;
      },
      runFileQuiet: () => null,
      spawn() {
        throw new Error('status must not spawn a device');
      },
    });
    const payload = await runStatusJson();
    const state = payload.environments[0];
    const expected = {
      moved: { serial: 'emulator-5556', state: 'detected', warning: /emulator-5554 -> emulator-5556.*stim android/ },
      absent: { serial: null, state: 'not-detected', warning: /^$/ },
      launched: { serial: null, state: 'not-detected', warning: /not detected by adb; run `stim android`/ },
      missing: { serial: null, state: 'missing', warning: /^$/ },
      unavailable: { serial: null, state: 'unknown', warning: /could not check.*listing unavailable/ },
    }[scenario];
    expect(state.android).toMatchObject({ serial: expected.serial, state: expected.state, owned: true });
    expect(state.warnings.join(' ')).toMatch(expected.warning);
    expect(
      state.issues
        .filter((issue: { code: string }) => issue.code === 'avd-missing')
        .map((issue: { severity: string }) => issue.severity),
    ).toEqual(scenario === 'missing' ? ['info'] : []);
    expect(state.live).toBe(scenario === 'moved');
    expect(loadConfig()).toEqual(before);
    expect(commands.some((cmd) => /reverse|emu kill|\bboot\b/.test(cmd))).toBe(false);
  },
);

test('status lists worktrees with no environment for every registered repository, from outside any repository, with their git state once every merge verdict is cached', async () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-test-repos-')));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  const commit = (cwd: string, file: string, message: string) => {
    writeFileSync(join(cwd, file), `${message}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-qm', message);
  };
  const repo = (name: string) => {
    const root = join(base, name);
    mkdirSync(join(root, 'apps', 'mobile'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'test');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'apps', 'mobile', 'package.json'), '{}');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'init');
    return root;
  };
  try {
    const first = repo('first');
    const second = repo('second');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(base, 'first.git')]);
    git(first, 'remote', 'add', 'origin', join(base, 'first.git'));
    git(first, 'push', '-q', '-u', 'origin', 'main');
    git(first, 'remote', 'set-head', 'origin', 'main');
    const worktree = (root: string, name: string) => {
      const path = join(base, `${name}-wt`);
      git(root, 'worktree', 'add', '-q', '-b', name, path);
      return path;
    };
    const nested = worktree(first, 'nested');
    const loose = worktree(first, 'loose');
    const other = worktree(second, 'other');
    const deleted = worktree(second, 'deleted');
    rmSync(deleted, { recursive: true, force: true });

    commit(nested, 'feature.txt', 'feature');
    git(first, 'merge', '-q', '--no-ff', '-m', 'merge nested', 'nested');
    git(first, 'push', '-q', 'origin', 'main');

    commit(loose, 'pushed.txt', 'pushed');
    git(loose, 'push', '-q', '-u', 'origin', 'loose');
    commit(loose, 'local.txt', 'local');
    writeFileSync(join(loose, 'pushed.txt'), 'edited\n');
    writeFileSync(join(loose, 'local.txt'), 'staged\n');
    git(loose, 'add', 'local.txt');
    mkdirSync(join(loose, 'scratch'));
    writeFileSync(join(loose, 'scratch', 'a.txt'), 'a');
    writeFileSync(join(loose, 'scratch', 'b.txt'), 'b');
    writeFileSync(join(loose, 'notes.txt'), 'notes');

    saveConfig(
      makeConfig({
        version: 2,
        projects: {
          [first]: { label: 'first', platforms: {} },
          [join(nested, 'apps', 'mobile')]: { label: 'nested', platforms: {} },
          [join(base, 'gone')]: { label: 'gone', platforms: {} },
          [join(second, 'apps', 'mobile')]: { label: 'second', platforms: {} },
        },
      }),
    );
    const real = (fallback: unknown) => (file: string, args: string[], opts: object) =>
      file === 'git' ? realExecutor.runFile(file, args, opts) : fallback;
    setExecutor({
      runFileAsync: (file: string, args: string[], opts: object) =>
        file === 'git' ? realExecutor.runFileAsync(file, args, opts) : Promise.resolve(''),
      runFile: real(''),
      runQuiet: () => null,
      runFileQuiet: (file: string, args: string[], opts: object) =>
        file === 'git' ? realExecutor.runFileQuiet(file, args, opts) : null,
      spawn() {
        throw new Error('spawn should not be called from status');
      },
    });

    await runStatusJson();
    const payload = await runStatusJson();
    expect(payload.unprovisionedWorktrees).toEqual([
      {
        path: loose,
        branch: 'loose',
        repository: first,
        git: { changed: 2, untracked: 2, upstream: 'origin/loose', ahead: 1, behind: 0, mergedInto: null },
        gitChip: {
          parts: [
            { kind: 'arrows', ahead: 1, behind: 0 },
            { kind: 'changed', count: 4 },
          ],
          ci: null,
        },
      },
      { path: deleted, branch: 'deleted', repository: second, git: null },
      {
        path: other,
        branch: 'other',
        repository: second,
        git: { changed: 0, untracked: 0, upstream: null, ahead: null, behind: null, mergedInto: null },
        gitChip: { parts: [{ kind: 'no-upstream' }], ci: null },
      },
    ]);
    const env = payload.environments.find((e: { path: string }) => e.path === join(nested, 'apps', 'mobile'));
    expect(env.worktree).toEqual({
      path: nested,
      branch: 'nested',
      repository: first,
      git: { changed: 0, untracked: 0, upstream: null, ahead: null, behind: null, mergedInto: 'origin/main' },
      gitChip: { parts: [{ kind: 'merged', into: 'origin/main' }], ci: null },
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test.each([
  ['mini', 'mini', false, 'ok', undefined, 'mini'],
  ['local', 'here', false, 'ok', undefined, 'here'],
  ['mini', undefined, 'local', 'ok', undefined, 'none (cache)'],
  ['mini', undefined, false, 'failed', 'STIM_OFFLOAD_REFUSED', 'none'],
])(
  'status exposes selected %s and actual %s placement in plain text and JSON',
  async (buildMachine, builtOn, cacheHit, status, errorCode, actual) => {
    const root = join(tmpHome, 'placement-app');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), '{}');
    saveConfig(makeConfig({ version: 2, projects: { [root]: { metroPort: null, platforms: {} } } }));
    writeWorkspaceState(root, {
      lastIosBuild: {
        platform: 'ios',
        startedAt: '2026-10-01T12:00:00.000Z',
        status,
        cacheHit,
        buildMachine,
        ...(builtOn ? { builtOn } : {}),
        ...(errorCode ? { errorCode } : {}),
      },
    });
    const logs = await runStatus();
    expect(logs.join('\n')).toContain(`build machine ${buildMachine}, built on ${actual}`);
    const program = new Command();
    statusCommand(program);
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      await program.parseAsync(['node', 'stim', 'status', '--json']);
    } finally {
      log.mockRestore();
    }
    const report = JSON.parse(lines[0]!).environments.find((env: { path: string }) => env.path === root)?.lastBuilds
      .ios;
    expect(report).toMatchObject({ buildMachine });
    expect(report.builtOn).toBe(builtOn);
    expect(report.errorCode).toBe(errorCode);
  },
);

test.each([false, true])(
  'an unreadable hosting slot warns without breaking other workspaces: JSON %s',
  async (json) => {
    const a = join(tmpHome, 'app-a');
    const b = join(tmpHome, 'app-b');
    for (const root of [a, b]) {
      mkdirSync(root);
      writeFileSync(join(root, 'package.json'), '{}');
    }
    saveConfig(
      makeConfig({
        projects: { [a]: { platforms: {} }, [b]: { platforms: { ios: { deviceUdid: 'UDID-ABC', owned: true } } } },
      }),
    );
    writeWorkspaceState(a, { deviceSlots: { tablet: { ios: { host: { machine: 'mini', session: '' } } } } });
    const output = json ? JSON.stringify(await runStatusJson()) : (await runStatus()).join('\n');
    expect(output).toContain('deviceSlots.tablet.ios.host.session');
    expect(output).toContain(json ? 'UDID-ABC' : 'stim-projA');
  },
);

test.each(['default', 'tablet'].flatMap((slot) => ['Shutdown', 'Booted', 'unknown'].map((state) => ({ slot, state }))))(
  'status reconciles a $state local simulator with a hosted record in slot $slot',
  async ({ slot, state }) => {
    const executor = getExecutor();
    setExecutor({
      ...executor,
      async runFileAsync(file, args = [], opts) {
        const output = await executor.runFileAsync(file, args, opts);
        if (!args.join(' ').includes('simctl list devices --json')) return output;
        if (state === 'unknown') throw new Error('fixture unreadable simulator inventory');
        return output.replaceAll('Shutdown', state);
      },
    });
    const root = join(tmpHome, 'app');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), '{}');
    const local = { owned: true, deviceUdid: 'UDID-ABC' };
    saveConfig(
      makeConfig({
        projects: {
          [root]:
            slot === 'default'
              ? { platforms: { ios: local } }
              : { platforms: {}, deviceSlots: { tablet: { ios: local } } },
        },
      }),
    );
    vi.spyOn(hostedClient, 'probeHostedSession').mockResolvedValue({ state: 'ready' });
    writeHostedIos(root, slot, {
      machine: 'mini',
      selected: 'mini',
      session: '12345678-1234-1234-1234-123456789abc',
      appAttempt: 'attempt',
      device: {
        udid: '23456789-1234-1234-1234-123456789abc',
        name: 'iPhone 17 Pro',
        deviceType: 'iPhone 17 Pro',
        runtime: '27.0',
        runtimeId: 'ios27',
        deviceTypeId: 'iphone',
        architecture: 'arm64',
      },
      agent: {
        driver: 'agent-device',
        remoteConfig: '/tmp/hosted-ios.json',
        command: 'agent-device <command> --remote-config /tmp/hosted-ios.json',
      },
    });
    const payload = await runStatusJson();
    expect(isRpcEvent({ event: 'status', subscription: 'fixture', payload })).toBe(true);
    const environment = payload.environments[0];
    expect(environment.slots ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ slot: 'default' })]));
    const ios =
      slot === 'default'
        ? environment.ios
        : environment.slots.find((entry: { slot: string }) => entry.slot === slot).ios;
    expect(ios).toMatchObject({
      udid: state === 'Shutdown' ? '' : 'UDID-ABC',
      state: state === 'Shutdown' ? 'ready' : state,
      host: {
        machine: 'mini',
        state: 'ready',
        agent: { driver: 'agent-device', remoteConfig: '/tmp/hosted-ios.json' },
      },
    });
    expect((environment.slots ?? []).filter((entry: { slot: string }) => entry.slot === slot)).toHaveLength(
      slot === 'default' ? 0 : 1,
    );
    expect(environment.warnings.some((warning: string) => warning.includes('both a local and hosted'))).toBe(
      state !== 'Shutdown',
    );
    const plain = (await runStatus()).join('\n');
    expect(plain).toContain('iOS 27.0');
    expect(plain).toContain('agent: agent-device <command> --remote-config /tmp/hosted-ios.json');
    expect(plain.includes(state === 'unknown' ? 'UDID-ABC' : 'stim-projA')).toBe(state !== 'Shutdown');
  },
);

test('status emits one archive payload and links earlier runs to a live environment', async () => {
  const { archiveWorkspace } = await import('../archive.ts');
  const root = '/proj/archive-test';
  process.env.STIM_ARCHIVE_ENABLED = 'true';
  try {
    saveConfig(makeConfig({ projects: { [root]: {} } }));
    ensureWorkspaceStorage(root);
    writeFileSync(workspaceStateFile(root), '{}');
    archiveWorkspace(root, 'worktree-remove');
    const payload = await runStatusJson();
    expect(payload.archived).toHaveLength(1);
    expect(payload.archived[0]).toMatchObject({ projectRoot: root, replacedBy: root, removedBy: 'worktree-remove' });
    expect(payload.archivedUsage.count).toBe(1);
    expect(payload.archivedUsage.bytes).toBeGreaterThan(0);
    expect((await runStatus()).filter((line) => line.startsWith('Archived:'))).toEqual([
      expect.stringContaining('Archived: 1 workspace, '),
    ]);
  } finally {
    delete process.env.STIM_ARCHIVE_ENABLED;
  }
});
