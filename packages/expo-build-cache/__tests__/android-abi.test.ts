import { vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root;
let sdk;
let apk;
let savedHome;
let savedAndroidHome;
let savedSdkRoot;

function connect(devices) {
  writeFileSync(join(sdk, 'devices'), devices.map(([serial, state]) => `${serial}\t${state}\n`).join(''));
  for (const [serial, , abilist] of devices) writeFileSync(join(sdk, `abi-${serial}`), `${abilist}\n`);
}

async function provider() {
  vi.resetModules();
  return import('../index.ts');
}

describe.skipIf(process.platform === 'win32')('android debug builds', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stim-expo-abi-'));
    savedHome = process.env.HOME;
    process.env.HOME = join(root, 'home');
    process.env.STIM_HOME = join(root, 'stim-home');
    process.env.STIM_BUILD_CACHE = join(root, 'cache');
    sdk = join(root, 'sdk');
    mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
    const adb = join(sdk, 'platform-tools', 'adb');
    writeFileSync(
      adb,
      `#!/bin/sh\nif [ "$1" = devices ]; then echo 'List of devices attached'; cat '${sdk}/devices'; exit 0; fi\ncat "${sdk}/abi-$2"\n`,
    );
    chmodSync(adb, 0o755);
    savedAndroidHome = process.env.ANDROID_HOME;
    savedSdkRoot = process.env.ANDROID_SDK_ROOT;
    process.env.ANDROID_HOME = sdk;
    delete process.env.ANDROID_SDK_ROOT;
    apk = join(root, 'app-debug.apk');
    writeFileSync(apk, 'apk');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env.HOME = savedHome;
    delete process.env.STIM_HOME;
    delete process.env.STIM_BUILD_CACHE;
    if (savedAndroidHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = savedAndroidHome;
    if (savedSdkRoot !== undefined) process.env.ANDROID_SDK_ROOT = savedSdkRoot;
  });

  test('a build for an x86_64 emulator is not served to an arm64 phone', async () => {
    const bc = await provider();
    connect([['emulator-5554', 'device', 'x86_64,arm64-v8a']]);
    const runOptions = { variant: 'debug' };
    expect(await bc.resolveBuildCache({ platform: 'android', fingerprintHash: 'f1', runOptions })).toBeNull();
    expect(
      await bc.uploadBuildCache({ platform: 'android', fingerprintHash: 'f1', buildPath: apk, runOptions }),
    ).toBeTruthy();
    expect(await bc.resolveBuildCache({ platform: 'android', fingerprintHash: 'f1', runOptions })).toBeTruthy();

    connect([['R5CT', 'device', 'arm64-v8a,armeabi-v7a']]);
    expect(await bc.resolveBuildCache({ platform: 'android', fingerprintHash: 'f1', runOptions: {} })).toBeNull();
  });

  test('an all-arch build is not served to a single-ABI run and vice versa', async () => {
    const bc = await provider();
    connect([['emulator-5554', 'device', 'x86_64']]);
    await bc.uploadBuildCache({ platform: 'android', fingerprintHash: 'f2', buildPath: apk, runOptions: {} });
    expect(
      await bc.resolveBuildCache({ platform: 'android', fingerprintHash: 'f2', runOptions: { allArch: true } }),
    ).toBeNull();

    await bc.uploadBuildCache({
      platform: 'android',
      fingerprintHash: 'f3',
      buildPath: apk,
      runOptions: { allArch: true },
    });
    expect(await bc.resolveBuildCache({ platform: 'android', fingerprintHash: 'f3', runOptions: {} })).toBeNull();
    expect(
      await bc.resolveBuildCache({ platform: 'android', fingerprintHash: 'f3', runOptions: { allArch: true } }),
    ).toBeTruthy();
  });

  test('skips the cache when the target device cannot be identified', async () => {
    const bc = await provider();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      connect([
        ['emulator-5554', 'device', 'x86_64'],
        ['R5CT', 'device', 'arm64-v8a'],
      ]);
      expect(await bc.uploadBuildCache({ platform: 'android', fingerprintHash: 'f4', buildPath: apk })).toBeNull();
      expect(await bc.resolveBuildCache({ platform: 'android', fingerprintHash: 'f4' })).toBeNull();
      expect(log.mock.calls.flat().join('\n')).toMatch(/skip android/);
    } finally {
      log.mockRestore();
    }
    expect(existsSync(join(root, 'cache', 'android'))).toBe(false);
  });

  test('a store failure after a successful build does not fail expo run', async () => {
    const blocked = join(root, 'not-a-directory');
    writeFileSync(blocked, '');
    process.env.STIM_BUILD_CACHE = join(blocked, 'cache');
    const bc = await provider();
    connect([['emulator-5554', 'device', 'x86_64']]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await bc.uploadBuildCache({ platform: 'android', fingerprintHash: 'f5', buildPath: apk })).toBeNull();
      expect(log.mock.calls.flat().join('\n')).not.toMatch(/stored/);
      expect(warn).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
