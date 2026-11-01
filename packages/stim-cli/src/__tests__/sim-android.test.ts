import { withAmbientContext } from '@stim-cli/core';
import { testContext } from './_context.ts';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { setExecutor, resetExecutor } from '../exec.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { makeExecutor } from './_factories.ts';
import {
  bootAndroidEmulator,
  configureNewOwnedAvd,
  parseAdbDevices,
  nextConsolePort,
  ownedAvdDirectory,
  deleteAvd,
  resolveOwnedAvdSerial,
  resolveOwnedAvdSerialAsync,
  ownedAvdSerialResolverAsync,
  shutdownAndroidEmulator,
  resolvePhysicalDevice,
  assertOwnedAvdStopped,
  assertOwnedAvdStoppedAsync,
  parseDfAvailableBytes,
  waitForAndroidEmulatorShutdown,
  waitForBoot,
} from '../devices/android.ts';

let tmpHome: string;
let savedAndroidHome: string | undefined;
let savedSdkRoot: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  for (const name of [
    'stim-a',
    'stim-app',
    'stim-b',
    'stim-gone',
    'stim-linked',
    'stim-mine',
    'stim-moved',
    'stim-my-project',
    'stim-relative',
    'stim-stopped',
  ])
    recordCreatedDevice('android', name);
  savedAndroidHome = process.env.ANDROID_HOME;
  savedSdkRoot = process.env.ANDROID_SDK_ROOT;
  process.env.ANDROID_HOME = join(tmpHome, 'no-sdk-here');
  delete process.env.ANDROID_SDK_ROOT;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  if (savedAndroidHome === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = savedAndroidHome;
  if (savedSdkRoot === undefined) delete process.env.ANDROID_SDK_ROOT;
  else process.env.ANDROID_SDK_ROOT = savedSdkRoot;
  resetExecutor();
});

const SDK_TOOL_FILES =
  process.platform === 'win32'
    ? { emulator: 'emulator.exe', adb: 'adb.exe', avdmanager: 'avdmanager.bat' }
    : { emulator: 'emulator', adb: 'adb', avdmanager: 'avdmanager' };

function makeFakeSdk(root: string): string {
  const sdk = join(root, 'sdk');
  mkdirSync(join(sdk, 'emulator'), { recursive: true });
  writeFileSync(join(sdk, 'emulator', SDK_TOOL_FILES.emulator), '');
  mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
  writeFileSync(join(sdk, 'platform-tools', SDK_TOOL_FILES.adb), '');
  mkdirSync(join(sdk, 'cmdline-tools', 'latest', 'bin'), { recursive: true });
  writeFileSync(join(sdk, 'cmdline-tools', 'latest', 'bin', SDK_TOOL_FILES.avdmanager), '');
  return sdk;
}

test('nextConsolePort returns 5554 when none claimed', () => {
  expect(nextConsolePort([])).toBe(5554);
});

test('nextConsolePort returns next even port above max claimed', () => {
  expect(nextConsolePort([5554, 5556])).toBe(5558);
});

