import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDirLock } from '@stim-cli/core';
import {
  assertHostedDeviceLedger,
  hostedConsolePort,
  readHostedDevice,
  type HostedAndroidDevice,
  type HostedAndroidChoice,
  type HostedDeviceSelectors,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { readHostMemoryPressure } from '../host-memory.ts';
import {
  androidDeviceAbi,
  bootAndroidEmulator,
  createOwnedAvd,
  DEFAULT_AVD_DEVICE_PROFILE,
  getAvdNameForSerial,
  hostSystemImageArch,
  listAdbDevices,
  listAvds,
  listAvdDeviceProfiles,
  listInstalledSystemImages,
  ownedAvdName,
  pickDefaultSystemImage,
  waitForBoot,
} from '../devices/android.ts';
import { forgetCreatedDevice } from '../devices/created-devices.ts';
import { teardownOwnedAvd } from '../devices/teardown.ts';
import { ensureConfig, loadConfig, withConfigLock } from '../workspace/config.ts';
import type { HostedWorkerResult } from './worker.ts';
import { installHostedAndroidApp } from './android-app.ts';

function portIsOccupied(port: number): boolean {
  const devices = listAdbDevices({ timeoutMs: 5000 });
  return [...devices.emulators, ...devices.unhealthy].some((device) => device.consolePort === port);
}

export function selectHostedAndroidDevice(request: HostedDeviceSelectors): HostedAndroidChoice {
  if (readHostMemoryPressure(getExecutor()) !== 'normal')
    throw new Error('Host memory pressure is unknown or elevated.');
  const image = pickDefaultSystemImage(listInstalledSystemImages(), { systemImage: request.systemImage });
  if (!image || image.arch !== hostSystemImageArch()) throw new Error('No compatible installed Android image.');
  const profile = request.deviceProfile ?? DEFAULT_AVD_DEVICE_PROFILE;
  if (!listAvdDeviceProfiles().includes(profile)) throw new Error('The Android device profile is not installed.');
  return {
    systemImage: image.pkg,
    deviceProfile: profile,
    architecture: image.arch as HostedAndroidChoice['architecture'],
  };
}

/** Runs only in the private worker home; a caller cannot select or tear down an existing AVD. */
export async function runHostedAndroidDevice(
  mode: 'prepare' | 'stop' | 'install',
  request: { session: string; consolePort?: unknown; systemImage?: string; deviceProfile?: string },
  app?: { attempt: string },
): Promise<HostedWorkerResult> {
  const home = process.env.STIM_HOME;
  if (!home) throw new Error('Hosted workers require their isolated STIM_HOME.');
  let device: HostedAndroidDevice | null = null;
  let creationStarted = false;
  try {
    if (mode === 'install') {
      if (!app) throw new Error('Hosted Android installation needs its admitted app attempt.');
      device = readHostedDevice(home, 'android');
      const launched = await installHostedAndroidApp(home, request.session, app.attempt, device);
      return { state: 'installed', device, launched };
    }
    if (mode === 'prepare') {
      creationStarted = existsSync(join(home, 'hosted-device.json')) || existsSync(join(home, 'created-devices.json'));
      if (creationStarted) throw new Error('Attach or stop the existing hosted Android session.');
      if (!/^[a-f0-9-]{36}$/.test(request.session) || !hostedConsolePort(request.consolePort))
        throw new Error('Hosted Android prepare needs its server-selected session and console port.');
      const choice = selectHostedAndroidDevice(request);
      const avdName = ownedAvdName(`hosted-${request.session}`);
      if (listAvds({ timeoutMs: 5000 }).includes(avdName) || portIsOccupied(request.consolePort))
        throw new Error('The hosted AVD name or selected console port is already in use.');
      const selected: HostedAndroidDevice = {
        avdName,
        serial: `emulator-${request.consolePort}`,
        consolePort: request.consolePort,
        ...choice,
      };
      creationStarted = true;
      await createOwnedAvd(`hosted-${request.session}`, {
        systemImage: choice.systemImage,
        deviceProfile: choice.deviceProfile,
        spawn: (file, args, options) => {
          assertHostedDeviceLedger(home, avdName, 'android');
          withDirLock(join(home, 'hosted-device.lock'), () => {
            const temporary = join(home, 'hosted-device.json.tmp');
            writeFileSync(temporary, JSON.stringify(selected), { mode: 0o600 });
            renameSync(temporary, join(home, 'hosted-device.json'));
          });
          device = selected;
          return getExecutor().spawn(file, args, { ...options, detached: false });
        },
      });
      assertHostedDeviceLedger(home, avdName, 'android');
      if (portIsOccupied(selected.consolePort)) throw new Error('The selected Android console port became occupied.');
      bootAndroidEmulator(avdName, selected.consolePort, { openViewer: false, logFile: join(home, 'emulator.log') });
      if (
        !(await waitForBoot(selected.serial, 240000, { commandTimeoutMs: 5000 })).ok ||
        getAvdNameForSerial(selected.serial) !== avdName ||
        androidDeviceAbi(selected.serial) !== selected.architecture
      )
        throw new Error('Hosted Android boot could not be verified for its exact owned AVD.');
      return { state: 'ready', device: selected };
    }
    device = readHostedDevice(home, 'android');
    const ledger = assertHostedDeviceLedger(home, device.avdName, 'android', { allowEmpty: true });
    if (ledger === 'listed') {
      withConfigLock(() => {
        if (!loadConfig()) ensureConfig();
      });
      const outcome = teardownOwnedAvd(device.avdName, { del: true });
      if (outcome.status !== 'torn-down' && outcome.status !== 'missing')
        throw new Error(outcome.reason ?? 'Hosted Android deletion was not established.');
    }
    if (listAvds({ timeoutMs: 5000 }).includes(device.avdName))
      throw new Error('The hosted AVD still exists; deletion could not be verified.');
    if (getAvdNameForSerial(device.serial) === device.avdName)
      throw new Error('The hosted Android emulator is still running.');
    if (ledger === 'listed') forgetCreatedDevice('android', device.avdName);
    return { state: 'stopped', device };
  } catch (error) {
    return {
      state: mode === 'prepare' && !creationStarted && !device ? 'stopped' : 'unknown',
      device,
      notice: (error as Error).message,
    };
  }
}
