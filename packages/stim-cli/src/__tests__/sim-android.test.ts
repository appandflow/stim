import { withAmbientContext } from '@stim-cli/core';
import { testContext } from './_context.ts';
import assert from 'node:assert';
import {
  existsSync,
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
  MAX_EMULATOR_FAILURE_LINES,
  androidDeviceAbi,
  androidSystemImageAbi,
  androidToolPath,
  androidPoolNoCandidatesRefusal,
  buildToolsMajor,
  emulatorFailureRemedy,
  extractEmulatorFailure,
  findBuildTool,
  headlessEmulatorArgs,
  bootAndroidEmulator,
  listAdbDevices,
  configureNewOwnedAvd,
  listAvds,
  memoizeEmulatorProbe,
  parseAvdList,
  parseAdbDevices,
  removeOwnedEmulatorMetroReverses,
  nextConsolePort,
  parseAvdRootIni,
  pickDefaultSystemImage,
  hostSystemImageArch,
  ownedAvdDirectory,
  ownedAvdSystemImage,
  parseAvdSystemImage,
  deleteAvd,
  resolveOwnedAvdSerial,
  resolveOwnedAvdSerialAsync,
  ownedAvdSerialResolver,
  ownedAvdSerialResolverAsync,
  shutdownAndroidEmulator,
  physicalDeviceModel,
  resolvePhysicalDevice,
  assertOwnedAvdStopped,
  assertOwnedAvdStoppedAsync,
  parseAvdEmulatorProcesses,
  parseEmulatorVersion,
  parseDfAvailableBytes,
  suppressEmulatorCrashConsent,
  waitForAndroidEmulatorShutdown,
  waitForBoot,
  withAvdConfigOverrides,
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

test('parseAvdList strips header and blanks', () => {
  const out = `INFO    | Storing AVDs in...\nPixel_6_API_34\nPixel_7_API_33\n`;
  const avds = parseAvdList(out);
  expect(avds).toEqual(['Pixel_6_API_34', 'Pixel_7_API_33']);
});

test('parseAdbDevices extracts running emulator console ports and physical devices', () => {
  const out = `List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n0123456789ABCDEF\tdevice\n`;
  const result = parseAdbDevices(out);
  expect(result.emulators.toSorted((a, b) => a.consolePort - b.consolePort)).toEqual([
    { serial: 'emulator-5554', consolePort: 5554 },
    { serial: 'emulator-5556', consolePort: 5556 },
  ]);
  expect(result.physical).toEqual([{ serial: '0123456789ABCDEF' }]);
});

test.each([
  [
    'stim-app',
    [
      ['-s', 'emulator-5556', 'reverse', '--list'],
      ['-s', 'emulator-5556', 'reverse', '--remove', 'tcp:8082'],
      ['-s', 'emulator-5556', 'reverse', '--remove', 'tcp:8081'],
    ],
  ],
  ['someone-else', []],
])(
  'removeOwnedEmulatorMetroReverses removes only reverses to the Metro port, and only when the console names the AVD (%s)',
  async (consoleAvd, expected) => {
    const adbCalls: string[][] = [];
    setExecutor(
      makeExecutor({
        runFileQuietAsync: async (_file, args) => {
          if (args.includes('emu')) return `${consoleAvd}\nOK\n`;
          adbCalls.push(args);
          return args.includes('--list')
            ? 'host-21 tcp:8082 tcp:8082\nhost-21 tcp:8081 tcp:8082\nhost-21 tcp:9000 tcp:9000\nhost-21 localabstract:x tcp:8082\n'
            : '';
        },
      }),
    );
    await removeOwnedEmulatorMetroReverses('stim-app', 'emulator-5556', 8082);
    expect(adbCalls).toEqual(expected);
  },
);

test('parseAdbDevices recognizes adb-over-TCP physical devices', () => {
  const out = `List of devices attached\n192.168.1.5:5555\tdevice\n`;
  const result = parseAdbDevices(out);
  expect(result.physical).toEqual([{ serial: '192.168.1.5:5555' }]);
  expect(result.emulators).toEqual([]);
});

test('parseAdbDevices ignores offline emulators but reports them in unhealthy', () => {
  const out = `List of devices attached\nemulator-5554\toffline\nemulator-5556\tdevice\n`;
  const result = parseAdbDevices(out);
  expect(result.emulators).toEqual([{ serial: 'emulator-5556', consolePort: 5556 }]);
  expect(result.unhealthy).toEqual([
    { serial: 'emulator-5554', kind: 'emulator', consolePort: 5554, status: 'offline' },
  ]);
});

test('parseAdbDevices surfaces unauthorized emulators in unhealthy', () => {
  const out = `List of devices attached\nemulator-5554\tunauthorized\n`;
  const result = parseAdbDevices(out);
  expect(result.emulators).toEqual([]);
  expect(result.unhealthy).toEqual([
    { serial: 'emulator-5554', kind: 'emulator', consolePort: 5554, status: 'unauthorized' },
  ]);
});

test('parseAdbDevices surfaces unauthorized physical devices in unhealthy', () => {
  const out = `List of devices attached\nR5CR70ABCDE\tunauthorized\n`;
  const result = parseAdbDevices(out);
  expect(result.physical).toEqual([]);
  expect(result.unhealthy).toEqual([{ serial: 'R5CR70ABCDE', kind: 'physical', status: 'unauthorized' }]);
});

test('nextConsolePort returns 5554 when none claimed', () => {
  expect(nextConsolePort([])).toBe(5554);
});

test('nextConsolePort returns next even port above max claimed', () => {
  expect(nextConsolePort([5554, 5556])).toBe(5558);
});

test('headlessEmulatorArgs is headless on displayless linux only', () => {
  expect(headlessEmulatorArgs({}, 'linux')).toEqual([
    '-no-window',
    '-noaudio',
    '-no-boot-anim',
    '-gpu',
    'swiftshader_indirect',
    '-no-snapshot-save',
    '-no-snapshot-load',
  ]);
  expect(headlessEmulatorArgs({ DISPLAY: ':0' }, 'linux')).toEqual([]);
  expect(headlessEmulatorArgs({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toEqual([]);
  expect(headlessEmulatorArgs({}, 'darwin')).toEqual([]);
});

test('parseAvdRootIni keeps the content paths and ignores unrelated lines', () => {
  expect(
    parseAvdRootIni(
      'avd.ini.encoding=UTF-8\npath = /moved/stim-app.avd\npath.rel=avd/stim-app.avd\ntarget=android-36\n',
    ),
  ).toEqual({ path: '/moved/stim-app.avd', relativePath: 'avd/stim-app.avd' });
});

function writeAvdRoot(root: string, name: string, contents: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${name}.ini`), contents);
}

test('ownedAvdDirectory uses AVD_HOME, SDK_HOME, then HOME precedence', () => {
  const avdHome = join(tmpHome, 'avd-home');
  const sdkHome = join(tmpHome, 'android-sdk-home');
  const home = join(tmpHome, 'home');
  const candidates: [string, string, string] = [
    join(tmpHome, 'custom.avd'),
    join(tmpHome, 'user.avd'),
    join(tmpHome, 'default.avd'),
  ];
  for (const candidate of candidates) mkdirSync(candidate, { recursive: true });
  writeAvdRoot(avdHome, 'stim-app', `path=${candidates[0]}\n`);
  writeAvdRoot(join(sdkHome, 'avd'), 'stim-app', `path=${candidates[1]}\n`);
  writeAvdRoot(join(home, '.android', 'avd'), 'stim-app', `path=${candidates[2]}\n`);

  expect(ownedAvdDirectory('stim-app', { env: { ANDROID_AVD_HOME: avdHome, ANDROID_SDK_HOME: sdkHome }, home })).toBe(
    realpathSync(candidates[0]),
  );
  expect(ownedAvdDirectory('stim-app', { env: { ANDROID_SDK_HOME: sdkHome }, home })).toBe(realpathSync(candidates[1]));
  expect(ownedAvdDirectory('stim-app', { env: {}, home })).toBe(realpathSync(candidates[2]));
});

test('extra registration roots cannot override the emulator directory selected by the operational lookup', () => {
  const sdkHome = join(tmpHome, 'sdk-home');
  const userHome = join(tmpHome, 'user-home');
  const emulatorHome = join(tmpHome, 'emulator-home');
  const home = join(tmpHome, 'home');
  const selected = join(tmpHome, 'selected.avd');
  const extra = join(tmpHome, 'extra.avd');
  mkdirSync(selected, { recursive: true });
  mkdirSync(extra, { recursive: true });
  writeAvdRoot(join(sdkHome, 'avd'), 'stim-app', `path=${selected}\n`);
  for (const root of [join(userHome, 'avd'), join(emulatorHome, 'avd'), join(sdkHome, '.android', 'avd')]) {
    writeAvdRoot(root, 'stim-app', `path=${extra}\n`);
  }
  expect(
    ownedAvdDirectory('stim-app', {
      env: { ANDROID_SDK_HOME: sdkHome, ANDROID_USER_HOME: userHome, ANDROID_EMULATOR_HOME: emulatorHome },
      home,
    }),
  ).toBe(realpathSync(selected));
});

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

test('ownedAvdDirectory returns null when every emulator root is missing and ignores USER_HOME', () => {
  const userHome = join(tmpHome, 'android-user-home');
  const content = join(tmpHome, 'unsupported-user-home.avd');
  mkdirSync(content, { recursive: true });
  writeAvdRoot(join(userHome, 'avd'), 'stim-app', `path=${content}\n`);

  expect(
    ownedAvdDirectory('stim-app', {
      env: {
        ANDROID_AVD_HOME: join(tmpHome, 'missing-avd-home'),
        ANDROID_SDK_HOME: join(tmpHome, 'missing-sdk-home'),
        ANDROID_USER_HOME: userHome,
      },
      home: join(tmpHome, 'missing-home'),
    }),
  ).toBe(null);
});

test('withAvdConfigOverrides keeps CRLF line endings and unrelated config', () => {
  expect(
    withAvdConfigOverrides(
      'hw.cpu.ncore=4\r\ndisk.dataPartition.size=10G\r\ntag.id=google_apis\r\ndisk.dataPartition.size=8G\r\n',
      { 'disk.dataPartition.size': '6442450944' },
    ),
  ).toBe('hw.cpu.ncore=4\r\ndisk.dataPartition.size=6442450944\r\ntag.id=google_apis\r\n');
});

test('withAvdConfigOverrides appends a missing value without changing newline termination', () => {
  expect(withAvdConfigOverrides('hw.cpu.ncore=4', { 'disk.dataPartition.size': '8589934592' })).toBe(
    'hw.cpu.ncore=4\ndisk.dataPartition.size=8589934592',
  );
});

test('withAvdConfigOverrides replaces duplicates once and preserves protected generated values', () => {
  expect(
    withAvdConfigOverrides(
      'image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\nhw.keyboard=no\nhw.keyboard=no\n',
      { 'hw.keyboard': 'yes', 'hw.ramSize': '3072' },
    ),
  ).toBe('image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\nhw.keyboard=yes\nhw.ramSize=3072\n');
});

test('configureNewOwnedAvd atomically writes and verifies managed and user settings', () => {
  const content = join(tmpHome, 'stim-app.avd');
  mkdirSync(content, { recursive: true });
  const config = join(content, 'config.ini');
  writeFileSync(config, 'hw.cpu.ncore=4\ndisk.dataPartition.size=10G\n');

  expect(
    configureNewOwnedAvd(
      'stim-app',
      { dataPartitionSizeGb: 6, avdConfig: { 'hw.keyboard': 'yes', 'hw.ramSize': '3072' } },
      { avdDirectory: () => content },
    ),
  ).toBe(config);
  expect(readFileSync(config, 'utf8')).toBe(
    'hw.cpu.ncore=4\ndisk.dataPartition.size=6442450944\nhw.keyboard=yes\nhw.ramSize=3072\n',
  );
  expect(readdirSync(content).filter((name) => name.includes('.stim-'))).toEqual([]);
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

test('pickDefaultSystemImage prefers highest api, then google_apis, arm64 only', () => {
  const images = [
    { api: 35, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-35;default;arm64-v8a' },
    { api: 36, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-36;default;arm64-v8a' },
    { api: 36, tag: 'google_apis', arch: 'arm64-v8a', pkg: 'system-images;android-36;google_apis;arm64-v8a' },
    { api: 36, tag: 'google_apis', arch: 'x86_64', pkg: 'system-images;android-36;google_apis;x86_64' },
  ];
  const picked = pickDefaultSystemImage(images, { hostArch: 'arm64-v8a' });
  assert(picked);
  expect(picked.pkg).toBe('system-images;android-36;google_apis;arm64-v8a');
});

test('pickDefaultSystemImage ranks a 16KB-page image below a plain one, api or no api', () => {
  const ps16k = {
    api: 36,
    tag: 'google_apis_playstore_ps16k',
    arch: 'arm64-v8a',
    pkg: 'system-images;android-36;google_apis_playstore_ps16k;arm64-v8a',
  };
  const plain = {
    api: 35,
    tag: 'google_apis',
    arch: 'arm64-v8a',
    pkg: 'system-images;android-35;google_apis;arm64-v8a',
  };
  const bothA = pickDefaultSystemImage([ps16k, plain], { hostArch: 'arm64-v8a' });
  assert(bothA);
  expect(bothA.pkg).toBe(plain.pkg);
  const bothB = pickDefaultSystemImage([plain, ps16k], { hostArch: 'arm64-v8a' });
  assert(bothB);
  expect(bothB.pkg).toBe(plain.pkg);
  const only16k = pickDefaultSystemImage([ps16k], { hostArch: 'arm64-v8a' });
  assert(only16k);
  expect(only16k.pkg).toBe(ps16k.pkg);
  const explicit = pickDefaultSystemImage([ps16k, plain], { systemImage: ps16k.pkg });
  assert(explicit);
  expect(explicit.pkg).toBe(ps16k.pkg);
});

test('pickDefaultSystemImage matches the host architecture by default', () => {
  const arm = { pkg: 'system-images;android-34;google_apis;arm64-v8a', api: 34, tag: 'google_apis', arch: 'arm64-v8a' };
  const x64 = { pkg: 'system-images;android-34;google_apis;x86_64', api: 34, tag: 'google_apis', arch: 'x86_64' };
  expect(pickDefaultSystemImage([arm, x64], { hostArch: 'x86_64' })).toBe(x64);
  expect(pickDefaultSystemImage([arm, x64], { hostArch: 'arm64-v8a' })).toBe(arm);
  expect(hostSystemImageArch('arm64')).toBe('arm64-v8a');
  expect(hostSystemImageArch('x64')).toBe('x86_64');
});

test('pickDefaultSystemImage honors an explicit package and returns null on no match', () => {
  const images = [{ api: 36, tag: 'default', arch: 'arm64-v8a', pkg: 'system-images;android-36;default;arm64-v8a' }];
  const first = images[0];
  assert(first);
  const honored = pickDefaultSystemImage(images, { systemImage: first.pkg });
  assert(honored);
  expect(honored.pkg).toBe(first.pkg);
  expect(pickDefaultSystemImage([], {})).toBe(null);
  expect(pickDefaultSystemImage(images, { systemImage: 'system-images;android-99;x;y' })).toBe(null);
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

test('deleteAvd deletes a Stim-owned AVD', async () => {
  let ran = null;
  setExecutor({
    runFile: (_file, args) => {
      ran = args;
      return '';
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  await deleteAvd('stim-my-project');
  expect(ran).toEqual(['delete', 'avd', '-n', 'stim-my-project']);
});

test('deleteAvd propagates an avdmanager failure instead of swallowing it', async () => {
  setExecutor({
    runFile: () => {
      throw new Error('avdmanager: could not delete');
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  await expect(deleteAvd('stim-my-project')).rejects.toThrow(/could not delete/);
});

const AVD_SERIAL_RESOLVERS = [
  ['sync', async (avdName: string, opts?: { timeoutMs?: number }) => resolveOwnedAvdSerial(avdName, opts)],
  ['async', resolveOwnedAvdSerialAsync],
] as const;

test.each(AVD_SERIAL_RESOLVERS)(
  'resolveOwnedAvdSerial (%s) reports missing when the AVD does not exist at all',
  async (_kind, resolve) => {
    setExecutor({
      runFile: () => '',
      runQuiet: () => null,
      spawn: () => null,
    });
    expect(await resolve('stim-gone')).toEqual({ missing: true });
  },
);

test.each(AVD_SERIAL_RESOLVERS)(
  'resolveOwnedAvdSerial (%s) reports notOwned for a non-Stim AVD name',
  async (_kind, resolve) => {
    setExecutor({
      runFile: (_file, args = []) => (args[0] === '-list-avds' ? 'Pixel_6_API_34\n' : ''),
      runQuiet: () => null,
      spawn: () => null,
    });
    expect(await resolve('Pixel_6_API_34')).toEqual({ notOwned: true });
  },
);

test('listAdbDevices runs the adb client from the home directory on Windows so an auto-started server never holds a worktree open', () => {
  const calls: { cmd: string; cwd: unknown }[] = [];
  setExecutor({
    runFile: (file, args = [], opts) => {
      const cmd = [file, ...args].join(' ');
      calls.push({ cmd, cwd: opts?.cwd });
      return 'List of devices attached\nemulator-5554\tdevice\n';
    },
  });
  expect(listAdbDevices({ timeoutMs: 1000, platform: 'win32' }).emulators).toEqual([
    { serial: 'emulator-5554', consolePort: 5554 },
  ]);
  listAdbDevices({ platform: 'darwin' });
  listAdbDevices({ platform: 'linux' });
  expect(calls).toEqual([
    { cmd: 'adb devices', cwd: homedir() },
    { cmd: 'adb devices', cwd: undefined },
    { cmd: 'adb devices', cwd: undefined },
  ]);
});

test.each(AVD_SERIAL_RESOLVERS)(
  'resolveOwnedAvdSerial (%s) resolves the live serial by AVD identity, not by port',
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
        if (/adb -s emulator-5554 emu avd name/.test(cmd)) return 'stim-mine\nOK';
        return null;
      },
      spawn: () => null,
    });
    expect(await resolve('stim-mine')).toEqual({ serial: 'emulator-5554' });
  },
);

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

test.each(AVD_SERIAL_RESOLVERS)(
  'resolveOwnedAvdSerial (%s) resolves an offline emulator through its console identity',
  async (_kind, resolve) => {
    setExecutor({
      runFile: (file, args = []) => {
        const cmd = [file, ...args].join(' ');
        if (cmd === 'emulator -list-avds') return 'stim-mine\n';
        if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\toffline\n';
        return '';
      },
      runFileQuiet: (file: string, args: string[] = []) =>
        /adb -s emulator-5554 emu avd name/.test([file, ...args].join(' ')) ? 'stim-mine\nOK' : null,
      spawn: () => null,
    });

    expect(await resolve('stim-mine')).toEqual({ serial: 'emulator-5554' });
  },
);

test.each(AVD_SERIAL_RESOLVERS)(
  'resolveOwnedAvdSerial (%s) asks healthy emulators first and bounds every console identity query',
  async (_kind, resolve) => {
    const queried: { serial: string; timeoutMs?: number; killSignal?: string }[] = [];
    setExecutor({
      runFile: (file, args = []) => {
        const cmd = [file, ...args].join(' ');
        if (cmd === 'emulator -list-avds') return 'stim-mine\nstim-stopped\n';
        if (cmd === 'adb devices') return 'List of devices attached\nemulator-5556\toffline\nemulator-5554\tdevice\n';
        return '';
      },
      runFileQuiet: (file: string, args: string[] = [], opts) => {
        const cmd = [file, ...args].join(' ');
        const serial = /adb -s (\S+) emu avd name/.exec(cmd)?.[1];
        if (!serial) return null;
        queried.push({ serial, timeoutMs: opts?.timeoutMs, killSignal: opts?.killSignal });
        return serial === 'emulator-5554' ? 'stim-mine\nOK' : null;
      },
    });

    expect(await resolve('stim-mine')).toEqual({ serial: 'emulator-5554' });
    expect(queried.map((q) => q.serial)).toEqual(['emulator-5554']);

    expect(await resolve('stim-stopped', { timeoutMs: 600_000 })).toEqual({ notRunning: true });
    expect(queried.map((q) => q.serial)).toEqual(['emulator-5554', 'emulator-5554', 'emulator-5556']);
    for (const query of queried) {
      expect(query.killSignal).toBe('SIGKILL');
      expect(query.timeoutMs).toBeGreaterThan(0);
      expect(query.timeoutMs).toBeLessThanOrEqual(10_000);
    }
  },
);

test.each(AVD_SERIAL_RESOLVERS)(
  'resolveOwnedAvdSerial (%s) floors each console query so a slow earlier call does not starve a later one to an unusable timeout',
  async (_kind, resolve) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const queried: { cmd: string; at: number; timeoutMs?: number }[] = [];
    setExecutor({
      runFile: (file: string, args: string[] = [], opts?: { timeoutMs?: number }) => {
        const cmd = [file, ...args].join(' ');
        const at = Date.now();
        queried.push({ cmd, at, timeoutMs: opts?.timeoutMs });
        if (cmd === 'emulator -list-avds') {
          vi.setSystemTime(at + 4990);
          return 'stim-mine\n';
        }
        if (cmd === 'adb devices') {
          vi.setSystemTime(at + 9);
          return 'List of devices attached\nemulator-5554\tdevice\n';
        }
        return '';
      },
      runFileQuiet: (file: string, args: string[] = [], opts?: { timeoutMs?: number }) => {
        const cmd = [file, ...args].join(' ');
        const serial = /adb -s (\S+) emu avd name/.exec(cmd)?.[1];
        if (!serial) return null;
        queried.push({ cmd, at: Date.now(), timeoutMs: opts?.timeoutMs });
        return 'stim-mine\nOK';
      },
    });
    try {
      expect(await resolve('stim-mine', { timeoutMs: 5000 })).toEqual({ serial: 'emulator-5554' });
      const nameQuery = queried.find((q) => q.cmd.includes('emu avd name'));
      expect(nameQuery?.timeoutMs).toBeGreaterThanOrEqual(1000);
    } finally {
      vi.useRealTimers();
    }
  },
);

test('resolveOwnedAvdSerial caches a failed console query per serial so one resolver does not retry a wedged emulator for every requested AVD', () => {
  const queried: string[] = [];
  setExecutor({
    runFile: (file: string, args: string[] = []) => {
      const cmd = [file, ...args].join(' ');
      if (cmd === 'emulator -list-avds') return 'stim-a\nstim-b\n';
      if (cmd === 'adb devices') return 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n';
      return '';
    },
    runFileQuiet: (file: string, args: string[] = []) => {
      const cmd = [file, ...args].join(' ');
      const serial = /adb -s (\S+) emu avd name/.exec(cmd)?.[1];
      if (!serial) return null;
      queried.push(serial);
      return serial === 'emulator-5556' ? 'stim-b\nOK' : null;
    },
  });
  const resolve = ownedAvdSerialResolver({ timeoutMs: 5000 });
  expect(resolve('stim-a')).toEqual({ notRunning: true });
  expect(resolve('stim-b')).toEqual({ serial: 'emulator-5556' });
  expect(queried.filter((serial) => serial === 'emulator-5554')).toHaveLength(1);
});

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
    vi.useRealTimers();
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

test('assertOwnedAvdStopped rejects a live process and accepts a stale lock', () => {
  expect(() =>
    assertOwnedAvdStopped('stim-app', {
      listProcesses: () => [],
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => 123,
      processAlive: () => true,
    }),
  ).toThrow(/still has a live emulator process/);

  expect(() =>
    assertOwnedAvdStopped('stim-app', {
      listProcesses: () => [],
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => 123,
      processAlive: () => false,
    }),
  ).not.toThrow();
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

test.each([
  { timeoutMs: 12_345, flushMs: 5000, killTimeoutMs: 7345 },
  { timeoutMs: 250, flushMs: 250, killTimeoutMs: 1 },
])(
  'shutdownAndroidEmulator shares a $timeoutMs ms deadline across sync and kill',
  async ({ timeoutMs, flushMs, killTimeoutMs }) => {
    const calls: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(flushMs);
    setExecutor({
      run: () => '',
      runFileQuiet: (file: string, args: string[], options) => {
        calls.push({ argv: [file, ...args], timeoutMs: options?.timeoutMs });
        return '';
      },
      spawn: () => null,
    });

    try {
      await shutdownAndroidEmulator('emulator-5554', timeoutMs);
    } finally {
      now.mockRestore();
    }

    expect(calls).toEqual([
      { argv: ['adb', '-s', 'emulator-5554', 'shell', 'sync'], timeoutMs: Math.min(5000, timeoutMs) },
      { argv: ['adb', '-s', 'emulator-5554', 'emu', 'kill'], timeoutMs: killTimeoutMs },
    ]);
  },
);

test('waitForAndroidEmulatorShutdown waits for the owned AVD process lock to disappear', async () => {
  let locked = true;
  const sleeps: number[] = [];
  const calls: string[] = [];

  await waitForAndroidEmulatorShutdown(
    'stim-app',
    async (timeoutMs) => {
      calls.push(`shutdown:${timeoutMs}`);
    },
    {
      now: () => 0,
      listProcesses: () => [],
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => 123,
      processAlive: () => locked,
      directoryExists: () => true,
      sleep: (ms) => {
        calls.push('wait');
        sleeps.push(ms);
        locked = false;
      },
    },
  );

  expect(sleeps).toEqual([100]);
  expect(calls).toEqual(['shutdown:60000', 'wait']);
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

test('waitForAndroidEmulatorShutdown refuses when a crashpad handler remains alive after termination', async () => {
  let clock = 0;
  await expect(
    waitForAndroidEmulatorShutdown('stim-app', () => {}, {
      listProcesses: () => [],
      platform: 'win32',
      pollMs: 1000,
      resolveDirectory: () => 'C:\\avds\\stim-app.avd',
      readProcessId: () => 123,
      processAlive: (pid) => pid === 456,
      directoryExists: () => true,
      crashHandlerPids: () => [456],
      killCrashHandler: () => {},
      now: () => clock * 1000,
      sleep: (ms) => {
        clock += ms / 1000;
      },
    }),
  ).rejects.toThrow('Crashpad handler 456 for owned AVD stim-app stayed alive.');
});

test('waitForAndroidEmulatorShutdown outside win32 never looks for a crash handler', async () => {
  let queried = false;
  await waitForAndroidEmulatorShutdown('stim-app', () => {}, {
    listProcesses: () => [],
    platform: 'darwin',
    resolveDirectory: () => '/avds/stim-app.avd',
    readProcessId: () => 123,
    processAlive: () => false,
    directoryExists: () => true,
    crashHandlerPids: () => {
      queried = true;
      return [];
    },
  });
  expect(queried).toBe(false);
});

test('waitForAndroidEmulatorShutdown includes the shutdown command in its deadline', async () => {
  let elapsed = 0;
  let commandTimeout = 0;

  await expect(
    waitForAndroidEmulatorShutdown(
      'stim-app',
      (timeoutMs) => {
        commandTimeout = timeoutMs;
        elapsed += 200;
      },
      {
        timeoutMs: 250,
        listProcesses: () => [],
        resolveDirectory: () => '/avds/stim-app.avd',
        readProcessId: () => 123,
        processAlive: () => true,
        directoryExists: () => true,
        now: () => elapsed,
        sleep: (ms) => {
          elapsed += ms;
        },
      },
    ),
  ).rejects.toThrow(/did not finish shutting down after 1s/);
  expect(commandTimeout).toBe(250);
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

test.each(['darwin', 'win32'] as const)(
  'assertOwnedAvdStopped refuses a present invalid %s process lock',
  (platform) => {
    const avdDirectory = join(tmpHome, 'stim-app.avd');
    const lockPath = join(avdDirectory, 'hardware-qemu.ini.lock', ...(platform === 'win32' ? ['pid'] : []));
    mkdirSync(join(lockPath, '..'), { recursive: true });
    const options = { platform, resolveDirectory: () => avdDirectory, listProcesses: () => [] };

    for (const content of ['', 'invalid', '123garbage']) {
      writeFileSync(lockPath, content);
      expect(() => assertOwnedAvdStopped('stim-app', options)).toThrow(/Could not read the emulator PID/);
    }

    rmSync(lockPath);
    expect(() => assertOwnedAvdStopped('stim-app', options)).not.toThrow();
  },
);

test('waitForAndroidEmulatorShutdown prefers the active process lock over the legacy fallback', async () => {
  const paths: string[] = [];
  let observedPid: number | null = null;

  await waitForAndroidEmulatorShutdown('stim-app', () => {}, {
    listProcesses: () => [],
    platform: 'darwin',
    resolveDirectory: () => '/avds/stim-app.avd',
    readProcessId: (path) => {
      paths.push(path);
      return path.endsWith('hardware-qemu.ini.lock') ? 123 : 456;
    },
    processAlive: (pid) => {
      observedPid = pid;
      return false;
    },
    directoryExists: () => true,
  });

  expect(paths).toEqual([join('/avds/stim-app.avd', 'hardware-qemu.ini.lock')]);
  expect(observedPid).toBe(123);
});

test('waitForAndroidEmulatorShutdown falls back to the legacy process lock', async () => {
  const paths: string[] = [];
  let observedPid: number | null = null;

  await waitForAndroidEmulatorShutdown('stim-app', () => {}, {
    listProcesses: () => [],
    platform: 'darwin',
    resolveDirectory: () => '/avds/stim-app.avd',
    readProcessId: (path) => {
      paths.push(path);
      return path.endsWith('userdata-qemu.img.lock') ? 456 : null;
    },
    processAlive: (pid) => {
      observedPid = pid;
      return false;
    },
    directoryExists: () => true,
  });

  expect(paths).toEqual([
    join('/avds/stim-app.avd', 'hardware-qemu.ini.lock'),
    join('/avds/stim-app.avd', 'userdata-qemu.img.lock'),
  ]);
  expect(observedPid).toBe(456);
});

test('waitForAndroidEmulatorShutdown times out while the owned AVD process lock remains', async () => {
  let elapsed = 0;

  await expect(
    waitForAndroidEmulatorShutdown('stim-app', () => {}, {
      listProcesses: () => [],
      timeoutMs: 250,
      pollMs: 100,
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => 123,
      processAlive: () => true,
      directoryExists: () => true,
      now: () => elapsed,
      sleep: (ms) => {
        elapsed += ms;
      },
    }),
  ).rejects.toThrow(/did not finish shutting down after 1s/);
});

test('waitForAndroidEmulatorShutdown refuses to signal a process without an AVD lock', async () => {
  const shutdown = vi.fn<() => void>();

  await expect(
    waitForAndroidEmulatorShutdown('stim-app', shutdown, {
      listProcesses: () => [],
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => null,
      processAlive: () => false,
      directoryExists: () => true,
    }),
  ).rejects.toThrow(/Could not find the emulator process lock/);
  expect(shutdown).not.toHaveBeenCalled();
});

test('parseAvdEmulatorProcesses matches only emulator processes launched for that exact AVD', () => {
  const table = [
    '  101 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless -avd stim-app -port 5554 -grpc 8554',
    '  102 /Users/me/Android SDK/emulator/emulator @stim-app -no-window',
    '  103 C:\\sdk\\emulator\\qemu-system-x86_64.exe -avd stim-app',
    '  104 /sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64 -avd stim-app-2 -port 5556',
    '  105 grep -avd stim-app',
    '  106 node stim.mjs android -avd stim-app',
    '  107 /sdk/emulator/emulator -avd stim-apps',
  ].join('\n');

  expect(parseAvdEmulatorProcesses(table, 'stim-app')).toEqual([101, 102]);
});

test('assertOwnedAvdStopped refuses an emulator process of the AVD that its process lock does not name', () => {
  expect(() =>
    assertOwnedAvdStopped('stim-app', {
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => null,
      listProcesses: () => [4242],
    }),
  ).toThrow('Owned AVD stim-app still has a live emulator process (4242).');
  expect(() =>
    assertOwnedAvdStopped('stim-app', {
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => null,
      listProcesses: () => null,
    }),
  ).toThrow(/Could not read the process table/);
});

describe('owned AVD stop verification when the process table read is slow under load', () => {
  const table = '  1 /sbin/launchd\n  2 /usr/sbin/syslogd';
  const liveTable = '  4242 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd stim-app';
  const noLock = {
    platform: 'darwin' as const,
    resolveDirectory: () => '/avds/stim-app.avd',
    readProcessId: () => null,
  };
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

  test.skipIf(posixOnly)('assertOwnedAvdStoppedAsync verifies a stopped AVD after a timed-out first read', async () => {
    const timeouts = psReads([new Error('timed out'), table]);

    await expect(
      assertOwnedAvdStoppedAsync('stim-app', testContext(), () => '/avds/stim-app.avd'),
    ).resolves.toBeUndefined();
    expect(timeouts).toEqual([5000, 15_000]);
  });

  test.skipIf(posixOnly)(
    'assertOwnedAvdStoppedAsync still reports a live emulator found by a retried read',
    async () => {
      psReads([new Error('timed out'), liveTable]);

      await expect(assertOwnedAvdStoppedAsync('stim-app', testContext(), () => '/avds/stim-app.avd')).rejects.toThrow(
        'Owned AVD stim-app still has a live emulator process (4242).',
      );
    },
  );

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

  test('waitForAndroidEmulatorShutdown treats a stopped AVD as stopped after a timed-out first read', async () => {
    const timeouts = psReads([new Error('timed out'), table]);

    await expect(
      waitForAndroidEmulatorShutdown('stim-app', null, { ...noLock, operation: testContext() }),
    ).resolves.toBeUndefined();
    expect(timeouts).toEqual([5000, 15_000]);
  });

  test('waitForAndroidEmulatorShutdown refuses when the table never reads', async () => {
    psReads([new Error('timed out')]);

    await expect(
      waitForAndroidEmulatorShutdown('stim-app', null, { ...noLock, operation: testContext() }),
    ).rejects.toThrow(/Could not read the process table/);
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

  test('signals the verified emulator once the console shutdown times out, SIGTERM before SIGKILL', async () => {
    const { options, signals, alive } = hungEmulator({ pids: [4242] });
    const consoleKills: number[] = [];

    await waitForAndroidEmulatorShutdown(
      'stim-app',
      async (timeoutMs) => {
        consoleKills.push(timeoutMs);
      },
      options,
    );

    expect(consoleKills).toEqual([60_000]);
    expect(signals).toEqual(['SIGTERM:4242@60000', 'SIGKILL:4242@65000']);
    expect(alive.size).toBe(0);
  });

  test('stops an orphaned emulator that holds no process lock and is not reachable over adb', async () => {
    const { options, signals } = hungEmulator({ pids: [4242], dies: ['SIGTERM'] });

    await waitForAndroidEmulatorShutdown('stim-app', null, { ...options, readProcessId: () => null });

    expect(signals).toEqual(['SIGTERM:4242@0']);
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

  test('refuses when the emulator survives SIGKILL', async () => {
    const { options, signals } = hungEmulator({ pids: [4242], dies: [] });

    await expect(waitForAndroidEmulatorShutdown('stim-app', () => {}, options)).rejects.toThrow(
      'Owned AVD stim-app did not finish shutting down after 70s: emulator process 4242 is still running.',
    );
    expect(signals).toEqual(['SIGTERM:4242@60000', 'SIGKILL:4242@65000']);
  });
});

test('waitForAndroidEmulatorShutdown verifies the AVD directory remains available', async () => {
  let locked = true;

  await expect(
    waitForAndroidEmulatorShutdown('stim-app', () => {}, {
      listProcesses: () => [],
      resolveDirectory: () => '/avds/stim-app.avd',
      readProcessId: () => 123,
      processAlive: () => {
        const result = locked;
        locked = false;
        return result;
      },
      directoryExists: () => false,
      sleep: () => {},
    }),
  ).rejects.toThrow(/Could not verify the content directory/);
});

test('shutdownAndroidEmulator bounds the guest write flush before killing the emulator', async () => {
  const calls: Array<{ command: string; timeoutMs: number | undefined }> = [];
  const now = vi.spyOn(Date, 'now').mockReturnValue(0);
  setExecutor({
    runFileQuiet: (file: string, args: string[], options) => {
      calls.push({ command: [file, ...args].join(' '), timeoutMs: options?.timeoutMs });
      return '';
    },
  });

  try {
    await shutdownAndroidEmulator('emulator-5554');
  } finally {
    now.mockRestore();
  }

  expect(calls).toEqual([
    { command: 'adb -s emulator-5554 shell sync', timeoutMs: 5000 },
    { command: 'adb -s emulator-5554 emu kill', timeoutMs: 60_000 },
  ]);
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

test('waitForBoot keeps polling while adb still fails', async () => {
  let calls = 0;
  setExecutor({
    run: () => '',
    runFileQuiet: (file: string, args: string[] = []) => {
      const cmd = [file, ...args].join(' ');
      if (/pm path android/.test(cmd)) return 'package:/system/framework/framework-res.apk';
      if (!/getprop/.test(cmd)) return '';
      calls++;
      if (calls <= 2) return null;
      return /sys.boot_completed/.test(cmd) ? '1\n' : null;
    },
    spawn: () => null,
  });
  const result = await waitForBoot('emulator-5554', 5000);
  expect(result).toEqual({ ok: true });
  expect(calls > 2).toBeTruthy();
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
  const result = await waitForBoot('emulator-5554', 5000, { pollMs: 1 });
  expect(result).toEqual({ ok: true });
  expect(calls.filter((cmd) => /shell pm path android/.test(cmd))).toHaveLength(3);
  expect(calls.filter((cmd) => /getprop/.test(cmd)).length).toBeGreaterThanOrEqual(3);
});

test('waitForBoot pays one package-manager probe when it is already up and reports one that never answers', async () => {
  const calls: string[] = [];
  const executor = (pm: string | null) => ({
    run: () => '',
    runFileQuiet: (file: string, args: string[] = []) => {
      const cmd = [file, ...args].join(' ');
      calls.push(cmd);
      if (/getprop sys\.boot_completed/.test(cmd)) return '1';
      if (/shell pm path android/.test(cmd)) return pm;
      return '';
    },
    spawn: () => null,
  });
  setExecutor(executor('package:/system/framework/framework-res.apk'));
  expect(await waitForBoot('emulator-5554', 5000, { pollMs: 1 })).toEqual({ ok: true });
  expect(calls).toEqual([
    'adb -s emulator-5554 shell getprop sys.boot_completed',
    'adb -s emulator-5554 shell pm path android',
  ]);
  calls.length = 0;
  setExecutor(executor(null));
  const result = await waitForBoot('emulator-5554', 20, { pollMs: 1 });
  expect(result.ok).toBe(false);
  expect(result.diagnostic).toMatchObject({ sysBoot: '1', packageManager: '' });
});

test('waitForBoot reports a timeout diagnostic when adb never answers', async () => {
  setExecutor({
    run: () => '',
    runFileQuiet: () => null,
    spawn: () => null,
  });
  const result = await waitForBoot('emulator-5554', 10);
  expect(result.ok).toBe(false);
  expect(result.diagnostic).toEqual({ devices: '', sysBoot: '', devBoot: '', bootAnim: '', packageManager: '' });
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
    vi.useRealTimers();
  }
});

test('androidToolPath resolves each tool inside ANDROID_HOME when it exists', () => {
  const sdk = makeFakeSdk(tmpHome);
  process.env.ANDROID_HOME = sdk;
  expect(androidToolPath('emulator')).toBe(join(sdk, 'emulator', SDK_TOOL_FILES.emulator));
  expect(androidToolPath('adb')).toBe(join(sdk, 'platform-tools', SDK_TOOL_FILES.adb));
  expect(androidToolPath('avdmanager')).toBe(join(sdk, 'cmdline-tools', 'latest', 'bin', SDK_TOOL_FILES.avdmanager));
});

test('androidToolPath honours ANDROID_SDK_ROOT when ANDROID_HOME is unset', () => {
  const sdk = makeFakeSdk(tmpHome);
  delete process.env.ANDROID_HOME;
  process.env.ANDROID_SDK_ROOT = sdk;
  expect(androidToolPath('adb')).toBe(join(sdk, 'platform-tools', SDK_TOOL_FILES.adb));
});

test('androidToolPath falls back to the bare name when no SDK is on disk', () => {
  process.env.ANDROID_HOME = join(tmpHome, 'nowhere');
  expect(androidToolPath('emulator')).toBe('emulator');
  expect(androidToolPath('adb')).toBe('adb');
  expect(androidToolPath('avdmanager')).toBe('avdmanager');
});

test('androidToolPath uses the Windows names the SDK installs and keeps the bare name off it', () => {
  const sdk = join(tmpHome, 'win-sdk');
  mkdirSync(join(sdk, 'cmdline-tools', 'latest', 'bin'), { recursive: true });
  writeFileSync(join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat'), '');
  process.env.ANDROID_HOME = sdk;
  expect(androidToolPath('avdmanager', 'win32')).toBe(join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat'));
  expect(androidToolPath('adb', 'win32')).toBe('adb');
  expect(androidToolPath('emulator', 'win32')).toBe('emulator');
});

test('listAvds runs the resolved emulator binary with literal arguments', () => {
  const sdk = makeFakeSdk(tmpHome);
  process.env.ANDROID_HOME = sdk;
  const calls: [string, string[]][] = [];
  setExecutor({
    runFile: (file: string, args: string[] = []) => {
      calls.push([file, args]);
      return 'Pixel_6_API_34\n';
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  expect(listAvds()).toEqual(['Pixel_6_API_34']);
  expect(calls).toEqual([[join(sdk, 'emulator', SDK_TOOL_FILES.emulator), ['-list-avds']]]);
});

test('bootAndroidEmulator spawns the resolved emulator binary', async () => {
  const sdk = makeFakeSdk(tmpHome);
  process.env.ANDROID_HOME = sdk;
  const savedDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ':0';
  const spawned: Array<[string, string[]]> = [];
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn: (cmd: string, args: string[]) => {
      spawned.push([cmd, args]);
      return { unref: () => {} };
    },
  });
  try {
    await bootAndroidEmulator('stim-app', 5556, { platform: 'linux' });
  } finally {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  }
  expect(spawned).toEqual([
    [
      join(sdk, 'emulator', SDK_TOOL_FILES.emulator),
      ['-avd', 'stim-app', '-port', '5556', '-grpc', '8556', '-grpc-use-token'],
    ],
  ]);
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

test('androidEmulatorApp stim-desktop, set or defaulted by an installed Stim Desktop, boots a headless macOS emulator and opens it in Stim Desktop', async () => {
  const sdk = makeFakeSdk(tmpHome);
  process.env.ANDROID_HOME = sdk;
  const savedDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ':0';
  const spawned: string[][] = [];
  const opened: string[][] = [];
  const omittedEnv: (readonly string[] | undefined)[] = [];
  let desktop: string | null = null;
  setExecutor({
    runQuiet: () => null,
    runFile: (file: string) => (file === 'osascript' ? (desktop ?? '') : ''),
    runFileQuiet: (file: string, args: string[] = [], opts?: { omitEnv?: readonly string[] }) => {
      opened.push([file, ...args]);
      omittedEnv.push(opts?.omitEnv);
      return null;
    },
    spawn: (_cmd: string, args: string[]) => {
      spawned.push(args);
      return { unref: () => {}, pid: 42 };
    },
  });
  const config = join(tmpHome, 'config.json');
  try {
    await bootAndroidEmulator('stim-app', 5554, { platform: 'darwin' });
    writeFileSync(config, JSON.stringify({ androidEmulatorApp: 'stim-desktop' }));
    await bootAndroidEmulator('stim-app', 5556, { platform: 'darwin' });
    await bootAndroidEmulator('stim-app', 5558, { platform: 'linux' });
    desktop = '/Applications/Stim.app';
    writeFileSync(config, JSON.stringify({}));
    await bootAndroidEmulator('stim-app', 5560, { platform: 'darwin' });
    await bootAndroidEmulator('stim-app', 5562, { platform: 'linux' });
    writeFileSync(config, JSON.stringify({ androidEmulatorApp: 'emulator' }));
    await bootAndroidEmulator('stim-app', 5564, { platform: 'darwin' });
  } finally {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  }
  const headless = spawned.map((args) => args.includes('-no-window'));
  expect(headless).toEqual([false, true, false, true, false, false]);
  expect(spawned[1]?.slice(-3)).toEqual(['-no-window', '-gpu', 'host']);
  expect(opened).toEqual([
    ['open', '-g', '-a', 'Stim', 'stim-desktop://open?serial=emulator-5556'],
    ['open', '-g', '-a', 'Stim', 'stim-desktop://open?serial=emulator-5560'],
  ]);
  expect(omittedEnv).toEqual([['STIM_HOME'], ['STIM_HOME']]);
});

test('suppressEmulatorCrashConsent passes -crash-report-mode never to emulator 37+, and removes the crash database for an older one', () => {
  const removed: string[] = [];
  const databases = () => ['C:\\tmp\\AndroidEmulator\\emu-crash-36.2.12.db'];
  const remove = (path: string) => removed.push(path);
  expect(suppressEmulatorCrashConsent({ platform: 'win32', version: () => 37, databases, remove })).toEqual([
    '-crash-report-mode',
    'never',
  ]);
  expect(removed).toEqual([]);
  expect(suppressEmulatorCrashConsent({ platform: 'win32', version: () => 36, databases, remove })).toEqual([]);
  expect(suppressEmulatorCrashConsent({ platform: 'win32', version: () => null, databases, remove })).toEqual([]);
  expect(removed).toEqual([
    'C:\\tmp\\AndroidEmulator\\emu-crash-36.2.12.db',
    'C:\\tmp\\AndroidEmulator\\emu-crash-36.2.12.db',
  ]);
  expect(
    suppressEmulatorCrashConsent({
      platform: 'darwin',
      version: () => {
        throw new Error('not probed off Windows');
      },
      databases,
      remove,
    }),
  ).toEqual([]);
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

test('parseEmulatorVersion reads the major from the launcher banner', () => {
  expect(parseEmulatorVersion('Android emulator version 37.1.11.0 (build_id 15917651) (CL:N/A)\nCopyright')).toBe(37);
  expect(parseEmulatorVersion('Android emulator version 36.2.12.0 (build_id 1)')).toBe(36);
  expect(parseEmulatorVersion('')).toBeNull();
  expect(parseEmulatorVersion(null)).toBeNull();
});

test('listAvds keeps the bare command when resolution falls back to PATH', () => {
  process.env.ANDROID_HOME = join(tmpHome, 'nowhere');
  const calls: string[] = [];
  setExecutor({
    runFile: (file: string, args: string[] = []) => {
      calls.push([file, ...args].join(' '));
      return '';
    },
    runQuiet: () => null,
    spawn: () => null,
  });
  listAvds();
  expect(calls).toEqual(['emulator -list-avds']);
});

describe('findBuildTool', () => {
  test('takes the newest build-tools that actually has the tool', () => {
    const found = findBuildTool(['zipalign'], {
      home: '/sdk',
      readDir: () => ['34.0.0', '36.0.0', '35.0.0'],
      exists: (path) => path === join('/sdk', 'build-tools', '35.0.0', 'zipalign'),
      platform: 'darwin',
    });
    expect(found).toEqual({
      path: join('/sdk', 'build-tools', '35.0.0', 'zipalign'),
      tool: 'zipalign',
      version: '35.0.0',
      major: 35,
    });
  });

  test('on Windows the build-tools entries carry their own extensions', () => {
    const probe = (tool: string) =>
      findBuildTool([tool], { home: '/sdk', readDir: () => ['36.0.0'], exists: () => true, platform: 'win32' })?.path;
    expect(probe('zipalign')).toBe(join('/sdk', 'build-tools', '36.0.0', 'zipalign.exe'));
    expect(probe('apksigner')).toBe(join('/sdk', 'build-tools', '36.0.0', 'apksigner.bat'));
  });

  test('the tool ORDER within a version is the caller preference', () => {
    const found = findBuildTool(['aapt', 'aapt2'], {
      home: '/sdk',
      readDir: () => ['36.0.0'],
      exists: () => true,
    });
    expect(found?.tool).toBe('aapt');
  });

  test('no SDK, no build-tools, or no copy of the tool anywhere is null', () => {
    expect(
      findBuildTool(['zipalign'], {
        home: '/sdk',
        readDir: () => {
          throw new Error('ENOENT');
        },
        exists: () => false,
      }),
    ).toBe(null);
    expect(findBuildTool(['zipalign'], { home: '/sdk', readDir: () => ['36.0.0'], exists: () => false })).toBe(null);
    expect(findBuildTool(['zipalign'], { home: '/sdk', readDir: () => ['NOTICE.txt'], exists: () => true })).toBe(null);
  });

  test('the major is what a version-gated flag reads, and an unparseable one is 0', () => {
    expect(buildToolsMajor('36.0.0')).toBe(36);
    expect(buildToolsMajor('35.0.0-rc1')).toBe(35);
    expect(buildToolsMajor('nonsense')).toBe(0);
    expect(buildToolsMajor(undefined)).toBe(0);
  });
});

test('waitForBoot stops as soon as the emulator process is gone', async () => {
  let probes = 0;
  setExecutor({
    run: () => '',
    runFileQuiet: (file: string, args: string[] = []) => {
      const cmd = [file, ...args].join(' ');
      if (/getprop/.test(cmd)) probes++;
      return null;
    },
    spawn: () => null,
  });
  const started = Date.now();
  const result = await waitForBoot('emulator-5554', 60000, { aborted: () => true, pollMs: 5 });
  expect(result.ok).toBe(false);
  expect(result.exited).toBe(true);
  expect(Date.now() - started < 5000).toBeTruthy();
  expect(probes > 0).toBeTruthy();
});

test('waitForBoot keeps polling while the emulator process is alive', async () => {
  let probes = 0;
  setExecutor({
    run: () => '',
    runFileQuiet: (file: string, args: string[] = []) => {
      const cmd = [file, ...args].join(' ');
      if (/pm path android/.test(cmd)) return 'package:/system/framework/framework-res.apk';
      if (!/getprop/.test(cmd)) return '';
      probes++;
      return probes >= 5 && /sys\.boot_completed/.test(cmd) ? '1' : null;
    },
    spawn: () => null,
  });
  const result = await waitForBoot('emulator-5554', 5000, { aborted: () => false, pollMs: 1 });
  expect(result).toEqual({ ok: true });
  expect(probes >= 5).toBeTruthy();
});

test('waitForBoot returns ok when the device booted even if the process reads as gone', async () => {
  setExecutor({
    run: () => '',
    runFileQuiet: (_file: string, args: string[]) =>
      /sys\.boot_completed/.test(args.join(' '))
        ? '1'
        : /pm path android/.test(args.join(' '))
          ? 'package:/system/framework/framework-res.apk'
          : '',
    spawn: () => null,
  });
  expect(await waitForBoot('emulator-5554', 5000, { aborted: () => true, pollMs: 1 })).toEqual({ ok: true });
});

test('bootAndroidEmulator writes stdout and stderr to the log file it is given', async () => {
  const logFile = join(tmpHome, 'logs', 'emulator.log');
  const spawned: Array<Record<string, unknown>> = [];
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn: (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      spawned.push(opts);
      return { pid: 4242, unref: () => {} };
    },
  });
  const pid = await bootAndroidEmulator('stim-app', 5556, { logFile, platform: 'linux' });
  expect(pid).toBe(4242);
  expect(existsSync(logFile)).toBe(true);
  const opts = spawned[0];
  assert(opts);
  expect(opts.detached).toBe(true);
  const stdio = opts.stdio as [string, number, number];
  expect(stdio[0]).toBe('ignore');
  expect(typeof stdio[1]).toBe('number');
  expect(stdio[2]).toBe(stdio[1]);
  writeFileSync(logFile, 'FATAL | nope\n');
  expect(readFileSync(logFile, 'utf-8')).toContain('FATAL');
});

test('bootAndroidEmulator keeps stdio ignored when no log file is given', async () => {
  const spawned: Array<Record<string, unknown>> = [];
  setExecutor({
    run: () => '',
    runQuiet: () => null,
    spawn: (_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      spawned.push(opts);
      return { unref: () => {} };
    },
  });
  expect(await bootAndroidEmulator('stim-app', 5556, { platform: 'linux' })).toBe(null);
  expect(spawned[0]?.stdio).toBe('ignore');
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

const REAL_DISK_LINE =
  'FATAL | Not enough space to create userdata partition. Available: 6341.54 MB at /Users/j/.android/avd, need 7372.80 MB';

test('extractEmulatorFailure lifts the real disk-space FATAL line', () => {
  const log = [
    'INFO    | Storing crashdata in: /tmp/AndroidEmulator/emu-crash.db',
    'INFO    | Android emulator version 35.2.10.0',
    REAL_DISK_LINE,
  ].join('\n');
  expect(extractEmulatorFailure(log)).toEqual([REAL_DISK_LINE]);
});

test('extractEmulatorFailure recognizes the ERROR and PANIC shapes too', () => {
  expect(extractEmulatorFailure('ERROR | Unknown AVD name [nope], use -list-avds to see valid list.')).toEqual([
    'ERROR | Unknown AVD name [nope], use -list-avds to see valid list.',
  ]);
  expect(extractEmulatorFailure("PANIC: Missing emulator engine program for 'arm64' CPU.")).toEqual([
    "PANIC: Missing emulator engine program for 'arm64' CPU.",
  ]);
  expect(extractEmulatorFailure('FATAL   | out of memory')).toEqual(['FATAL   | out of memory']);
  expect(extractEmulatorFailure('emulator: ERROR | could not open the AVD config')).toEqual([
    'emulator: ERROR | could not open the AVD config',
  ]);
});

test('extractEmulatorFailure returns nothing for a log with no severity markers', () => {
  const log = [
    'INFO    | Android emulator version 35.2.10.0',
    'WARNING | System image is out of date',
    'Successfully loaded snapshot default_boot',
    '',
  ].join('\n');
  expect(extractEmulatorFailure(log)).toEqual([]);
  expect(extractEmulatorFailure('')).toEqual([]);
  expect(extractEmulatorFailure(null)).toEqual([]);
});

test('extractEmulatorFailure dedupes repeated lines', () => {
  const log = [REAL_DISK_LINE, 'INFO | retrying', REAL_DISK_LINE, REAL_DISK_LINE].join('\n');
  expect(extractEmulatorFailure(log)).toEqual([REAL_DISK_LINE]);
});

test('extractEmulatorFailure drops ERROR lines when a fatal-class line is present', () => {
  const log = [
    'ERROR | could not read the config',
    'FATAL | the actual cause',
    'INFO  | chatter',
    'PANIC: and the abort',
  ].join('\n');
  expect(extractEmulatorFailure(log)).toEqual(['FATAL | the actual cause', 'PANIC: and the abort']);
});

test('extractEmulatorFailure keeps the newest three, in log order', () => {
  const log = ['ERROR | first error', 'ERROR | second error', 'ERROR | third error', 'ERROR | fourth error'].join('\n');
  const found = extractEmulatorFailure(log);
  expect(found.length).toBe(MAX_EMULATOR_FAILURE_LINES);
  expect(found).toEqual(['ERROR | second error', 'ERROR | third error', 'ERROR | fourth error']);
});

test('extractEmulatorFailure keeps the emulator order: cause first, notes after', () => {
  const log = [
    'INFO         | Android emulator version 36.4.9.0 (build_id 14788078) (CL:N/A)',
    'INFO         | Graphics backend: gfxstream',
    'ERROR        | Unknown AVD name [stim-does-not-exist-64], use -list-avds to see valid list.',
    'ERROR        | HOME is defined but there is no file stim-does-not-exist-64.ini in $HOME/.android/avd',
    'ERROR        | (Note: Directories are searched in the order $ANDROID_AVD_HOME, $ANDROID_SDK_HOME/avd and $HOME/.android/avd)',
  ].join('\n');
  const found = extractEmulatorFailure(log);
  expect(found[0]).toMatch(/Unknown AVD name \[stim-does-not-exist-64\]/);
  expect(found.length).toBe(3);
});

test('emulatorFailureRemedy answers the disk case with free-space instructions', () => {
  expect(emulatorFailureRemedy([REAL_DISK_LINE])).toMatch(/Free disk space/);
  expect(emulatorFailureRemedy([REAL_DISK_LINE])).toMatch(/~\/.android\/avd/);
  expect(emulatorFailureRemedy(["PANIC: Missing emulator engine program for 'arm64' CPU."])).toMatch(
    /Fix what the emulator reported above/,
  );
  expect(emulatorFailureRemedy([])).toMatch(/Fix what the emulator reported above/);
});

test('resolvePhysicalDevice picks the only connected physical device when none is requested', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n`);
  expect(resolvePhysicalDevice(null, adb)).toEqual({ serial: 'RFCR7081Q9L' });
});

test('resolvePhysicalDevice ignores emulators when picking the only physical device', () => {
  const adb = parseAdbDevices(`List of devices attached\nemulator-5554\tdevice\nRFCR7081Q9L\tdevice\n`);
  expect(resolvePhysicalDevice(null, adb)).toEqual({ serial: 'RFCR7081Q9L' });
});

test('resolvePhysicalDevice refuses when no physical device is connected', () => {
  const adb = parseAdbDevices(`List of devices attached\nemulator-5554\tdevice\n`);
  const result = resolvePhysicalDevice(null, adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/No physical Android device is connected/);
  expect(result.remedy).toMatch(/adb devices/);
});

test('resolvePhysicalDevice refuses an ambiguous choice and names every candidate', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n0123456789ABCDEF\tdevice\n`);
  const result = resolvePhysicalDevice(null, adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toContain('RFCR7081Q9L');
  expect(result.error).toContain('0123456789ABCDEF');
  expect(result.remedy).toMatch(/--device <serial>/);
});

test('resolvePhysicalDevice accepts a requested serial that is connected', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n0123456789ABCDEF\tdevice\n`);
  expect(resolvePhysicalDevice('0123456789ABCDEF', adb)).toEqual({ serial: '0123456789ABCDEF' });
});

