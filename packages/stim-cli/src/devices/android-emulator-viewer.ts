import { getExecutor } from '../exec.ts';
import { loadConfig } from '../workspace/config.ts';
import { STIM_DESKTOP_OPEN_OPTIONS, settingDefault, stimDesktopInstalledAsync } from './stim-desktop.ts';
import { ANDROID_EMULATOR_APPS, settingDefinition } from '@stim-cli/core/state';

export type AndroidEmulatorApp = (typeof ANDROID_EMULATOR_APPS)[number];

export async function configuredAndroidEmulatorApp(
  platform: NodeJS.Platform = process.platform,
): Promise<AndroidEmulatorApp> {
  let value = loadConfig()?.androidEmulatorApp;
  if (value === undefined) {
    const installed = await stimDesktopInstalledAsync(platform);
    value = settingDefault(settingDefinition('androidEmulatorApp')!, () => installed).value;
  }
  if ((ANDROID_EMULATOR_APPS as readonly unknown[]).includes(value)) return value as AndroidEmulatorApp;
  const error = new Error('Invalid androidEmulatorApp in machine config. Use "emulator" or "stim-desktop".');
  Object.assign(error, { code: 'STIM_BAD_ARG' });
  throw error;
}

export async function openEmulatorInStimDesktop(serial: string): Promise<void> {
  await getExecutor().runFileQuietAsync(
    'open',
    ['-g', '-a', 'Stim', `stim-desktop://open?serial=${serial}`],
    STIM_DESKTOP_OPEN_OPTIONS,
  );
}
