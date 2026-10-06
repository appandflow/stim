import { createHash } from 'node:crypto';
import { createReadStream, copyFileSync, lstatSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertHostedDeviceLedger,
  hostedAppArea,
  hostedAppBlobs,
  readHostedApp,
  readHostedDevice,
  type HostedAndroidDevice,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { findAapt } from '../commands/android/support.ts';
import { getAvdNameForSerial, androidDeviceAbi, androidToolPath } from '../devices/android.ts';
import { androidAppProcess, installAndroidApp, launchAndroidReleaseApp } from '../engine/app-install.ts';

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Installs only a verified single APK into the session's exact running ledger-owned AVD. */
export async function installHostedAndroidApp(
  home: string,
  session: string,
  attempt: string,
  device: HostedAndroidDevice,
): Promise<true | 'unverified'> {
  const record = readHostedApp(session, attempt, home);
  const area = hostedAppArea(session, attempt, home);
  if (record.state !== 'installing') throw new Error('This app attempt has not been admitted for installation.');
  const entry = record.files[0];
  if (record.files.length !== 1 || !entry || entry.path !== 'App.apk' || entry.kind !== 'file')
    throw new Error('Hosted Android delivery requires a single file entry named App.apk.');
  const manifest = join(hostedAppBlobs(session, home), record.manifest.sha256);
  if (lstatSync(manifest).size !== record.manifest.size || (await digest(manifest)) !== record.manifest.sha256)
    throw new Error('The hosted APK manifest differs from its digest.');
  const blob = join(hostedAppBlobs(session, home), entry.sha256);
  const stat = lstatSync(blob);
  if (!stat.isFile() || stat.size !== entry.size || (await digest(blob)) !== entry.sha256)
    throw new Error('APK content is incomplete or differs from its digest.');
  const temporary = join(area, 'App.apk.tmp');
  const apk = join(area, 'App.apk');
  copyFileSync(blob, temporary);
  renameSync(temporary, apk);
  const tool = findAapt();
  if (!tool) throw new Error('No installed Android build-tools can inspect the APK.');
  const badging = getExecutor().runFile(tool.path, ['dump', 'badging', apk], {
    timeoutMs: 10000,
    killSignal: 'SIGKILL',
  });
  const identity = /^package:\s+name='([^']+)'/m.exec(badging)?.[1];
  const minimum = /^(?:sdkVersion|minSdkVersion):'(\d+)'\s*$/m.exec(badging)?.[1];
  const api = /^system-images;android-(\d+);/.exec(device.systemImage)?.[1];
  if (identity !== record.bundleId || !minimum || !api || Number(minimum) > Number(api))
    throw new Error('The APK package identity or minimum SDK is incompatible with the hosted emulator.');
  const nativeCode = /^native-code:\s*(.*)$/m.exec(badging)?.[1];
  if (nativeCode !== undefined && !nativeCode.split(/\s+/).includes(`'${device.architecture}'`))
    throw new Error('The APK has no native library slice for the hosted emulator architecture.');
  const assertTarget = () => {
    assertHostedDeviceLedger(home, device.avdName, 'android');
    const current = readHostedDevice(home, 'android');
    if (
      current.avdName !== device.avdName ||
      current.serial !== device.serial ||
      current.systemImage !== device.systemImage ||
      getAvdNameForSerial(device.serial) !== device.avdName ||
      androidDeviceAbi(device.serial) !== device.architecture
    )
      throw new Error('The hosted Android device identity or running ABI changed.');
  };
  assertTarget();
  const executor = getExecutor();
  const adb = androidToolPath('adb');
  const sdkExecutor: typeof executor = {
    ...executor,
    runFile: (file, args, options) => executor.runFile(file === 'adb' ? adb : file, args, options),
  };
  const installed = installAndroidApp(
    { serial: device.serial, apkPath: apk, packageName: record.bundleId },
    { exec: sdkExecutor },
  );
  if (!installed.ok) throw new Error(installed.reason ?? 'Hosted APK installation was not established.');
  assertTarget();
  const launched = launchAndroidReleaseApp(
    { serial: device.serial, packageName: record.bundleId },
    { exec: sdkExecutor },
  );
  if (!launched.ok) throw new Error(launched.reason ?? 'Hosted APK launch was not established.');
  if (record.mode === 'development') return 'unverified';
  for (let tries = 0; tries < 10; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (androidAppProcess(device.serial, record.bundleId, { exec: sdkExecutor })) return true;
  }
  return 'unverified';
}