function writeAvdRoot(root: string, name: string, contents: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${name}.ini`), contents);
}

test('ownedAvdDirectory resolves moved, relative, and symlinked content directories', () => {
  const sdkHome = join(tmpHome, 'android-sdk-home');
  const root = join(sdkHome, 'avd');
  const moved = join(tmpHome, 'moved', 'stim-moved.avd');
  const relative = join(sdkHome, 'elsewhere', 'stim-relative.avd');
  const target = join(tmpHome, 'target', 'stim-linked.avd');
  const link = join(tmpHome, 'linked.avd');
  for (const dir of [moved, relative, target]) mkdirSync(dir, { recursive: true });
  symlinkSync(target, link, 'dir');
  writeAvdRoot(root, 'stim-moved', `path=${moved}\n`);
  writeAvdRoot(root, 'stim-relative', `path=${join(tmpHome, 'missing.avd')}\npath.rel=elsewhere/stim-relative.avd\n`);
  writeAvdRoot(root, 'stim-linked', `path=${link}\n`);
  const options = { env: { ANDROID_SDK_HOME: sdkHome }, home: join(tmpHome, 'home') };

  expect(ownedAvdDirectory('stim-moved', options)).toBe(realpathSync(moved));
  expect(ownedAvdDirectory('stim-relative', options)).toBe(realpathSync(relative));
  expect(ownedAvdDirectory('stim-linked', options)).toBe(realpathSync(target));
});

test('ownedAvdDirectory fails closed for invalid names and a malformed selected root', () => {
  const avdHome = join(tmpHome, 'avd-home');
  const fallbackRoot = join(tmpHome, 'home', '.android', 'avd');
  const fallback = join(tmpHome, 'fallback.avd');
  mkdirSync(fallback, { recursive: true });
  writeAvdRoot(avdHome, 'stim-app', 'target=android-36\n');
  writeAvdRoot(fallbackRoot, 'stim-app', `path=${fallback}\n`);
  const options = { env: { ANDROID_AVD_HOME: avdHome }, home: join(tmpHome, 'home') };

  expect(ownedAvdDirectory('stim-app', options)).toBe(null);
  expect(ownedAvdDirectory('Pixel_7', options)).toBe(null);
  expect(ownedAvdDirectory('stim-../../outside', options)).toBe(null);
});

test('configureNewOwnedAvd removes its temporary file when replacement fails', () => {
  const content = join(tmpHome, 'stim-app.avd');
  mkdirSync(content, { recursive: true });
  const config = join(content, 'config.ini');
  writeFileSync(config, 'disk.dataPartition.size=10G\n');

  expect(() =>
    configureNewOwnedAvd(
      'stim-app',
      { dataPartitionSizeGb: 6 },
      {
        avdDirectory: () => content,
        rename: () => {
          throw new Error('rename failed');
        },
      },
    ),
  ).toThrow(/rename failed/);
  expect(readFileSync(config, 'utf8')).toBe('disk.dataPartition.size=10G\n');
  expect(readdirSync(content).filter((name) => name.includes('.stim-'))).toEqual([]);
});

test('deleteAvd refuses to delete an AVD not owned by Stim', async () => {
  setExecutor({
    runFile: () => {
      throw new Error('should not be called');
    },
    spawn: () => null,
  });
  await expect(deleteAvd('Pixel_6_API_34')).rejects.toThrow(/Stim/);
});

const AVD_SERIAL_RESOLVERS = [
  ['sync', async (avdName: string, opts?: { timeoutMs?: number }) => resolveOwnedAvdSerial(avdName, opts)],
  ['async', resolveOwnedAvdSerialAsync],
] as const;

test.each(AVD_SERIAL_RESOLVERS)(
  'resolveOwnedAvdSerial (%s) reports notRunning when the recorded port is held by a foreign emulator',
  async (_kind, resolve) => {
    setExecutor({
      runFile: (file, args = []) => {
        const cmd = [file, ...args].join(' ');
        if (cmd === 'emulator -list-avds') return 'stim-mine\n';
        if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\n';
        return '';
      },
      runFileQuiet: (file: string, args: string[] = []) => {
        const cmd = [file, ...args].join(' ');
        if (/adb -s emulator-5554 emu avd name/.test(cmd)) return 'Android_Studio_Default\nOK';
        return null;
      },
      spawn: () => null,
    });
    expect(await resolve('stim-mine')).toEqual({ notRunning: true });
  },
);

describe('resolveOwnedAvdSerialAsync with a busy foreign emulator', () => {
  const CONSOLE_TIMEOUT_MS = 10_000;
  const AVD_BY_SERIAL: Record<string, string | undefined> = {
    'emulator-5554': undefined,
    'emulator-5556': 'stim-mine',
    'emulator-5558': 'stim-b',
  };

  function stubEmulators(serials: string[]) {
    const queried: string[] = [];
    const aborted: string[] = [];
    setExecutor(
      makeExecutor({
        runFile: (file, args = []) => {
          const cmd = [file, ...args].join(' ');
          if (cmd === 'emulator -list-avds') return 'stim-mine\nstim-b\n';
          if (cmd === 'adb devices')
            return `List of devices attached\n${serials.map((serial) => `${serial}\tdevice`).join('\n')}\n`;
          return '';
        },
        runFileQuietAsync: async (file, args = [], opts) => {
          const serial = /adb -s (\S+) emu avd name/.exec([file, ...args].join(' '))?.[1];
          if (!serial) return null;
          queried.push(serial);
          const name = AVD_BY_SERIAL[serial];
          if (name) return `${name}\nOK`;
          return new Promise<string | null>((resolve, reject) => {
            const timer = setTimeout(
              () => resolve(null),
              typeof opts.timeoutMs === 'number' ? opts.timeoutMs : CONSOLE_TIMEOUT_MS,
            );
            opts.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              aborted.push(serial);
              reject(opts.signal?.reason);
            });
          });
        },
      }),
    );
    return { queried, aborted };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean; value?: T }> {
    let result: { settled: boolean; value?: T } = { settled: false };
    void promise.then((value) => {
      result = { settled: true, value };
      return value;
    });
    await vi.advanceTimersByTimeAsync(ms);
    return result;
  }

  test('reads the recorded serial first and never asks the foreign emulator', async () => {
    const { queried } = stubEmulators(['emulator-5554', 'emulator-5556']);
    const outcome = await settlesWithin(
      resolveOwnedAvdSerialAsync('stim-mine', { timeoutMs: 600_000, preferredSerial: 'emulator-5556' }),
      100,
    );
    expect(outcome).toEqual({ settled: true, value: { serial: 'emulator-5556' } });
    expect(queried).toEqual(['emulator-5556']);
  });

  test('does not trust the recorded serial when it runs another AVD', async () => {
    const { queried } = stubEmulators(['emulator-5558', 'emulator-5556']);
    const outcome = await settlesWithin(
      resolveOwnedAvdSerialAsync('stim-mine', { preferredSerial: 'emulator-5558' }),
      100,
    );
    expect(outcome).toEqual({ settled: true, value: { serial: 'emulator-5556' } });
    expect(queried).toEqual(['emulator-5558', 'emulator-5556']);
  });

  test('a hung emulator listed first does not delay the match and its read is cancelled', async () => {
    const { aborted } = stubEmulators(['emulator-5554', 'emulator-5556']);
    const outcome = await settlesWithin(resolveOwnedAvdSerialAsync('stim-mine'), 100);
    expect(outcome).toEqual({ settled: true, value: { serial: 'emulator-5556' } });
    expect(aborted).toEqual(['emulator-5554']);
  });

  test('wedged emulators cost one timeout together, not one each', async () => {
    AVD_BY_SERIAL['emulator-5560'] = undefined;
    try {
      const { queried } = stubEmulators(['emulator-5554', 'emulator-5560']);
      const outcome = await settlesWithin(resolveOwnedAvdSerialAsync('stim-mine'), CONSOLE_TIMEOUT_MS);
      expect(outcome).toEqual({ settled: true, value: { notRunning: true } });
      expect(queried).toEqual(['emulator-5554', 'emulator-5560']);
    } finally {
      delete AVD_BY_SERIAL['emulator-5560'];
    }
  });

  test('a cancelled read is asked again when a later AVD needs it', async () => {
    AVD_BY_SERIAL['emulator-5554'] = 'stim-b';
    const hung = new Set(['emulator-5554']);
    const queried: string[] = [];
    setExecutor(
      makeExecutor({
        runFile: (file, args = []) => {
          const cmd = [file, ...args].join(' ');
          if (cmd === 'emulator -list-avds') return 'stim-mine\nstim-b\n';
          if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n';
          return '';
        },
        runFileQuietAsync: async (file, args = [], opts) => {
          const serial = /adb -s (\S+) emu avd name/.exec([file, ...args].join(' '))?.[1];
          if (!serial) return null;
          queried.push(serial);
          if (hung.has(serial)) {
            return new Promise<string | null>((_resolve, reject) =>
              opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason)),
            );
          }
          return `${AVD_BY_SERIAL[serial]}\nOK`;
        },
      }),
    );
    try {
      const resolve = ownedAvdSerialResolverAsync({ timeoutMs: 600_000 });
      expect(await settlesWithin(resolve('stim-mine'), 100)).toEqual({
        settled: true,
        value: { serial: 'emulator-5556' },
      });
      hung.clear();
      expect(await settlesWithin(resolve('stim-b'), 100)).toEqual({
        settled: true,
        value: { serial: 'emulator-5554' },
      });
      expect(queried.filter((serial) => serial === 'emulator-5554')).toHaveLength(2);
    } finally {
      AVD_BY_SERIAL['emulator-5554'] = undefined;
    }
  });
});

describe.skipIf(process.platform === 'win32')('zombie emulator processes (ps stat is POSIX; skipped on win32)', () => {
  test.each([
    ['Z', false],
    ['S', true],
    [null, true],
  ])('assertOwnedAvdStopped treats a %s lock holder as live: %s', (stat, live) => {
    setExecutor(
      makeExecutor({
        runFileQuiet: (file, args = []) =>
          file === 'ps' && args.includes(String(process.pid)) && stat ? `${stat}\n` : null,
      }),
    );
    let refused = false;
    try {
      assertOwnedAvdStopped('stim-app', {
        listProcesses: () => [],
        resolveDirectory: () => '/avds/stim-app.avd',
        readProcessId: () => process.pid,
      });
    } catch (error) {
      refused = /still has a live emulator process/.test(String(error));
    }
    expect(refused).toBe(live);
  });
});

test('waitForAndroidEmulatorShutdown on win32 waits for the crashpad handler qemu left behind, then kills a stuck one', async () => {
  const alive = new Map<number, number>([
    [123, 1],
    [456, 3],
    [789, Number.POSITIVE_INFINITY],
  ]);
  let clock = 0;
  const killed: number[] = [];
  const queried: number[] = [];

  await waitForAndroidEmulatorShutdown('stim-app', () => {}, {
    listProcesses: () => [],
    platform: 'win32',
    pollMs: 1000,
    resolveDirectory: () => 'C:\\avds\\stim-app.avd',
    readProcessId: () => 123,
    processAlive: (pid) => (alive.get(pid) ?? 0) > clock,
    directoryExists: () => true,
    crashHandlerPids: (qemuPid) => {
      queried.push(qemuPid);
      return [456, 789];
    },
    killCrashHandler: (pid) => {
      killed.push(pid);
      alive.set(pid, clock);
    },
    now: () => clock * 1000,
    sleep: (ms) => {
      clock += ms / 1000;
    },
  });

  expect(queried).toEqual([123]);
  expect(killed).toEqual([789]);
  expect(clock).toBe(1 + 15);
});

test('waitForAndroidEmulatorShutdown reads Android emulator lock PIDs on Unix and Windows', async () => {
  const avdDirectory = join(tmpHome, 'stim-app.avd');
  for (const [platform, lockPath] of [
    ['darwin', join(avdDirectory, 'hardware-qemu.ini.lock')],
    ['win32', join(avdDirectory, 'hardware-qemu.ini.lock', 'pid')],
  ] as const) {
    rmSync(avdDirectory, { recursive: true, force: true });
    mkdirSync(join(lockPath, '..'), { recursive: true });
    writeFileSync(lockPath, '412503\0');
    let observedPid: number | null = null;

    await waitForAndroidEmulatorShutdown('stim-app', () => {}, {
      listProcesses: () => [],
      platform,
      resolveDirectory: () => avdDirectory,
      processAlive: (pid) => {
        observedPid = pid;
        return false;
      },
    });

    expect(observedPid).toBe(412503);
  }
});

describe('owned AVD stop verification when the process table read is slow under load', () => {
  const posixOnly = process.platform === 'win32';

  function psReads(results: Array<string | Error>) {
    const timeouts: Array<number | undefined> = [];
    setExecutor({
      runFileAsync: async (_file, _args, opts) => {
        timeouts.push(opts?.timeoutMs);
        const next = results[Math.min(timeouts.length, results.length) - 1] ?? '';
        if (next instanceof Error) throw next;
        return next;
      },
    });
    return timeouts;
  }

  test.skipIf(posixOnly)('assertOwnedAvdStoppedAsync refuses after two failed reads of the table', async () => {
    const timeouts = psReads([new Error('timed out')]);

    await expect(assertOwnedAvdStoppedAsync('stim-app', testContext(), () => '/avds/stim-app.avd')).rejects.toThrow(
      /Could not read the process table/,
    );
    expect(timeouts).toEqual([5000, 15_000]);
  });

  test.skipIf(posixOnly)('assertOwnedAvdStoppedAsync stops retrying when the operation is cancelled', async () => {
    const controller = new AbortController();
    let reads = 0;
    setExecutor({
      runFileAsync: async () => {
        reads += 1;
        controller.abort(new Error('cancelled'));
        throw new Error('timed out');
      },
    });

    await expect(
      assertOwnedAvdStoppedAsync('stim-app', testContext({ signal: controller.signal }), () => '/avds/stim-app.avd'),
    ).rejects.toThrow('cancelled');
    expect(reads).toBe(1);
  });
});

describe('waitForAndroidEmulatorShutdown when the console kill has no effect', () => {
  function hungEmulator({
    pids,
    identity = () => 'same',
    captured = () => true,
    dies = ['SIGKILL'],
  }: {
    pids: number[];
    identity?: (pid: number) => 'same' | 'different';
    captured?: (pid: number) => boolean;
    dies?: NodeJS.Signals[];
  }) {
    let clock = 0;
    const alive = new Set(pids);
    const signals: string[] = [];
    const options = {
      timeoutMs: 60_000,
      platform: 'darwin' as const,
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => pids[0] ?? null,
      processAlive: (pid: number) => alive.has(pid),
      listProcesses: () => [...alive],
      captureIdentity: (pid: number) =>
        captured(pid) ? { ok: true as const, token: `token-${pid}` } : { ok: false as const, reason: 'EPERM' },
      inspectIdentity: (record: { pid?: unknown } | null | undefined): 'same' | 'different' | 'gone' =>
        alive.has(record?.pid as number) ? identity(record?.pid as number) : 'gone',
      signal: (pid: number, name: NodeJS.Signals) => {
        signals.push(`${name}:${pid}@${clock}`);
        if (dies.includes(name)) alive.delete(pid);
      },
      directoryExists: () => true,
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;
      },
    };
    return { options, signals, alive };
  }

  test('cancellation after console shutdown prevents process-signal escalation', async () => {
    const { options, signals, alive } = hungEmulator({ pids: [4242] });
    const controller = new AbortController();
    const reason = new Error('cancel shutdown wait');
    const operation = testContext({ signal: controller.signal });
    await expect(
      waitForAndroidEmulatorShutdown('stim-app', () => controller.abort(reason), { ...options, operation }),
    ).rejects.toBe(reason);
    expect(signals).toEqual([]);
    expect(alive.has(4242)).toBe(true);
  });

  test('gives an emulator adb cannot reach the whole timeout to exit on SIGTERM before SIGKILL', async () => {
    const { options, signals, alive } = hungEmulator({ pids: [4242] });

    await waitForAndroidEmulatorShutdown('stim-app', null, options);

    expect(signals).toEqual(['SIGTERM:4242@0', 'SIGKILL:4242@60000']);
    expect(alive.size).toBe(0);
  });

  test('never signals a pid whose identity changed or could not be captured, and refuses instead', async () => {
    const different = hungEmulator({ pids: [4242], identity: () => 'different' });
    const unverified = hungEmulator({ pids: [4242], captured: () => false });

    for (const { options, signals } of [different, unverified]) {
      await expect(waitForAndroidEmulatorShutdown('stim-app', () => {}, options)).rejects.toThrow(
        /emulator process 4242 is still running \(Stim could not verify the identity of 4242, so it sent no signal\)\.$/,
      );
      expect(signals).toEqual([]);
    }
  });
});

test('cancellation during the guest flush prevents the emulator kill command', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel guest flush');
  const calls: string[] = [];
  const run = (file: string, args: string[] = []) => {
    calls.push([file, ...args].join(' '));
    controller.abort(reason);
    return '';
  };
  setExecutor({ runFile: run, runFileQuiet: run });
  await expect(
    shutdownAndroidEmulator('emulator-5554', 60000, testContext({ signal: controller.signal })),
  ).rejects.toBe(reason);
  expect(calls).toEqual(['adb -s emulator-5554 shell sync']);
});

test('shutdownAndroidEmulator warns and still kills the emulator when sync fails', async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  setExecutor({
    runFileQuiet: (file: string, args: string[] = []) => {
      const cmd = [file, ...args].join(' ');
      calls.push(cmd);
      return cmd.includes('shell sync') ? null : '';
    },
  });

  await withAmbientContext(testContext({ output: (_stream, text) => errors.push(text) }), () =>
    shutdownAndroidEmulator('emulator-5554'),
  );

  expect(calls).toEqual(['adb -s emulator-5554 shell sync', 'adb -s emulator-5554 emu kill']);
  expect(errors).toEqual(['warning: could not flush emulator-5554 before shutdown; shutting it down anyway\n']);
});

test('waitForBoot keeps waiting after the boot properties until the package manager answers', async () => {
  const calls: string[] = [];
  let pmAnswers = 0;
  setExecutor({
    run: () => '',
    runFileQuiet: (file: string, args: string[] = []) => {
      const cmd = [file, ...args].join(' ');
      calls.push(cmd);
      if (/getprop sys\.boot_completed/.test(cmd)) return '1';
      if (/shell pm path android/.test(cmd))
        return ++pmAnswers >= 3 ? 'package:/system/framework/framework-res.apk' : null;
      return null;
    },
    spawn: () => null,
  });
  const booting = waitForBoot('emulator-5554', 5000, { pollMs: 1 });
  await vi.runAllTimersAsync();
  const result = await booting;
  expect(result).toEqual({ ok: true });
  expect(calls.filter((cmd) => /shell pm path android/.test(cmd))).toHaveLength(3);
  expect(calls.filter((cmd) => /getprop/.test(cmd)).length).toBeGreaterThanOrEqual(3);
});

test.each([25, 2000])('boot timeout retains diagnostics within a separate budget (query cost %sms)', async (costMs) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const calls: { cmd: string; at: number; timeoutMs: number }[] = [];
  setExecutor({
    runFileQuiet: (file: string, args: string[] = [], opts) => {
      const cmd = [file, ...args].join(' ');
      const at = Date.now();
      const timeoutMs = opts?.timeoutMs ?? Infinity;
      calls.push({ cmd, at, timeoutMs });
      vi.setSystemTime(at + Math.min(costMs, timeoutMs));
      if (costMs > timeoutMs) return null;
      if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\toffline\n';
      if (cmd.includes('pm path android')) return null;
      return cmd.includes('init.svc.bootanim') ? 'running\n' : '0\n';
    },
  });
  try {
    const pending = waitForBoot('emulator-5554', 10, { commandTimeoutMs: 5000 });
    await vi.runAllTimersAsync();
    const result = await pending;
    const diagnostics = calls.filter(({ at }) => at >= 11);
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toEqual({
      devices: 'List of devices attached\nemulator-5554\toffline',
      sysBoot: '0',
      devBoot: costMs === 25 ? '0' : '',
      bootAnim: costMs === 25 ? 'running' : '',
      packageManager: '',
    });
    expect(diagnostics[0]).toEqual({ cmd: 'adb devices', at: 11, timeoutMs: 5000 });
    expect(diagnostics.map(({ timeoutMs }) => timeoutMs)).toEqual(
      costMs === 25 ? [5000, 4975, 4950, 4925, 4900] : [5000, 3000, 1000],
    );
    expect(Date.now() - diagnostics[0]!.at).toBeLessThanOrEqual(5000);
  } finally {
    vi.clearAllTimers();
  }
});

test('bootAndroidEmulator starts the emulator tree from the home directory on Windows so its launcher and crashpad handler never hold a worktree open', async () => {
  const sdk = makeFakeSdk(tmpHome);
  process.env.ANDROID_HOME = sdk;
  const cwds: unknown[] = [];
  const args: string[][] = [];
  setExecutor({
    runFile: () => '',
    runFileQuiet: (_file: string, fileArgs: string[]) =>
      fileArgs[0] === '-version' ? 'Android emulator version 37.1.11.0 (build_id 1)' : null,
    spawn: (_cmd: string, spawnArgs: string[], opts: { cwd?: string }) => {
      cwds.push(opts.cwd);
      args.push(spawnArgs);
      return { unref: () => {}, pid: 42 };
    },
  });
  expect(await bootAndroidEmulator('stim-app', 5556, { platform: 'win32' })).toBe(42);
  await bootAndroidEmulator('stim-app', 5556, { platform: 'darwin' });
  await bootAndroidEmulator('stim-app', 5556, { platform: 'linux' });
  expect(cwds).toEqual([homedir(), undefined, undefined]);
  expect(args[0]?.slice(0, 4)).toEqual(['-avd', 'stim-app', '-port', '5556']);
  expect(args[0]?.slice(-2)).toEqual(['-crash-report-mode', 'never']);
  expect(args[1]).not.toContain('-crash-report-mode');
  expect(args[2]).not.toContain('-crash-report-mode');
});

test('parseDfAvailableBytes reads the free bytes of /data from toybox df -k', () => {
  expect(
    parseDfAvailableBytes(
      'Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/block/dm-5  5980136 2170152   3793600  37% /data\n',
    ),
  ).toBe(3793600 * 1024);
  expect(parseDfAvailableBytes('df: /data: Permission denied')).toBe(null);
  expect(parseDfAvailableBytes('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/a 1 1 - 1% /data')).toBe(
    null,
  );
});

test('bootAndroidEmulator still boots when the log file cannot be opened', async () => {
  const spawned: Array<Record<string, unknown>> = [];
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn: (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      spawned.push(opts);
      return { unref: () => {} };
    },
  });
  const blocker = join(tmpHome, 'blocker');
  writeFileSync(blocker, '');
  await bootAndroidEmulator('stim-app', 5556, { logFile: join(blocker, 'emulator.log'), platform: 'linux' });
  expect(spawned.length).toBe(1);
  expect(spawned[0]?.stdio).toBe('ignore');
});

test('resolvePhysicalDevice refuses an ambiguous choice and names every candidate', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n0123456789ABCDEF\tdevice\n`);
  const result = resolvePhysicalDevice(null, adb, () => false);
  expect(result.serial).toBeUndefined();
  expect(result.error).toContain('RFCR7081Q9L');
  expect(result.error).toContain('0123456789ABCDEF');
  expect(result.remedy).toMatch(/--device <serial>/);
});

test('resolvePhysicalDevice reports an unauthorized device instead of calling it absent', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tunauthorized\n`);
  const result = resolvePhysicalDevice(null, adb, () => false);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/RFCR7081Q9L is connected but unauthorized/);
  expect(result.remedy).toMatch(/USB debugging/);
});

test('resolvePhysicalDevice reports an offline requested device instead of calling it absent', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\toffline\n`);
  const result = resolvePhysicalDevice('RFCR7081Q9L', adb, () => false);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/RFCR7081Q9L is connected but offline/);
});

test('resolvePhysicalDevice accepts a genuine device over adb-over-TCP', () => {
  const adb = parseAdbDevices(`List of devices attached\n192.168.1.5:5555\tdevice\n`);
  expect(resolvePhysicalDevice(null, adb, () => false)).toEqual({ serial: '192.168.1.5:5555' });
});
