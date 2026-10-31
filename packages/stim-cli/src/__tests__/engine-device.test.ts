import * as hostMemory from '../host-memory.ts';
import { deviceSlotPlatforms } from '../devices/device-slots.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { claimAndroidConsolePort, AvdRecoveryError } from '../engine/device-android.ts';
import { clearIosAdoptionPending } from '../engine/device-ios.ts';
import {
  checkDeviceCapacity,
  deviceCapacityRefusal,
  countLiveOwnedDevices,
  withDeviceBootAdmission,
} from '../engine/device-capacity.ts';
import { ClaimRefusedError } from '../ownership-claim.ts';
import { ensureBooted, ensureOwnedDevice } from '../engine/device.ts';
import { enforceBudget } from '../budget.ts';
import {
  allConsolePortsAndSerials,
  getProject,
  recordIosSchemeApprovals,
  setDevice,
  upsertProject,
} from '../workspace/config.ts';
import type { DeviceRecord } from '@stim-cli/core/state';
import { resetExecutor, setExecutor } from '../exec.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { parkSim, readParked } from '../devices/sim-pool.ts';
import { workspaceId, workspaceLogsDir } from '../workspace/paths.ts';
import { decodeStats, statsFile } from '@stim-cli/core/state';
import { createIosSimSnapshot, ownedSimName } from '../devices/ios.ts';
import { makeAdbDevices, makeConfig, makeExitingChild, makeIosSim } from './_factories.ts';
import { androidBuildOptions } from '../commands/android/support.ts';
import { hostSystemImageArch } from '../devices/android.ts';
import { buildCacheKey } from '@stim-cli/core';

type SimEntry = {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  deviceTypeIdentifier?: string;
};

let tmpHome: string;
let savedAndroidHome: string | undefined;
let savedSdkRoot: string | undefined;
let savedDisplay: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  for (const name of [
    'stim-a',
    'stim-b',
    'stim-app',
    'stim-app-PHONE',
    'stim-default',
    'stim-old',
    'stim-phone',
    'stim-x',
    'stim-0',
    'stim-1',
  ])
    recordCreatedDevice('android', name);
  for (const udid of ['U1', 'U2', 'OTHER', 'NEW-UDID', 'BF2A1C3D-4E5F-6071-8293-A4B5C6D7E8F9'])
    recordCreatedDevice('ios', udid);
  savedAndroidHome = process.env.ANDROID_HOME;
  savedSdkRoot = process.env.ANDROID_SDK_ROOT;
  process.env.ANDROID_HOME = join(tmpHome, 'no-sdk-here');
  delete process.env.ANDROID_SDK_ROOT;
  savedDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ':0';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  if (savedAndroidHome === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = savedAndroidHome;
  if (savedSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
  else process.env.ANDROID_SDK_ROOT = savedSdkRoot;
  if (savedDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = savedDisplay;
  resetExecutor();
});

const SPRINGBOARD_ROW = '4242\t0\tcom.apple.SpringBoard\n';

function deviceLog(root = tmpHome): Record<string, unknown>[] {
  const file = join(workspaceLogsDir(root), 'device.ndjson');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line): Record<string, unknown> => JSON.parse(line))
    : [];
}

function simctlSpawnStub(file: string, args: readonly string[]): string {
  return file === 'xcrun' && args[1] === 'spawn' && args[3] === 'launchctl' ? SPRINGBOARD_ROW : '';
}

function simList(devices: SimEntry[]) {
  return JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': devices.map((device) => ({
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        ...device,
      })),
    },
  });
}

