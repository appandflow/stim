import { getExecutor } from '../exec.ts';
import { loadConfig } from '../workspace/config.ts';
import { ANDROID_EMULATOR_APPS } from '@stim-cli/core/state';

export type AndroidEmulatorApp = (typeof ANDROID_EMULATOR_APPS)[number];

export function configuredAndroidEmulatorApp(): AndroidEmulatorApp {
  const value = loadConfig()?.androidEmulatorApp;
  if (value === undefined) return 'emulator';
  if ((ANDROID_EMULATOR_APPS as readonly unknown[]).includes(value)) return value as AndroidEmulatorApp;
  const error = new Error('Invalid androidEmulatorApp in machine config. Use "emulator" or "stim-desktop".');
  Object.assign(error, { code: 'STIM_BAD_ARG' });
  throw error;
}

export function openEmulatorInStimDesktop(serial: string): void {
  getExecutor().runFileQuiet('open', ['-g', '-a', 'Stim', `stim-desktop://open?serial=${serial}`], {
    timeoutMs: 5000,
    killSignal: 'SIGKILL',
  });
}