test('resolvePhysicalDevice refuses a requested serial that is not connected', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n`);
  const result = resolvePhysicalDevice('NOPE', adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/NOPE is not connected/);
  expect(result.error).toContain('RFCR7081Q9L');
});

test('resolvePhysicalDevice refuses an emulator serial', () => {
  const adb = parseAdbDevices(`List of devices attached\nemulator-5554\tdevice\n`);
  const result = resolvePhysicalDevice('emulator-5554', adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/emulator-5554 is an emulator/);
  expect(result.remedy).toMatch(/without --device/);
});

test('resolvePhysicalDevice reports an unauthorized device instead of calling it absent', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tunauthorized\n`);
  const result = resolvePhysicalDevice(null, adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/RFCR7081Q9L is connected but unauthorized/);
  expect(result.remedy).toMatch(/USB debugging/);
});

test('resolvePhysicalDevice reports an offline requested device instead of calling it absent', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\toffline\n`);
  const result = resolvePhysicalDevice('RFCR7081Q9L', adb);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/RFCR7081Q9L is connected but offline/);
});

test('physicalDeviceModel passes the serial as an argument, never through a shell string', () => {
  const calls: { file: string; args: string[] }[] = [];
  setExecutor({
    runFile: (file: string, args: string[] = []) => {
      calls.push({ file, args });
      return 'SM-G996W\n';
    },
    run: () => {
      throw new Error('a shell string must not be built from a device serial');
    },
    runQuiet: () => {
      throw new Error('a shell string must not be built from a device serial');
    },
  } as never);
  expect(physicalDeviceModel('RFCR7081Q9L')).toBe('SM-G996W');
  expect(calls[0]?.args).toEqual(['-s', 'RFCR7081Q9L', 'shell', 'getprop', 'ro.product.model']);
  resetExecutor();
});

test('physicalDeviceModel returns null when adb cannot answer', () => {
  setExecutor({
    runFile: () => {
      throw new Error('device offline');
    },
  } as never);
  expect(physicalDeviceModel('RFCR7081Q9L')).toBeNull();
  resetExecutor();
});

test('androidDeviceAbi reads the device primary ABI', () => {
  const calls: string[][] = [];
  setExecutor({
    runFile: (_file: string, args: string[] = []) => {
      calls.push(args);
      return 'arm64-v8a\n';
    },
  } as never);
  expect(androidDeviceAbi('RFCR7081Q9L')).toBe('arm64-v8a');
  expect(calls).toEqual([['-s', 'RFCR7081Q9L', 'shell', 'getprop', 'ro.product.cpu.abi']]);
});

test('Android ABI detection falls back when the value is not supported', () => {
  setExecutor({ runFile: () => 'unknown' } as never);
  expect(androidDeviceAbi('RFCR7081Q9L')).toBeNull();
  expect(androidSystemImageAbi('system-images;android-36;google_apis;unknown')).toBeNull();
  expect(androidSystemImageAbi(null)).toBeNull();
});

test('androidSystemImageAbi uses the architecture selected for an owned emulator', () => {
  expect(androidSystemImageAbi('system-images;android-36;google_apis;arm64-v8a')).toBe('arm64-v8a');
  expect(androidSystemImageAbi('system-images;android-35;google_apis;x86_64')).toBe('x86_64');
});

test('resolvePhysicalDevice refuses a network-attached emulator that adb reports as physical', () => {
  const adb = parseAdbDevices(`List of devices attached\n192.168.56.101:5555\tdevice\n`);
  const result = resolvePhysicalDevice(null, adb, () => true);
  expect(result.serial).toBeUndefined();
  expect(result.error).toMatch(/is an emulator/);
});

test('resolvePhysicalDevice accepts a genuine device over adb-over-TCP', () => {
  const adb = parseAdbDevices(`List of devices attached\n192.168.1.5:5555\tdevice\n`);
  expect(resolvePhysicalDevice(null, adb, () => false)).toEqual({ serial: '192.168.1.5:5555' });
});

test('resolvePhysicalDevice reports the whole adb status, not its first word', () => {
  const adb = parseAdbDevices(`List of devices attached\n1234567890\tno permissions; see [http://x]\n`);
  const result = resolvePhysicalDevice(null, adb);
  expect(result.error).toMatch(/no permissions/);
  expect(result.error).not.toMatch(/but no,/);
});