describe('ensureBooted: ios', () => {
  test('stops probing at the first timeout once the simulator is no longer Booted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const shutdown = simList([{ udid: 'U1', name: 'stim-app', state: 'Shutdown', isAvailable: true }]);
    let probes = 0;
    setExecutor({
      run: () => simList([{ udid: 'U1', name: 'stim-app', state: 'Shutdown', isAvailable: true }]),
      runFile(file, args = []) {
        if (file === 'xcrun' && args[1] === 'list') return shutdown;
        if (args[3] !== 'launchctl') return '';
        probes++;
        vi.advanceTimersByTime(30000);
        throw Object.assign(new Error('simctl spawn timed out'), { code: 'ETIMEDOUT' });
      },
      runFileQuiet: () => null,
    });
    const result = await ensureBooted({
      projectPath: tmpHome,
      platform: 'ios',
      device: { deviceUdid: 'U1', owned: true, booting: { udid: 'U1', done: Promise.resolve() } },
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toMatch(/U1.*process-spawn readiness.*simctl spawn timed out/);
    expect(probes).toBe(1);
  });

  describe('a Booted simulator whose SpringBoard is not running', () => {
    function deadShellExecutor({ rows, recoversOnBoot }: { rows: string[]; recoversOnBoot: boolean }) {
      let state = 'Booted';
      let shellUp = false;
      let listings = 0;
      const commands: string[] = [];
      setExecutor({
        findExecutable: () => null,
        run: () => simList([{ udid: 'U1', name: 'stim-app', state, isAvailable: true }]),
        runQuiet: () => '',
        runFileQuiet: (file, args = []) => {
          commands.push([file, ...args].join(' '));
          if (args[1] === 'shutdown') state = 'Shutdown';
          return '';
        },
        runFile(file, args = []) {
          commands.push([file, ...args].join(' '));
          if (file === 'xcrun' && args[1] === 'list')
            return simList([{ udid: 'U1', name: 'stim-app', state, isAvailable: true }]);
          if (file === 'xcrun' && args[3] === 'launchctl') {
            if (shellUp) return SPRINGBOARD_ROW;
            return rows[Math.min(listings++, rows.length - 1)] ?? '';
          }
          if (file === 'xcrun' && args[3] === 'notifyutil') return 'com.apple.springboard.finishedstartup 4242';
          if (file === 'xcrun' && args[0] === 'devicectl') {
            return JSON.stringify({ info: { outcome: 'success' }, result: { deviceIdentifier: 'U1', volume: 0 } });
          }
          return '';
        },
        spawn: (cmd: string, args: readonly string[] = []) => {
          commands.push([cmd, ...args].join(' '));
          if (args[1] === 'boot') {
            state = 'Booted';
            shellUp = recoversOnBoot;
          }
          return makeExitingChild();
        },
      });
      return commands;
    }
    let savedHome: string | undefined;
    let savedProfile: string | undefined;
    beforeEach(() => {
      savedHome = process.env.HOME;
      savedProfile = process.env.USERPROFILE;
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      mkdirSync(join(tmpHome, 'Library/Logs/DiagnosticReports'), { recursive: true });
    });
    afterEach(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
    });
    const ensure = (out: string[] = []) =>
      ensureBooted({
        projectPath: tmpHome,
        platform: 'ios',
        device: { deviceUdid: 'U1', owned: true, booted: 'U1' },
        timeoutMs: 5000,
        pollMs: 1,
        out: (line) => out.push(line),
      });

    test('copies the simulator SpringBoard crash reports into the workspace logs before the restart', async () => {
      const name = 'SpringBoard-2026-10-23-000000.ips';
      const text = `{}\n${JSON.stringify({ captureTime: new Date().toISOString(), coalitionName: 'com.apple.CoreSimulator.SimDevice.u1' })}`;
      writeFileSync(join(tmpHome, 'Library/Logs/DiagnosticReports', name), text);
      writeFileSync(
        join(tmpHome, 'Library/Logs/DiagnosticReports', 'SpringBoard-2026-10-23-000001.ips'),
        `{}\n${JSON.stringify({ captureTime: new Date().toISOString(), coalitionName: 'com.apple.CoreSimulator.SimDevice.OTHER' })}`,
      );
      deadShellExecutor({ rows: [''], recoversOnBoot: true });
      expect(await ensure()).toEqual({ ok: true, udid: 'U1' });
      const records = deviceLog();
      const copy = records.findIndex((record) => record.event === 'springboard_crash_reports');
      expect(records[copy]).toMatchObject({ deviceId: 'U1', files: [name], level: 'warn' });
      expect(copy).toBeGreaterThanOrEqual(0);
      expect(copy).toBeLessThan(records.findIndex((record) => record.phase === 'restart'));
      expect(readFileSync(join(workspaceLogsDir(tmpHome), name), 'utf8')).toBe(text);
      expect(existsSync(join(workspaceLogsDir(tmpHome), 'SpringBoard-2026-10-23-000001.ips'))).toBe(false);
    });

    test('restarts only once and then names the stop and rerun remedy', async () => {
      const commands = deadShellExecutor({ rows: ['-\t-5\tcom.apple.SpringBoard\n'], recoversOnBoot: false });
      const result = await ensure();
      expect(result.failed).toBe(true);
      expect(result.reason).toMatch(/U1.*SpringBoard.*not running.*`stim stop`.*`stim ios`/);
      expect(commands.filter((c) => c === 'xcrun simctl shutdown U1')).toHaveLength(1);
      expect(commands.filter((c) => c === 'xcrun simctl boot U1')).toHaveLength(1);
      const records = deviceLog();
      expect(records.filter((record) => record.phase === 'restart')).toHaveLength(1);
      expect(records.filter((record) => record.event === 'springboard_crash_reports')).toHaveLength(2);
    });
  });

  const springBoardStarting = 'com.apple.springboard.finishedstartup 0';
  const springBoardStarted = 'com.apple.springboard.finishedstartup 4242';
  test.each([['U1', 0, [springBoardStarting, springBoardStarting, springBoardStarted], false]] as const)(
    'boots a shut-down owned sim, waits for the Booted state and SpringBoard, and mutes it (%s at %s, case %#)',
    async (reportedUdid, reportedVolume, springBoard: readonly (string | Error)[], warns) => {
      let listCalls = 0;
      let springBoardCalls = 0;
      const commands: string[] = [];
      const notes: string[] = [];
      setExecutor({
        run: (cmd) => {
          commands.push(cmd);
          if (cmd.includes('list devices')) {
            listCalls += 1;
            const state = listCalls >= 3 ? 'Booted' : 'Shutdown';
            return simList([{ udid: 'U1', name: 'stim-app', state, isAvailable: true }]);
          }
          return '';
        },
        runQuiet: () => '',
        runFileQuiet: (file, args = []) => {
          commands.push([file, ...args].join(' '));
          return '';
        },
        runFile(file, args = []) {
          if (file === 'xcrun' && args[0] === 'devicectl') {
            commands.push([file, ...args].join(' '));
            return JSON.stringify({
              info: { outcome: 'success' },
              result: { deviceIdentifier: reportedUdid, volume: reportedVolume },
            });
          }
          if (file === 'xcrun' && args[1] === 'spawn' && args[3] === 'notifyutil') {
            commands.push([file, ...args].join(' '));
            const reply = springBoard[Math.min(springBoardCalls++, springBoard.length - 1)];
            if (reply instanceof Error) throw reply;
            return reply;
          }
          return file === 'xcrun' && (args[1] === 'list' || args[1] === 'boot')
            ? this.run!([file, ...args].join(' '))
            : simctlSpawnStub(file, args);
        },
        spawn: (cmd: string, args: readonly string[] = []) => {
          commands.push([cmd, ...args].join(' '));
          return makeExitingChild();
        },
      });
      const result = await ensureBooted({
        projectPath: tmpHome,
        platform: 'ios',
        simulatorApp: 'siniulator',
        device: { deviceUdid: 'U1', owned: true },
        timeoutMs: 5000,
        pollMs: 5,
        out: (line) => notes.push(line),
      });
      expect(commands).toContain('open -a Siniulator siniulator://open?udid=U1');
      expect(result).toEqual({ ok: true, udid: 'U1' });
      expect(commands.filter((c) => c === 'xcrun simctl boot U1').length).toBe(1);
      expect(commands.indexOf('xcrun simctl boot U1')).toBeLessThan(commands.indexOf('xcrun simctl bootstatus U1 -b'));
      const mute = 'xcrun devicectl device settings audio --device U1 --volume 0 --json-output -';
      const springBoardQuery = 'xcrun simctl spawn U1 notifyutil -g com.apple.springboard.finishedstartup';
      const started = springBoard.at(-1) === springBoardStarted;
      expect(commands.filter((c) => c === springBoardQuery).length).toBe(springBoard.length + 1);
      expect(commands.indexOf('xcrun simctl bootstatus U1 -b')).toBeLessThan(commands.indexOf(springBoardQuery));
      expect(commands.filter((c) => c === mute).length).toBe(started ? 1 : 0);
      expect(commands.indexOf(mute) > commands.lastIndexOf(springBoardQuery)).toBe(started);
      expect(notes.some((line) => line.includes('Could not mute this simulator'))).toBe(warns);
      expect(notes.some((line) => line.includes('simulator muted'))).toBe(!warns);
      const phases = deviceLog();
      expect(phases.map((record) => record.phase)).toEqual([
        'boot_requested',
        'bootstatus_done',
        ...(started ? ['springboard_started'] : []),
        'viewer_opened',
      ]);
      expect(phases.find((record) => record.phase === 'springboard_started')?.pid).toBe(started ? 4242 : undefined);
      expect(phases[0]).toMatchObject({
        src: 'device',
        platform: 'ios',
        event: 'ios_boot',
        deviceId: 'U1',
        boot: 'existing',
      });
    },
  );

  test('reports boot setup failures instead of treating the Booted state as ready', async () => {
    setExecutor({
      run: (cmd) => {
        if (cmd.includes('list devices')) {
          return simList([{ udid: 'U1', name: 'stim-app', state: 'Shutdown', isAvailable: true }]);
        }
        return '';
      },
      runQuiet: () => '',
      runFileQuiet: () => '',
      runFile(file, args = []) {
        return file === 'xcrun' && (args[1] === 'list' || args[1] === 'boot')
          ? this.run!([file, ...args].join(' '))
          : simctlSpawnStub(file, args);
      },
      spawn: () => makeExitingChild(1, 'CoreLocationMigrator failed'),
    });

    const result = await ensureBooted({
      projectPath: tmpHome,
      platform: 'ios',
      device: { deviceUdid: 'U1', owned: true },
    });

    expect(result.ok).toBeUndefined();
    expect(result.reason).toMatch(/Could not boot simulator U1/);
    expect(result.reason).toMatch(/CoreLocationMigrator failed/);
  });

  test("refuses to boot a sim that is no longer this Stim home's", async () => {
    setExecutor({
      run: () => simList([{ udid: 'U1', name: 'My iPhone', state: 'Shutdown', isAvailable: true }]),
      runQuiet: () => '',
      runFileQuiet: () => '',
      runFile(file, args = []) {
        return file === 'xcrun' && (args[1] === 'list' || args[1] === 'boot')
          ? this.run!([file, ...args].join(' '))
          : simctlSpawnStub(file, args);
      },
      spawn: () => {
        throw new Error('must not boot a foreign sim');
      },
    });
    const result = await ensureBooted({ projectPath: tmpHome, platform: 'ios', device: { deviceUdid: 'U1' } });
    expect(result.ok).toBe(undefined);
    expect(result.reason).toMatch(/not Stim-owned/);
  });

  test('joins the boot this run started instead of listing simulators again', async () => {
    const commands: string[] = [];
    let finished = false;
    setExecutor({
      runFileQuiet: () => null,
      run: (cmd: string) => {
        commands.push(cmd);
        throw new Error(`unexpected run: ${cmd}`);
      },
      runQuiet: (cmd: string) => {
        commands.push(cmd);
        return '';
      },
      runFile: (file, args = []) => {
        expect(finished).toBe(true);
        commands.push([file, ...args].join(' '));
        return SPRINGBOARD_ROW;
      },
      spawn: () => null,
    });
    const done = new Promise<void>((resolve) =>
      setTimeout(() => {
        finished = true;
        resolve();
      }, 5),
    );
    const result = await ensureBooted({
      projectPath: tmpHome,
      platform: 'ios',
      device: { deviceUdid: 'U1', owned: true, booting: { udid: 'U1', done } },
    });
    expect(result).toEqual({ ok: true, udid: 'U1' });
    expect(finished).toBe(true);
    expect(commands).toEqual(['xcrun simctl spawn U1 launchctl list']);
  });
});

