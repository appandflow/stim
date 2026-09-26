import { getExecutor } from '../exec.ts';
import { STIM_DESKTOP_OPEN_OPTIONS } from './ios-simulator-viewer.ts';
import { loadConfig } from '../workspace/config.ts';
import { settingDefault, stimDesktopInstalled } from './stim-desktop.ts';
import { ANDROID_EMULATOR_APPS, settingDefinition } from '@stim-cli/core/state';

export type AndroidEmulatorApp = (typeof ANDROID_EMULATOR_APPS)[number];

export function configuredAndroidEmulatorApp(platform: NodeJS.Platform = process.platform): AndroidEmulatorApp {
  const value =
    loadConfig()?.androidEmulatorApp ??
    settingDefault(settingDefinition('androidEmulatorApp')!, () => stimDesktopInstalled(platform)).value;
  if ((ANDROID_EMULATOR_APPS as readonly unknown[]).includes(value)) return value as AndroidEmulatorApp;
  const error = new Error('Invalid androidEmulatorApp in machine config. Use "emulator" or "stim-desktop".');
  Object.assign(error, { code: 'STIM_BAD_ARG' });
  throw error;
}

export function openEmulatorInStimDesktop(serial: string): void {
  getExecutor().runFileQuiet(
    'open',
    ['-g', '-a', 'Stim', `stim-desktop://open?serial=${serial}`],
    STIM_DESKTOP_OPEN_OPTIONS,
  );
}
