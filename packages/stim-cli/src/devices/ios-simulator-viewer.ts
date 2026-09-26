import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getExecutor } from '../exec.ts';
import { loadConfig } from '../workspace/config.ts';
import { settingDefault } from './stim-desktop.ts';
import { IOS_SIMULATOR_APPS, settingDefinition } from '@stim-cli/core/state';

export type IosSimulatorApp = (typeof IOS_SIMULATOR_APPS)[number];

interface IosSimulatorViewer {
  open(udid: string): void;
}

const OPEN_OPTIONS = { timeoutMs: 5000, killSignal: 'SIGKILL' } as const;

export function parseIosSimulatorApp(value: unknown, source = 'iosSimulatorApp in machine config'): IosSimulatorApp {
  if ((IOS_SIMULATOR_APPS as readonly unknown[]).includes(value)) return value as IosSimulatorApp;
  const error = new Error(`Invalid ${source}. Use "xcode", "siniulator", or "stim-desktop".`);
  Object.assign(error, { code: 'STIM_BAD_ARG' });
  throw error;
}

export function configuredIosSimulatorViewer(override?: IosSimulatorApp): IosSimulatorViewer {
  const configured = loadConfig()?.iosSimulatorApp;
  const chosen = override ?? (configured === undefined ? undefined : parseIosSimulatorApp(configured));
  return {
    open: (udid) =>
      openSimulator(chosen ?? (settingDefault(settingDefinition('iosSimulatorApp')!).value as IosSimulatorApp), udid),
  };
}

function openSimulator(app: IosSimulatorApp, udid: string): void {
  const exec = getExecutor();
  if (app === 'stim-desktop') {
    exec.runFileQuiet('open', ['-g', '-a', 'Stim', `stim-desktop://open?udid=${udid}`], OPEN_OPTIONS);
    return;
  }
  if (app === 'siniulator') {
    exec.runFileQuiet('open', ['-a', 'Siniulator', `siniulator://open?udid=${udid}`], OPEN_OPTIONS);
    return;
  }
  const simctlPath = exec.runFileQuiet('xcrun', ['--find', 'simctl'], OPEN_OPTIONS);
  const deviceHubApp = simctlPath
    ? resolve(dirname(simctlPath), '..', '..', '..', 'Applications', 'DeviceHub.app')
    : null;
  const args =
    deviceHubApp && existsSync(deviceHubApp)
      ? ['-a', deviceHubApp, `devices://device/open?id=${udid}`]
      : ['-a', 'Simulator'];
  exec.runFileQuiet('open', args, OPEN_OPTIONS);
}