test('androidPoolNoCandidatesRefusal names each emulator-only physical serial with its own reason, not the count message', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n0123456789ABCDEF\tdevice\n`);
  const result = androidPoolNoCandidatesRefusal(adb, () => true);
  expect(result.serial).toBeUndefined();
  expect(result.error).toContain(resolvePhysicalDevice('RFCR7081Q9L', adb, () => true).error);
  expect(result.error).toContain(resolvePhysicalDevice('0123456789ABCDEF', adb, () => true).error);
  expect(result.error).not.toMatch(/Several physical devices are connected/);
  expect(result.remedy).toMatch(/without --device/);
});

test('androidPoolNoCandidatesRefusal falls back to the resolver when a physical device is genuine', () => {
  const adb = parseAdbDevices(`List of devices attached\nRFCR7081Q9L\tdevice\n`);
  expect(androidPoolNoCandidatesRefusal(adb, () => false)).toEqual(resolvePhysicalDevice(null, adb, () => false));
  const none = parseAdbDevices(`List of devices attached\n`);
  expect(androidPoolNoCandidatesRefusal(none)).toEqual(resolvePhysicalDevice(null, none));
});

test('memoizeEmulatorProbe probes a serial once and reuses the result across repeated calls', () => {
  const calls: string[] = [];
  const probe = memoizeEmulatorProbe((serial) => {
    calls.push(serial);
    return serial === 'emulator-5554';
  });
  expect(probe('emulator-5554')).toBe(true);
  expect(probe('RFCR7081Q9L')).toBe(false);
  expect(probe('emulator-5554')).toBe(true);
  expect(probe('RFCR7081Q9L')).toBe(false);
  expect(calls).toEqual(['emulator-5554', 'RFCR7081Q9L']);
});

test('parseAvdSystemImage turns the config.ini image directory back into an sdkmanager package id', () => {
  expect(
    parseAvdSystemImage(
      'avd.ini.encoding=UTF-8\nimage.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\ntag.id=google_apis\n',
    ),
  ).toBe('system-images;android-36;google_apis;arm64-v8a');
  expect(parseAvdSystemImage('image.sysdir.1 = system-images/android-35/default/x86_64')).toBe(
    'system-images;android-35;default;x86_64',
  );
  expect(parseAvdSystemImage('image.sysdir.1=system-images\\android-36\\google_apis\\x86_64\\\n')).toBe(
    'system-images;android-36;google_apis;x86_64',
  );
  expect(parseAvdSystemImage('image.sysdir.1=\n')).toBe(null);
  expect(parseAvdSystemImage('hw.cpu.arch=arm64\n')).toBe(null);
  expect(parseAvdSystemImage('')).toBe(null);
});

test('ownedAvdSystemImage reads the AVD Stim owns and stays null when it cannot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stim-avd-image-'));
  try {
    writeFileSync(join(dir, 'config.ini'), 'image.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\n');
    expect(ownedAvdSystemImage('stim-app', { avdDirectory: () => dir })).toBe(
      'system-images;android-36;google_apis;arm64-v8a',
    );
    expect(ownedAvdSystemImage('stim-app', { avdDirectory: () => null })).toBe(null);
    expect(ownedAvdSystemImage('stim-app', { avdDirectory: () => join(dir, 'gone') })).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
