import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
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
import { ensureWorkspaceStorage, workspaceLogsDir, workspaceStateFile } from '../workspace/paths.ts';
import { deviceLeasePath, deviceLocksDir } from '../engine/device-lease.ts';
import { findProjectRoot } from '../workspace/project.ts';
import { recordEasSessionClaim } from '../engine/eas-session-ledger.ts';

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
    expect(logs.some((l) => /not running; supervisor pid 999999 exited without recording a cause/.test(l))).toBe(true);

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
  expect('labelOnly' in appEntry).toBe(false);

  const logs = await runStatus();
  expect(logs.some((l) => /worktree root \(holds the label/.test(l))).toBeTruthy();
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
      missing: { serial: null, state: 'missing', warning: /no longer exists/ },
      unavailable: { serial: null, state: 'unknown', warning: /could not check.*listing unavailable/ },
    }[scenario];
    expect(state.android).toMatchObject({ serial: expected.serial, state: expected.state, owned: true });
    expect(state.warnings.join(' ')).toMatch(expected.warning);
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
      },
      { path: deleted, branch: 'deleted', repository: second, git: null },
      {
        path: other,
        branch: 'other',
        repository: second,
        git: { changed: 0, untracked: 0, upstream: null, ahead: null, behind: null, mergedInto: null },
      },
    ]);
    const env = payload.environments.find((e: { path: string }) => e.path === join(nested, 'apps', 'mobile'));
    expect(env.worktree).toEqual({
      path: nested,
      branch: 'nested',
      repository: first,
      git: { changed: 0, untracked: 0, upstream: null, ahead: null, behind: null, mergedInto: 'origin/main' },
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