describe('ensureBooted: android', () => {
  beforeEach(() => {
    upsertProject(tmpHome, {});
  });

  test.each([
    ['[V] volume is 0 in range [0..15]', false, 'stim-app'],
    ['[V] volume is 5 in range [0..15]', true, 'stim-app'],
    ["Error: unknown command 'set-volume'", true, 'stim-app'],
    ['[V] volume is 0 in range [0..15]', true, 'other-avd'],
    ['[V] volume is 0 in range [0..15]', true, ''],
  ])(
    'boots a stopped owned AVD on a claimed console port, waits, and mutes media (%s)',
    async (readback, warns, identity) => {
      const spawned: string[][] = [];
      const notes: string[] = [];
      let booted = false;
      let transferredHelper = false;
      setExecutor({
        runFileQuiet(file, args = [], opts) {
          return file === 'adb' || file === 'emulator' ? this.runQuiet!([file, ...args].join(' '), opts) : null;
        },
        run: (cmd) => {
          if (cmd === 'emulator -list-avds') return 'stim-app';
          if (cmd === 'adb devices')
            return booted ? 'List of devices attached\nemulator-5554\tdevice' : 'List of devices attached';
          return '';
        },
        runQuiet: (cmd) => {
          if (cmd.includes('emu avd name')) return identity ? identity + '\nOK' : '';
          if (cmd.includes('sys.boot_completed')) return booted ? '1' : '';
          if (cmd.includes('pm path android')) return booted ? 'package:/system/framework/framework-res.apk' : '';
          return '';
        },
        runFile(file, args = []) {
          if (file === 'adb' && args[2] === 'push') transferredHelper = true;
          if (file === 'adb' && args[3] === 'cmd') {
            return args[4] === 'media_session' ? readback : '';
          }
          if (file === 'adb' || file === 'emulator') return this.run!([file, ...args].join(' '));
          return '';
        },
        spawn: (cmd, args) => {
          spawned.push([cmd, ...args]);
          booted = true;
          return { unref() {} };
        },
      });
      const result = await ensureBooted({
        platform: 'android',
        projectPath: tmpHome,
        device: { avdName: 'stim-app', consolePort: 5556, owned: true },
        timeoutMs: 5000,
        out: (line) => notes.push(line),
      });
      expect(result).toEqual({ ok: true, serial: 'emulator-5554' });
      expect(spawned).toEqual([['emulator', '-avd', 'stim-app', '-port', '5554', '-grpc', '8554', '-grpc-use-token']]);
      expect(notes.some((line) => line.includes('Could not mute emulator media'))).toBe(warns);
      expect(transferredHelper).toBe(identity === 'stim-app');
    },
  );

  test('an emulator boot refused at admission keeps STIM_AT_CAPACITY and never launches', async () => {
    const other = mkdtempSync(join(tmpdir(), 'stim-test-other-'));
    process.env.STIM_MAX_DEVICES = '1';
    try {
      upsertProject(other, {});
      setDevice(other, 'android', { avdName: 'stim-other', consolePort: 5560, owned: true });
      setExecutor({
        runFileQuiet(file, args = [], opts) {
          return file === 'adb' || file === 'emulator' ? this.runQuiet!([file, ...args].join(' '), opts) : null;
        },
        run: (cmd) => {
          if (cmd === 'emulator -list-avds') return 'stim-app\nstim-other';
          if (cmd === 'adb devices') return 'List of devices attached\nemulator-5560\tdevice';
          return '';
        },
        runQuiet: () => '',
        runFile(file, args = []) {
          if (file === 'adb' || file === 'emulator') return this.run!([file, ...args].join(' '));
          return '{"devices":{}}';
        },
        spawn: () => {
          throw new Error('must not launch an emulator past the cap');
        },
      });
      const result = await ensureBooted({
        platform: 'android',
        deviceSlotWait: { noWait: true },
        projectPath: tmpHome,
        device: { avdName: 'stim-app', consolePort: 5556, owned: true },
        timeoutMs: 5000,
      });
      expect(result).toMatchObject({ failed: true, code: 'STIM_AT_CAPACITY' });
    } finally {
      delete process.env.STIM_MAX_DEVICES;
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('allocates a fresh console port when the recorded one is taken by a foreign emulator', async () => {
    const spawned: string[][] = [];
    let ourSerial: string | null = null;
    setExecutor({
      runFileQuiet(file, args = [], opts) {
        return file === 'adb' || file === 'emulator' ? this.runQuiet!([file, ...args].join(' '), opts) : null;
      },
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-app';
        if (cmd === 'adb devices') {
          const rows = ['List of devices attached', 'emulator-5554\tdevice'];
          if (ourSerial) rows.push(`${ourSerial}\tdevice`);
          return rows.join('\n');
        }
        return '';
      },
      runQuiet: (cmd) => {
        if (cmd.includes('emu avd name')) return cmd.includes('5554') ? 'Pixel_7_API_35\nOK' : 'stim-app\nOK';
        if (cmd.includes('sys.boot_completed')) return ourSerial ? '1' : '';
        if (cmd.includes('pm path android')) return ourSerial ? 'package:/system/framework/framework-res.apk' : '';
        return '';
      },
      runFile(file, args = []) {
        if (file === 'adb' || file === 'emulator') return this.run!([file, ...args].join(' '));
        return '';
      },
      spawn: (cmd, args) => {
        spawned.push([cmd, ...args]);
        ourSerial = `emulator-${args[args.indexOf('-port') + 1]}`;
        return { unref() {} };
      },
    });
    const result = await ensureBooted({
      platform: 'android',
      projectPath: tmpHome,
      device: { avdName: 'stim-app', consolePort: 5554, owned: true },
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.serial).not.toBe('emulator-5554');
    assert(result.serial);
    const call = spawned[0];
    assert(call);
    expect(call[4]).toBe(result.serial.replace('emulator-', ''));
  });

  test('fallback boots in two workspaces claim and record distinct ports before either emulator reaches adb', async () => {
    const roots = ['a', 'b'].map((name) => join(tmpHome, name));
    for (const [i, root] of roots.entries()) {
      mkdirSync(root);
      upsertProject(root, {});
      setDevice(root, 'android', { avdName: `stim-${i}`, owned: true });
    }
    const spawnedPorts: number[] = [];
    setExecutor({
      runFileQuiet(file, args = [], opts) {
        return file === 'adb' || file === 'emulator' ? this.runQuiet!([file, ...args].join(' '), opts) : null;
      },
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-0\nstim-1';
        if (cmd === 'adb devices') return 'List of devices attached';
        return '';
      },
      runQuiet: (cmd) =>
        cmd.includes('sys.boot_completed')
          ? '1'
          : cmd.includes('pm path android')
            ? 'package:/system/framework/framework-res.apk'
            : '',
      runFile(file, args = []) {
        if (file === 'adb' || file === 'emulator') return this.run!([file, ...args].join(' '));
        return '';
      },
      spawn: (_cmd, args) => {
        spawnedPorts.push(Number(args[args.indexOf('-port') + 1]));
        return { unref() {} };
      },
    });
    const results = await Promise.all(
      roots.map((projectPath, i) =>
        ensureBooted({
          platform: 'android',
          projectPath,
          device: { avdName: `stim-${i}`, owned: true },
          timeoutMs: 5000,
        }),
      ),
    );
    expect(new Set(spawnedPorts).size).toBe(2);
    expect(results.map((r) => r.serial)).toEqual(spawnedPorts.map((port) => `emulator-${port}`));
    expect(roots.map((root) => deviceSlotPlatforms(getProject(root), 'default')?.android?.consolePort)).toEqual(
      spawnedPorts,
    );
  });

  test.skipIf(process.platform !== 'darwin')(
    'Android boot completes while the memory-culprit top read is still running, then names the culprit',
    async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      vi.spyOn(hostMemory, 'readHostMemoryPressure').mockReturnValue('warning');
      let finishTop: (output: string) => void = () => {};
      const top = vi.fn<() => Promise<string | null>>(() => new Promise((resolve) => (finishTop = resolve)));
      const run = (cmd: string) => (cmd === 'emulator -list-avds' ? 'stim-app' : 'List of devices attached');
      const runQuiet = (cmd: string) =>
        cmd.includes('sys.boot_completed') ? '1' : cmd.includes('pm path android') ? 'package:/x' : '';
      const runFileQuiet = (file: string, args: string[] = []) =>
        file === 'adb' || file === 'emulator' ? runQuiet([file, ...args].join(' ')) : null;
      setExecutor({
        runFileQuiet,
        runFileQuietAsync: async (file, args) => (file === '/usr/bin/top' ? top() : runFileQuiet(file, args)),
        run,
        runQuiet,
        runFile: (file, args = []) => (file === 'adb' || file === 'emulator' ? run([file, ...args].join(' ')) : ''),
        spawn: () => ({ pid: 987654, unref() {} }),
      });
      const events: string[] = [];
      const resultPromise = ensureBooted({
        platform: 'android',
        projectPath: tmpHome,
        device: { avdName: 'stim-app', consolePort: 5556, owned: true },
        timeoutMs: 20000,
        alive: () => true,
        out: (line) => events.push(line),
      });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result).toEqual({ ok: true, serial: 'emulator-5554' });
      expect(top).toHaveBeenCalledTimes(1);
      expect(events.filter((line) => line.includes('host memory pressure'))).toHaveLength(1);
      expect(events.some((line) => line.includes('fseventsd'))).toBe(false);
      finishTop(['PID    MEM    COMMAND', '76886  63G    fseventsd', ''].join('\n'));
      await vi.waitFor(() => expect(events.some((line) => line.includes('fseventsd (pid 76886)'))).toBe(true));
    },
  );

  test.each([
    ['warning', 'late boot', true, 121000, true],
    ['critical', 'timeout', true, Infinity, true],
    ['normal', 'timeout', true, Infinity, false],
    [null, 'timeout', true, Infinity, false],
    ['warning', 'process exit', false, Infinity, false],
    ['warning', 'exit at timeout', true, Infinity, false],
    ['warning', 'exit during extension', true, Infinity, true],
    ['warning', 'unknown process', null, Infinity, false],
  ] as const)('Android boot under %s pressure: %s', async (pressure, outcome, live, bootAt, extended) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(hostMemory, 'readHostMemoryPressure').mockReturnValue(pressure);
    const events: string[] = [];
    const probes: number[] = [];
    const spawn = vi.fn<() => { pid?: number; unref: () => void }>(() => {
      events.push('spawn');
      return { pid: live === null ? undefined : 987654, unref() {} };
    });
    setExecutor({
      runFileQuiet(file, args = [], opts) {
        return file === 'adb' || file === 'emulator' ? this.runQuiet!([file, ...args].join(' '), opts) : null;
      },
      run: (cmd) => (cmd === 'emulator -list-avds' ? 'stim-app' : 'List of devices attached'),
      runQuiet: (cmd, opts) => {
        if (cmd.includes('getprop') || cmd.includes('pm path android')) {
          probes.push(opts?.timeoutMs ?? 0);
          if (Date.now() < bootAt) return '';
          return cmd.includes('sys.boot_completed')
            ? '1'
            : cmd.includes('pm path android')
              ? 'package:/system/framework/framework-res.apk'
              : '';
        }
        return '';
      },
      runFile(file, args = []) {
        if (file === 'adb' || file === 'emulator') return this.run!([file, ...args].join(' '));
        return '{"devices":{}}';
      },
      spawn,
    });
    const resultPromise = ensureBooted({
      platform: 'android',
      projectPath: tmpHome,
      device: { avdName: 'stim-app', consolePort: 5556, owned: true },
      timeoutMs: 120000,
      alive: () =>
        live === true &&
        (outcome !== 'exit at timeout' || Date.now() < 120000) &&
        (outcome !== 'exit during extension' || Date.now() < 130000),
      out: (line) => events.push(line),
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(events.filter((line) => line.includes('retrying the boot wait'))).toHaveLength(extended ? 1 : 0);
    expect(probes.every((timeout) => timeout > 0 && timeout <= 5000)).toBe(true);
    const pressured = pressure === 'warning' || pressure === 'critical';
    expect(events.some((line) => line.includes(`${pressure} host memory pressure`))).toBe(pressured);
    expect(events.findIndex((line) => line.includes('host memory pressure'))).toBe(pressured ? 0 : -1);
    const exited = ['process exit', 'exit at timeout', 'exit during extension'].includes(outcome);
    const success = outcome === 'late boot';
    expect(Boolean(result.ok)).toBe(success);
    expect(Boolean(result.failed)).toBe(!success);
    const expectedReason = success ? undefined : exited ? 'exited before' : extended ? 'within 360s' : 'within 120s';
    expect(expectedReason === undefined ? result.reason : result.reason?.includes(expectedReason)).toBe(
      success ? undefined : true,
    );
    const expectedRemedy = success
      ? undefined
      : exited
        ? 'process exit'
        : pressured
          ? 'only in a workspace you own'
          : 'stim doctor';
    expect(expectedRemedy === undefined ? result.remedy : result.remedy?.includes(expectedRemedy)).toBe(
      success ? undefined : true,
    );
    const expectedTime = success
      ? 121000
      : outcome === 'process exit'
        ? 0
        : outcome === 'exit at timeout'
          ? 120000
          : outcome === 'exit during extension'
            ? 130000
            : extended
              ? 360000
              : 120000;
    expect(Date.now()).toBe(expectedTime);
  });

  test('running owned devices add context without claiming memory pressure or extending an untracked boot', async () => {
    vi.useFakeTimers();
    vi.spyOn(hostMemory, 'readHostMemoryPressure').mockReturnValue(null);
    setDevice(tmpHome, 'android', { owned: true, avdName: 'stim-app', consolePort: 5556 });
    const spawn = vi.fn<() => void>();
    setExecutor({
      runFileQuiet(file, args = [], opts) {
        return file === 'adb' || file === 'emulator' ? this.runQuiet!([file, ...args].join(' '), opts) : null;
      },
      run: (cmd) => {
        if (cmd === 'emulator -list-avds') return 'stim-app';
        if (cmd === 'adb devices') return 'List of devices attached\nemulator-5556\tdevice';
        if (cmd.includes('emu avd name')) return 'stim-app';
        return '';
      },
      runQuiet: (cmd) => (cmd.includes('emu avd name') ? 'stim-app\nOK' : ''),
      runFile(file, args = []) {
        if (file === 'adb' || file === 'emulator') return this.run!([file, ...args].join(' '));
        return '{"devices":{}}';
      },
      spawn,
    });
    const lines: string[] = [];
    const pending = ensureBooted({
      platform: 'android',
      projectPath: tmpHome,
      device: { avdName: 'stim-app', owned: true },
      timeoutMs: 1000,
      out: (line) => lines.push(line),
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.failed).toBe(true);
    expect(result.remedy).toContain('1 Stim-owned device is running');
    expect(result.remedy).not.toMatch(/reports.*pressure|JAVA_HOME/);
    expect(lines.join('')).not.toContain('retrying');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('refuses an AVD that this Stim home did not record', async () => {
    setExecutor({
      runFileQuiet(file, args = [], opts) {
        return file === 'adb' || file === 'emulator' ? this.runQuiet!([file, ...args].join(' '), opts) : null;
      },
      run: (cmd) => (cmd === 'emulator -list-avds' ? 'Pixel_7_API_35' : ''),
      runQuiet: () => '',
      runFile(file, args = []) {
        if (file === 'adb' || file === 'emulator') return this.run!([file, ...args].join(' '));
        return '';
      },
      spawn: () => {
        throw new Error('must not boot a foreign AVD');
      },
    });
    const result = await ensureBooted({
      platform: 'android',
      projectPath: tmpHome,
      device: { avdName: 'Pixel_7_API_35' },
    });
    expect(result.reason).toMatch(/not Stim-owned/);
  });
});

const TYPES = [
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro' },
  { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', name: 'iPhone 16' },
];
const [TYPE_17_PRO, TYPE_16] = TYPES;
assert(TYPE_17_PRO);
assert(TYPE_16);

const DEVICE_TYPES_JSON = JSON.stringify({ devicetypes: TYPES });
const RUNTIMES_JSON = JSON.stringify({
  runtimes: [
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
      name: 'iOS 26.2',
      version: '26.2',
      isAvailable: true,
      platform: 'iOS',
      supportedDeviceTypes: TYPES,
    },
    {
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6',
      name: 'iOS 18.6',
      version: '18.6',
      isAvailable: true,
      platform: 'iOS',
      supportedDeviceTypes: TYPES,
    },
  ],
});

function projectDir() {
  const dir = mkdtempSync(join(tmpdir(), 'stim-test-proj-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch-app' }));
  upsertProject(dir, { bundleId: undefined, androidPackage: undefined, isExpo: false });
  return dir;
}

function iosExecutor(devices: SimEntry[]) {
  const run: string[] = [];
  const files: string[][] = [];
  const spawned: string[] = [];
  return {
    run,
    files,
    spawned,
    exec: {
      runFileQuiet: () => '',
      run(cmd: string) {
        run.push(cmd);
        if (/simctl list --json/.test(cmd))
          return JSON.stringify({
            ...JSON.parse(DEVICE_TYPES_JSON),
            ...JSON.parse(RUNTIMES_JSON),
            ...JSON.parse(simList(devices)),
          });
        if (/simctl list devicetypes --json/.test(cmd)) return DEVICE_TYPES_JSON;
        if (/simctl list runtimes --json/.test(cmd)) return RUNTIMES_JSON;
        if (/simctl list devices --json/.test(cmd)) return simList(devices);
        if (/simctl create/.test(cmd)) return 'NEW-UDID';
        if (/simctl boot/.test(cmd)) return '';
        throw new Error(`unexpected run: ${cmd}`);
      },
      runQuiet(cmd: string) {
        try {
          return this.run(cmd);
        } catch {
          return null;
        }
      },
      runFile(file: string, args: string[] = []) {
        files.push([file, ...args]);
        if (file === 'xcrun' && args[0] === 'simctl' && ['list', 'boot', 'create'].includes(args[1] ?? ''))
          return this.run!([file, ...args].join(' '));
        return simctlSpawnStub(file, args);
      },
      spawn(cmd: string, args: readonly string[] = []) {
        if (args[1] === 'boot') run.push([cmd, ...args].join(' '));
        spawned.push([cmd, ...args].join(' '));
        return makeExitingChild();
      },
    },
  };
}

describe('ensureOwnedDevice: ios', () => {
  test('concurrent allocations disambiguate names after truncation and preserve the suffix on reuse', async () => {
    const roots = [projectDir(), projectDir()];
    const label = 'same-worktree-name-'.repeat(5);
    const { exec } = iosExecutor([]);
    let nextUdid = 0;
    setExecutor({
      ...exec,
      run(cmd: string) {
        if (cmd.includes('simctl create')) return `CREATED-${++nextUdid}`;
        return exec.run(cmd);
      },
    });
    try {
      const devices = await Promise.all(
        roots.map((root) =>
          ensureOwnedDevice({
            platform: 'ios',
            projectPath: root,
            label,
            settings: {},
          }),
        ),
      );
      await Promise.all(devices.map((device) => device.booting?.done));
      expect(devices[0]?.deviceName).toBe(ownedSimName(label, { model: 'iPhone 17 Pro', runtime: '26.2' }));
      expect(devices[1]?.deviceName).not.toBe(devices[0]?.deviceName);
      expect(devices[1]?.deviceName).toContain(` ${workspaceId(roots[1]!)}`);
      for (const device of devices) expect(device.deviceName!.length).toBeLessThanOrEqual(60);
      const listed = devices.map((device) => ({
        udid: device.deviceUdid!,
        name: device.deviceName!,
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: TYPE_17_PRO.identifier,
      }));
      const reuse = iosExecutor(listed);
      setExecutor(reuse.exec);
      const second = await ensureOwnedDevice({
        platform: 'ios',
        projectPath: roots[1]!,
        project: getProject(roots[1]!),
        label,
        settings: {},
      });
      expect(second.deviceName).toBe(devices[1]?.deviceName);
      expect(reuse.files.some((call) => call.includes('rename'))).toBe(false);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    { collision: false, stale: false },
    { collision: true, stale: false },
    { collision: false, stale: true },
  ])(
    'adopts a matching parked simulator (collision: $collision, stale assignment: $stale)',
    async ({ collision, stale }) => {
      const root = projectDir();
      process.env.STIM_POOL_IOS_PARKED_MAX = '3';
      const schemeApprovals = ['com.apple.CoreSimulator.CoreSimulatorBridge-->com.example.app=com.example.app'];
      try {
        setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, schemeApprovals });
        parkSim({
          platform: 'ios',
          projectPath: root,
          max: 3,
          record: {
            udid: 'U1',
            name: 'stim-parked (iPhone 17 Pro 26.2) u1',
            deviceTypeIdentifier: TYPE_17_PRO.identifier,
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
            parkedAt: '2026-09-01T10:00:00.000Z',
            simslimManaged: false,
            cacheKey: 'fingerprint-debug-sim',
          },
        });
        const devices = [
          {
            udid: 'U1',
            name: 'stim-parked (iPhone 17 Pro 26.2) u1',
            state: 'Shutdown',
            isAvailable: true,
            deviceTypeIdentifier: TYPE_17_PRO.identifier,
          },
        ];
        if (collision)
          devices.push({
            udid: 'OTHER',
            name: 'stim-app (iPhone 17 Pro 26.2)',
            state: 'Booted',
            isAvailable: true,
            deviceTypeIdentifier: TYPE_17_PRO.identifier,
          });
        if (stale) setDevice(root, 'ios', { deviceUdid: 'MISSING', owned: true });
        const name = `stim-app (iPhone 17 Pro 26.2)${collision ? ` ${workspaceId(root)}` : ''}`;
        const { run, files, exec } = iosExecutor(devices);
        setExecutor(exec);
        const device = await ensureOwnedDevice({
          platform: 'ios',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
        });
        expect(device).toMatchObject({
          deviceUdid: 'U1',
          deviceName: name,
          adopted: true,
          adoptionPending: true,
          parkedCacheKey: 'fingerprint-debug-sim',
          schemeApprovals,
        });
        expect(readParked('ios')).toEqual([]);
        expect(run).toContain('xcrun simctl boot U1');
        expect(files).toContainEqual(['xcrun', 'simctl', 'rename', 'U1', name]);
        expect(files.some((call) => call.includes('privacy'))).toBe(false);
        await device.booting?.done;
        expect(files).toContainEqual(['xcrun', 'simctl', 'privacy', 'U1', 'reset', 'all']);
        expect(files).toContainEqual(['xcrun', 'simctl', 'keychain', 'U1', 'reset']);
        expect(getProject(root)?.platforms?.ios).toMatchObject({ schemeApprovals });
      } finally {
        delete process.env.STIM_POOL_IOS_PARKED_MAX;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('keeps a parked record renamed away from Stim ownership and creates a fresh simulator', async () => {
    const root = projectDir();
    process.env.STIM_POOL_IOS_PARKED_MAX = '3';
    const output: string[] = [];
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true });
      parkSim({
        platform: 'ios',
        projectPath: root,
        max: 3,
        record: {
          udid: 'U1',
          name: 'stim-parked (iPhone 17 Pro 26.2) u1',
          deviceTypeIdentifier: TYPE_17_PRO.identifier,
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
          parkedAt: '2026-09-01T10:00:00.000Z',
          simslimManaged: false,
        },
      });
      const { files, exec } = iosExecutor([
        {
          udid: 'U1',
          name: 'My iPhone',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: TYPE_17_PRO.identifier,
        },
      ]);
      setExecutor(exec);

      const device = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        out: (line) => {
          output.push(line);
        },
      });

      expect(device).toMatchObject({ deviceUdid: 'NEW-UDID', created: true });
      expect(readParked('ios')).toMatchObject([{ udid: 'U1' }]);
      expect(files.some((call) => call.includes('U1'))).toBe(false);
      expect(output.join('\n')).toMatch(/not Stim-owned/);
    } finally {
      delete process.env.STIM_POOL_IOS_PARKED_MAX;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('drops a gone parked record and creates a fresh simulator', async () => {
    const root = projectDir();
    process.env.STIM_POOL_IOS_PARKED_MAX = '3';
    try {
      setDevice(root, 'ios', { deviceUdid: 'GONE', owned: true });
      parkSim({
        platform: 'ios',
        projectPath: root,
        max: 3,
        record: {
          udid: 'GONE',
          name: 'stim-parked (iPhone 17 Pro 26.2) gone',
          deviceTypeIdentifier: TYPE_17_PRO.identifier,
          runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
          parkedAt: '2026-09-01T10:00:00.000Z',
          simslimManaged: false,
        },
      });
      const { exec } = iosExecutor([]);
      setExecutor(exec);
      const device = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
      });
      expect(device).toMatchObject({ deviceUdid: 'NEW-UDID', created: true });
      await device.booting?.done;
      expect(readParked('ios')).toEqual([]);
    } finally {
      delete process.env.STIM_POOL_IOS_PARKED_MAX;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a pending adoption retries privacy and keychain cleanup on reuse', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', {
        deviceUdid: 'U1',
        owned: true,
        deviceName: 'stim-app (iPhone 17 Pro 26.2)',
        adopted: true,
        adoptionPending: true,
      });
      const { files, exec } = iosExecutor([
        {
          udid: 'U1',
          name: 'stim-app (iPhone 17 Pro 26.2)',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: TYPE_17_PRO.identifier,
        },
      ]);
      setExecutor(exec);
      await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
      });
      expect(files).toContainEqual(['xcrun', 'simctl', 'privacy', 'U1', 'reset', 'all']);
      expect(files).toContainEqual(['xcrun', 'simctl', 'keychain', 'U1', 'reset']);
      expect(getProject(root)?.platforms?.ios?.adoptionPending).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('completing adoption clears both transient adoption fields', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', {
        deviceUdid: 'U1',
        owned: true,
        deviceName: 'stim-app (iPhone 17 Pro 26.2)',
        adopted: true,
        adoptionPending: true,
        parkedCacheKey: 'fingerprint-debug-sim',
      });

      await clearIosAdoptionPending(root);

      expect(getProject(root)?.platforms?.ios).toEqual({
        deviceUdid: 'U1',
        owned: true,
        deviceName: 'stim-app (iPhone 17 Pro 26.2)',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('recorded scheme approvals stay with their simulator through a reboot and never move to another one', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      await recordIosSchemeApprovals(root, 'OTHER', ['bridge-->app']);
      expect(getProject(root)?.platforms?.ios?.schemeApprovals).toBeUndefined();
      await recordIosSchemeApprovals(root, 'U1', ['bridge-->app']);

      setExecutor(iosExecutor([{ udid: 'U1', name: 'stim-app', state: 'Shutdown', isAvailable: true }]).exec);
      const device = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
      });
      await device.booting?.done;
      expect(device.schemeApprovals).toEqual(['bridge-->app']);
      expect(getProject(root)?.platforms?.ios?.schemeApprovals).toEqual(['bridge-->app']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the budget gate, capacity check and device setup of a cache hit share one simctl list', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app (iPhone 17 Pro 26.2)' });
      const { run, exec } = iosExecutor([
        {
          udid: 'U1',
          name: 'stim-app (iPhone 17 Pro 26.2)',
          state: 'Booted',
          isAvailable: true,
          deviceTypeIdentifier: TYPE_17_PRO.identifier,
        },
      ]);
      setExecutor(exec);
      const simSnapshot = createIosSimSnapshot();
      const limits = { minFreeDiskMb: 0, hardFloorDiskMb: 0, maxCommittedMemoryMb: 1_000_000, maxLiveWorkspaces: 10 };
      const outcome = await enforceBudget({ root, note: () => {}, budget: limits, simSnapshot });
      expect(outcome.status).toBe('ok');
      expect(
        await checkDeviceCapacity({
          platform: 'ios',
          project: getProject(root),
          max: 5,
          sims: () => simSnapshot.read().filter((sim) => sim.available),
          adb: () => makeAdbDevices(),
          booting: [],
        }),
      ).toBeNull();
      const device = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        simSnapshot,
      });
      expect(await ensureBooted({ platform: 'ios', projectPath: root, device, timeoutMs: 5000, pollMs: 5 })).toEqual({
        ok: true,
        udid: 'U1',
      });
      expect(run.filter((cmd) => cmd.includes('simctl list'))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('applies the configured SimSlim profile to an owned simulator and records management', async () => {
    const root = projectDir();
    try {
      const profilePath = join(root, 'simslim.json');
      writeFileSync(profilePath, '{}\n');
      const profile = realpathSync(profilePath);
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      const { exec } = iosExecutor([{ udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true }]);
      setExecutor(exec);
      const calls: unknown[] = [];

      await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: { ios: { simslimProfile: 'simslim.json' } },
        reconcileIosSimulator: async (args) => {
          calls.push(args);
          return { managed: true, profile };
        },
      });

      expect(calls).toMatchObject([{ udid: 'U1', profile, previouslyManaged: false }]);
      expect(getProject(root)?.platforms?.ios?.simslimManaged).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records SimSlim management before profile application can fail', async () => {
    const root = projectDir();
    try {
      const profilePath = join(root, 'simslim.json');
      writeFileSync(profilePath, '{}\n');
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      const { exec } = iosExecutor([{ udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true }]);
      setExecutor(exec);
      let managedBeforeRun = false;

      await expect(
        ensureOwnedDevice({
          platform: 'ios',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: { ios: { simslimProfile: 'simslim.json' } },
          reconcileIosSimulator: async () => {
            managedBeforeRun = getProject(root)?.platforms?.ios?.simslimManaged === true;
            throw new Error('partial SimSlim failure');
          },
        }),
      ).rejects.toThrow('partial SimSlim failure');

      expect(managedBeforeRun).toBe(true);
      expect(getProject(root)?.platforms?.ios?.simslimManaged).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an owned record renamed away from stim- ownership is never booted; a fresh owned sim is created', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-old' });
      const { run, exec } = iosExecutor([
        { udid: 'U1', name: 'Renamed-By-User', state: 'Shutdown', isAvailable: true },
      ]);
      setExecutor(exec);
      const notes: string[] = [];
      const result = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        note: (l) => notes.push(String(l)),
      });
      expect(run.some((c) => c === 'xcrun simctl boot U1')).toBe(false);
      expect(run.some((c) => /simctl create/.test(c))).toBeTruthy();
      expect(result.deviceUdid).toBe('NEW-UDID');
      expect(result.owned).toBe(true);
      expect(result.created).toBe(true);
      expect(notes.some((n) => /not Stim-owned/i.test(n))).toBeTruthy();
      await result.booting?.done;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('SimSlim rerun on a running simulator', () => {
    function prepareRunning(springBoardPids: number[]) {
      const root = projectDir();
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      const { exec } = iosExecutor([{ udid: 'U1', name: 'stim-app', state: 'Booted', isAvailable: true }]);
      const events: string[] = [];
      const pids = [...springBoardPids];
      setExecutor({
        ...exec,
        runFile(file, args = []) {
          if (file === 'xcrun' && args[0] === 'devicectl') {
            events.push('mute');
            return JSON.stringify({ info: { outcome: 'success' }, result: { deviceIdentifier: 'U1', volume: 0 } });
          }
          if (file === 'xcrun' && args.includes('notifyutil')) {
            return `com.apple.springboard.finishedstartup ${pids.length > 1 ? pids.shift() : pids[0]}`;
          }
          return exec.runFile(file, args);
        },
      });
      const notes: string[] = [];
      const run = (settings: Record<string, unknown>) =>
        ensureOwnedDevice({
          platform: 'ios',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings,
          out: (line) => notes.push(line),
          reconcileIosSimulator: async (args) => {
            events.push(`reconcile ${args.profile ?? (args.slimByDefault ? 'default' : 'off')}`);
            return { managed: Boolean(args.profile) || Boolean(args.slimByDefault), profile: args.profile ?? null };
          },
        });
      return { root, events, notes, run };
    }

    test('records the SpringBoard pids when SimSlim reboots the simulator', async () => {
      const { root, run } = prepareRunning([1111, 4242]);
      try {
        await run({ ios: { simslim: 'on' } });
        expect(deviceLog(root).filter((record) => record.phase === 'simslim_reboot')).toMatchObject([
          { event: 'ios_boot', deviceId: 'U1', pidBefore: 1111, pidAfter: 4242 },
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test('restores stock services when SimSlim is turned off after a skipped rerun', async () => {
      const { root, events, run } = prepareRunning([4242]);
      try {
        await run({ ios: { simslim: 'on' } });
        await run({ ios: { simslim: 'on' } });
        expect(events).toEqual(['reconcile default']);
        events.length = 0;
        await run({ ios: { simslim: 'off' } });
        expect(events).toEqual(['reconcile off']);
        const ios = getProject(root)?.platforms?.ios;
        expect(ios?.simslimManaged).toBeUndefined();
        expect(ios?.simslimApplied).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test('a legacy shut-down sim (no owned flag) is reported, never booted', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1' });
      const { run, exec } = iosExecutor([{ udid: 'U1', name: 'iPhone 16', state: 'Shutdown', isAvailable: true }]);
      setExecutor(exec);
      const notes: string[] = [];
      const result = await ensureOwnedDevice({
        platform: 'ios',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        note: (l) => notes.push(String(l)),
      });
      expect(run.some((c) => /simctl boot/.test(c))).toBe(false);
      expect(run.some((c) => /simctl create/.test(c))).toBe(false);
      expect(result.deviceUdid).toBe('U1');
      expect(!result.owned).toBeTruthy();
      expect(notes.some((n) => /not owned by Stim/i.test(n))).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureOwnedDevice: android', () => {
  let androidHome: string;
  let prevAndroidHome: string | undefined;
  let prevAndroidAvdHome: string | undefined;
  let prevFallbackRoots: Record<string, string | undefined>;

  beforeEach(() => {
    androidHome = mkdtempSync(join(tmpdir(), 'stim-test-sdk-'));
    mkdirSync(join(androidHome, 'system-images', 'android-36', 'google_apis', 'arm64-v8a'), { recursive: true });
    mkdirSync(join(androidHome, 'system-images', 'android-36', 'google_apis', 'x86_64'), { recursive: true });
    prevAndroidHome = process.env.ANDROID_HOME;
    prevAndroidAvdHome = process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_HOME = androidHome;
    process.env.ANDROID_AVD_HOME = join(androidHome, 'avd');
    prevFallbackRoots = Object.fromEntries(
      ['HOME', 'ANDROID_SDK_HOME', 'ANDROID_USER_HOME', 'ANDROID_EMULATOR_HOME'].map((key) => [key, process.env[key]]),
    );
    process.env.HOME = androidHome;
    process.env.ANDROID_SDK_HOME = androidHome;
    process.env.ANDROID_USER_HOME = join(androidHome, '.android');
    process.env.ANDROID_EMULATOR_HOME = join(androidHome, '.android');
  });

  afterEach(() => {
    rmSync(androidHome, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prevFallbackRoots)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (prevAndroidHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = prevAndroidHome;
    if (prevAndroidAvdHome === undefined) delete process.env.ANDROID_AVD_HOME;
    else process.env.ANDROID_AVD_HOME = prevAndroidAvdHome;
  });

  function androidExecutor({
    avds = [],
    createAvdError = null,
    writeAvdFiles = true,
    beforeCreateAvdError = () => {},
    bootCompletes = true,
    runningAvdName = '',
    adbDevices = 'List of devices attached\n',
    onSpawn = () => {},
  }: {
    avds?: string[];
    createAvdError?: string | null;
    writeAvdFiles?: boolean;
    beforeCreateAvdError?: () => void;
    bootCompletes?: boolean;
    runningAvdName?: string;
    adbDevices?: string | Error;
    onSpawn?: () => void;
  } = {}) {
    const run: string[] = [];
    const spawn: { cmd: string; args: readonly string[]; opts?: object }[] = [];
    return {
      run,
      spawn,
      exec: {
        run(cmd: string) {
          run.push(cmd);
          if (cmd === 'emulator -list-avds') return avds.length ? `${avds.join('\n')}\n` : '';
          if (/delete avd/.test(cmd)) {
            const name = / -n (\S+)/.exec(cmd)?.[1];
            assert(name);
            avds = avds.filter((entry) => entry !== name);
            rmSync(join(process.env.ANDROID_AVD_HOME!, `${name}.ini`), { force: true });
            rmSync(join(process.env.ANDROID_AVD_HOME!, `${name}.avd`), { recursive: true, force: true });
            return '';
          }
          if (cmd === 'adb devices') {
            if (adbDevices instanceof Error) throw adbDevices;
            return adbDevices;
          }
          if (/emu avd name/.test(cmd)) return runningAvdName;
          if (/getprop sys\.boot_completed/.test(cmd)) return bootCompletes ? '1' : '';
          if (/pm path android/.test(cmd)) return bootCompletes ? 'package:/system/framework/framework-res.apk' : '';
          if (/getprop /.test(cmd)) return '';
          throw new Error(`unexpected run: ${cmd}`);
        },
        runQuiet(cmd: string) {
          try {
            return this.run(cmd);
          } catch {
            return null;
          }
        },
        runFile(file: string, args: string[] = []): string {
          if (file === 'adb' || file === 'emulator' || file === 'avdmanager')
            return this.run([file, ...args].join(' '));
          return '';
        },
        runFileQuiet(file: string, args: string[] = []) {
          if (file === 'adb' || file === 'emulator') return this.runQuiet([file, ...args].join(' '));
          return file === 'ps' ? '' : null;
        },
        spawn(cmd: string, args: readonly string[], opts?: object) {
          if (args[0] === 'create') {
            run.push([cmd, ...args].join(' '));
            if (createAvdError) {
              beforeCreateAvdError();
              return makeExitingChild(1, createAvdError);
            }
            const name = args[args.indexOf('-n') + 1];
            assert(name);
            avds.push(name);
            const root = process.env.ANDROID_AVD_HOME!;
            const content = join(root, `${name}.avd`);
            mkdirSync(content, { recursive: true });
            writeFileSync(join(root, `${name}.ini`), `path=${content}\n`);
            if (writeAvdFiles) {
              writeFileSync(join(content, 'config.ini'), 'hw.cpu.ncore=4\ndisk.dataPartition.size=10G\n');
            }
            return makeExitingChild();
          }
          onSpawn();
          spawn.push({ cmd, args, opts });
          return { pid: 9999, unref() {} };
        },
      },
    };
  }

  test('a repeated named slot on its running owned AVD keeps systemImage, so one ABI and the same cache key', async () => {
    const root = projectDir();
    try {
      setExecutor(androidExecutor().exec);
      const first = await ensureOwnedDevice({
        platform: 'android',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        slot: 'second',
      });
      const arch = hostSystemImageArch();
      expect(first.systemImage).toBe(`system-images;android-36;google_apis;${arch}`);
      // avdmanager joins image.sysdir.1 with File.separator, so a Windows AVD stores backslashes.
      writeFileSync(
        join(process.env.ANDROID_AVD_HOME!, `${first.avdName}.avd`, 'config.ini'),
        `image.sysdir.1=system-images\\android-36\\google_apis\\${arch}\\\ndisk.dataPartition.size=10G\n`,
      );
      setExecutor(
        androidExecutor({
          avds: [first.avdName!],
          adbDevices: `List of devices attached\nemulator-${first.consolePort}\tdevice\n`,
          runningAvdName: first.avdName,
        }).exec,
      );
      const repeated = await ensureOwnedDevice({
        platform: 'android',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: {},
        slot: 'second',
      });
      expect(repeated.avdName).toBe(first.avdName);
      expect(repeated.systemImage).toBe(first.systemImage);
      const options = (device: typeof first) =>
        androidBuildOptions({ release: false, physical: false, device, variant: null, deviceAbi: async () => null });
      expect((await options(first)).abi).toBe(arch);
      expect((await options(repeated)).abi).toBe(arch);
      expect(buildCacheKey('android', 'same-fingerprint', (await options(repeated)).runOptions)).toBe(
        buildCacheKey('android', 'same-fingerprint', (await options(first)).runOptions),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed new-AVD configuration is centrally deleted and never booted', async () => {
    const root = projectDir();
    try {
      const { run, spawn, exec } = androidExecutor({ writeAvdFiles: false });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
        }),
      ).rejects.toThrow(/could not configure its AVD settings/i);
      expect(run).toContain('avdmanager delete avd -n stim-app');
      expect(spawn).toEqual([]);
      expect(getProject(root)?.platforms?.android).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed configuration rollback stays tracked and cannot be recovered or booted', async () => {
    const root = projectDir();
    try {
      const { run, spawn, exec } = androidExecutor();
      setExecutor(exec);
      const configureAvd = () => {
        throw new Error('EEXIST: file already exists');
      };
      const teardownAvd = async () => ({ status: 'failed' as const, reason: 'delete failed' });
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
          configureAvd,
          teardownAvd,
        }),
      ).rejects.toThrow(/could not configure.*already exists.*tracked for cleanup/i);
      expect(getProject(root)?.platforms?.android).toMatchObject({
        avdName: 'stim-app',
        owned: true,
        setupIncomplete: true,
      });
      expect(spawn).toEqual([]);
      expect(run.filter((cmd) => /create avd/.test(cmd))).toHaveLength(1);

      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
          configureAvd,
          teardownAvd,
        }),
      ).rejects.toThrow(/incomplete setup.*could not be deleted/i);
      expect(spawn).toEqual([]);
      expect(run.filter((cmd) => /create avd/.test(cmd))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unrecorded existing owned AVD is recovered without resizing it', async () => {
    const root = projectDir();
    const avdRoot = process.env.ANDROID_AVD_HOME!;
    const content = join(avdRoot, 'stim-app.avd');
    mkdirSync(content, { recursive: true });
    writeFileSync(join(avdRoot, 'stim-app.ini'), `path=${content}\n`);
    writeFileSync(join(content, 'config.ini'), 'disk.dataPartition.size=10G\n');
    try {
      const { exec, spawn } = androidExecutor({
        avds: ['stim-app'],
        createAvdError: 'Error: AVD stim-app already exists.',
      });
      setExecutor(exec);
      const recovered = await ensureOwnedDevice({
        platform: 'android',
        project: getProject(root),
        projectPath: root,
        label: 'app',
        settings: { android: { dataPartitionSizeGb: 6, avdConfig: { 'hw.keyboard': true } } },
        configureAvd: () => {
          throw new Error('must not configure a recovered AVD');
        },
      });
      expect(readFileSync(join(content, 'config.ini'), 'utf8')).toBe('disk.dataPartition.size=10G\n');
      expect(spawn).toHaveLength(1);
      expect(recovered.created).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unregistered AVD directory refuses creation with a GC remedy and keeps its data', async () => {
    const root = projectDir();
    const content = join(process.env.ANDROID_AVD_HOME!, 'stim-app.avd');
    mkdirSync(content, { recursive: true });
    writeFileSync(join(content, 'config.ini'), 'disk.dataPartition.size=10G\n');
    try {
      const { exec, spawn, run } = androidExecutor({ createAvdError: `Error: ${content} already exists!` });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
        }),
      ).rejects.toMatchObject({
        constructor: AvdRecoveryError,
        message: expect.stringContaining(`AVD stim-app already exists on disk but is not listed`),
        remedy: expect.stringContaining('npx stim gc --delete'),
      });
      expect(getProject(root)?.platforms?.android).toBeUndefined();
      expect(spawn).toEqual([]);
      expect(run.some((cmd) => cmd.includes('delete avd'))).toBe(false);
      expect(readFileSync(join(content, 'config.ini'), 'utf8')).toBe('disk.dataPartition.size=10G\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a stale project snapshot cannot recover an AVD another concurrent run just recorded', async () => {
    const root = projectDir();
    try {
      const staleProject = getProject(root);
      const { spawn, exec } = androidExecutor({
        avds: ['stim-app'],
        createAvdError: 'Error: AVD stim-app already exists.',
        beforeCreateAvdError: () => {
          setDevice(root, 'android', { avdName: 'stim-app', owned: true, setupIncomplete: true });
        },
      });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: staleProject,
          projectPath: root,
          label: 'app',
          settings: {},
        }),
      ).rejects.toThrow(/incomplete setup.*concurrent Stim run/i);
      expect(spawn).toEqual([]);
      expect(getProject(root)?.platforms?.android).toMatchObject({
        avdName: 'stim-app',
        setupIncomplete: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an AVD claimed by another project during creation errors instead of being hijacked', async () => {
    const other = projectDir();
    const root = projectDir();
    try {
      const { spawn, exec } = androidExecutor({
        avds: ['stim-app'],
        createAvdError: 'Error: AVD stim-app already exists.',
        beforeCreateAvdError: () => {
          setDevice(other, 'android', { avdName: 'stim-app', consolePort: 5554, owned: true });
        },
      });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
        }),
      ).rejects.toThrow(/owned by another project.*Retry to allocate a distinct owned emulator/);
      expect(spawn).toEqual([]);
      expect(getProject(root)?.platforms?.android).toBeUndefined();
      expect(getProject(other)?.platforms?.android).toMatchObject({ avdName: 'stim-app', owned: true });
    } finally {
      rmSync(other, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a failed boot releases the port claim and keeps the owned AVD recorded for gc', async () => {
    const root = projectDir();
    try {
      const { exec } = androidExecutor({ bootCompletes: false });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
          alive: () => false,
        }),
      ).rejects.toThrow(/exited before the device finished booting/);
      const record = getProject(root)?.platforms?.android;
      expect(record).toMatchObject({ avdName: 'stim-app', owned: true });
      expect(record?.consolePort).toBeUndefined();
      expect(allConsolePortsAndSerials().androidConsolePorts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an emulator that booted another AVD on the claimed serial is refused and the claim released', async () => {
    const root = projectDir();
    try {
      const { exec } = androidExecutor({ runningAvdName: 'Pixel_7_API_35\nOK' });
      setExecutor(exec);
      await expect(
        ensureOwnedDevice({
          platform: 'android',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
        }),
      ).rejects.toThrow(/emulator-5554 is running AVD Pixel_7_API_35, not this workspace's owned AVD stim-app/);
      expect(getProject(root)?.platforms?.android?.consolePort).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('claimAndroidConsolePort', () => {
  function fakeRegistry() {
    const ports = new Map<string, number>();
    let depth = 0;
    const seenDepths: number[] = [];
    return {
      ports,
      seenDepths,
      lock: <T>(fn: () => T): T => {
        expect(depth).toBe(0);
        depth += 1;
        try {
          return fn();
        } finally {
          depth -= 1;
        }
      },
      recordedPorts: () => {
        seenDepths.push(depth);
        return [...ports.values()];
      },
      record: (projectPath: string, _platform: string, fields: DeviceRecord) => {
        seenDepths.push(depth);
        ports.set(projectPath, fields.consolePort as number);
      },
    };
  }

  test('two workspaces claiming at once take distinct ports because the read and the record share one lock', () => {
    const registry = fakeRegistry();
    const deps = { lock: registry.lock, recordedPorts: registry.recordedPorts, record: registry.record };
    const first = claimAndroidConsolePort({ projectPath: '/w/a', avdName: 'stim-a' }, deps);
    const second = claimAndroidConsolePort({ projectPath: '/w/b', avdName: 'stim-b' }, deps);
    expect(first.consolePort).toBe(5554);
    expect(second.consolePort).toBe(5556);
    expect([...registry.ports]).toEqual([
      ['/w/a', 5554],
      ['/w/b', 5556],
    ]);
    expect(registry.seenDepths).toEqual([1, 1, 1, 1]);
  });

  test('a claim keeps the pending first boot of the record it replaces', () => {
    const recorded: DeviceRecord[] = [];
    const claim = claimAndroidConsolePort(
      { projectPath: '/w/a', avdName: 'stim-a', metadata: { bootPending: true } },
      { lock: (fn) => fn(), recordedPorts: () => [], record: (_path, _platform, fields) => recorded.push(fields) },
    );
    expect(claim.bootPending).toBe(true);
    expect(recorded[0]).toMatchObject({ bootPending: true });
  });

  test('live emulator ports outside the registry are claimed too', () => {
    const registry = fakeRegistry();
    const claim = claimAndroidConsolePort(
      { projectPath: '/w/a', avdName: 'stim-a', deviceName: 'stim-a', livePorts: [5554, 5556] },
      { lock: registry.lock, recordedPorts: registry.recordedPorts, record: registry.record },
    );
    expect(claim.consolePort).toBe(5558);
    expect(registry.ports.get('/w/a')).toBe(5558);
  });
});

describe('deviceCapacityRefusal', () => {
  const booted = (udid: string, name: string) => makeIosSim({ udid, name, state: 'Booted' });
  const shutdown = (udid: string, name: string) => makeIosSim({ udid, name, state: 'Shutdown' });

  test('booted and booting Stim sims count toward the cap; shut-down and foreign sims do not', () => {
    const args = {
      platform: 'ios',
      project: { platforms: {} },
      adb: makeAdbDevices({ emulators: [] }),
      config: makeConfig(),
    };
    const sims = [booted('u1', 'stim-a'), shutdown('u2', 'stim-b'), booted('u3', 'someone-else')];
    expect(deviceCapacityRefusal({ ...args, max: 2, sims })).toBe(null);
    const withBooting = [...sims, makeIosSim({ udid: 'u4', name: 'stim-c', state: 'Booting' })];
    expect(deviceCapacityRefusal({ ...args, max: 2, sims: withBooting })?.code).toBe('STIM_AT_CAPACITY');
  });
});

describe('a boot refused at admission', () => {
  const failedBoot = (refusal: Error) => {
    const done = Promise.reject(refusal);
    done.catch(() => {});
    return { deviceUdid: 'u1', owned: true, booting: { udid: 'u1', done } };
  };

  test('reports a claim it cannot take with the claim code and the command that removes it', async () => {
    const refused = new ClaimRefusedError({
      root: join(tmpHome, 'device-boots'),
      claimPath: join(tmpHome, 'device-boots', 'shared', 'x.claim'),
      label: 'device boot',
      reason: 'its process identity token does not decode',
    });
    const result = await ensureBooted({ projectPath: tmpHome, platform: 'ios', device: failedBoot(refused) });
    expect(result).toMatchObject({ failed: true, code: 'STIM_CLAIM_REFUSED' });
    expect(result.remedy).toContain('rm -f');
  });
});

describe('withDeviceBootAdmission', () => {
  const sources = { sims: [], adb: makeAdbDevices(), config: makeConfig() };

  describe('with a booting claim Stim cannot verify', () => {
    const listings = sources;
    beforeEach(() => {
      const shared = join(tmpHome, 'device-boots', 'shared');
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, 'stray'), 'x');
    });

    test('the count is unknown, not zero', () => {
      expect(countLiveOwnedDevices(listings)).toMatchObject({ unknown: expect.stringContaining('device boot claim') });
    });

    test('the boot is refused with the claim code and the command that removes it', async () => {
      await expect(
        withDeviceBootAdmission({ platform: 'ios', key: 'u1' }, async () => 'booted', {
          root: tmpHome,
          noWait: true,
          max: 2,
          sources: listings,
        }),
      ).rejects.toMatchObject({ code: 'STIM_CLAIM_REFUSED', removeCommand: expect.stringContaining('rm ') });
    });
  });

  test('a boot in flight keeps its place, so a racing run for the last slot is refused', async () => {
    let finishBoot!: () => void;
    let admitted!: () => void;
    const inFlight = new Promise<void>((resolve) => (admitted = resolve));
    const first = withDeviceBootAdmission(
      { platform: 'ios', key: 'u1' },
      () =>
        new Promise<string>((resolve) => {
          admitted();
          finishBoot = () => resolve('booted');
        }),
      { root: tmpHome, noWait: true, max: 1, sources },
    );
    await inFlight;
    const second = withDeviceBootAdmission({ platform: 'ios', key: 'u2' }, async () => 'booted', {
      root: tmpHome,
      noWait: true,
      max: 1,
      sources,
    });
    await expect(second).rejects.toMatchObject({ code: 'STIM_AT_CAPACITY' });
    const { record } = decodeStats(readFileSync(statsFile(), 'utf-8'));
    expect(record?.capacityRefusals).toEqual([
      expect.objectContaining({ kind: 'device', platform: 'ios', max: 1, workspace: workspaceId(tmpHome) }),
    ]);
    finishBoot();
    await expect(first).resolves.toBe('booted');
    await expect(
      withDeviceBootAdmission({ platform: 'ios', key: 'u2' }, async () => 'booted', {
        root: tmpHome,
        noWait: true,
        max: 1,
        sources,
      }),
    ).resolves.toBe('booted');
  });
});

describe('ensureOwnedDevice: the requested model against the sim this workspace already owns', () => {
  test('a different model refuses with the reap-then-rerun remedy and boots nothing', async () => {
    const root = projectDir();
    try {
      setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
      const { run, exec } = iosExecutor([
        {
          udid: 'U1',
          name: 'stim-app',
          state: 'Shutdown',
          isAvailable: true,
          deviceTypeIdentifier: TYPE_16.identifier,
        },
      ]);
      setExecutor(exec);

      await expect(
        ensureOwnedDevice({
          platform: 'ios',
          project: getProject(root),
          projectPath: root,
          label: 'app',
          settings: {},
          flags: { deviceType: 'iPhone 17 Pro' },
        }),
      ).rejects.toMatchObject({
        message:
          "this project's sim is iPhone 16, but --device-type asked for iPhone 17 Pro. Stim will not silently boot a different model.",
        remedy: expect.stringMatching(/stim worktree remove.*stim gc --delete.*--slot <name>/),
      });

      expect(run.some((cmd) => /simctl boot/.test(cmd))).toBe(false);
      expect(run.some((cmd) => /simctl create/.test(cmd))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const ensureOnSim26 = (flags: { runtime: string; runtimeFlag?: string }) => {
    const root = projectDir();
    setDevice(root, 'ios', { deviceUdid: 'U1', owned: true, deviceName: 'stim-app' });
    const { run, exec } = iosExecutor([
      {
        udid: 'U1',
        name: 'stim-app',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: TYPE_16.identifier,
      },
    ]);
    setExecutor(exec);
    const ensured = ensureOwnedDevice({
      platform: 'ios',
      project: getProject(root),
      projectPath: root,
      label: 'app',
      settings: {},
      flags,
    });
    return { root, run, ensured };
  };

  test('--runtime naming another installed version than the sim runs refuses and creates nothing', async () => {
    const { root, run, ensured } = ensureOnSim26({ runtime: '18.6', runtimeFlag: '18.6' });
    try {
      await expect(ensured).rejects.toMatchObject({
        message:
          "this project's sim runs iOS 26.2, but --runtime asked for 18.6. Stim will not silently boot a different iOS version.",
        remedy: expect.stringMatching(/stim worktree remove.*stim gc --delete.*--slot <name>/),
      });
      expect(run.some((cmd) => /simctl create/.test(cmd))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
