import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getExecutor } from '../exec.ts';
import { loadConfig } from '../workspace/config.ts';
import { STIM_DESKTOP_OPEN_OPTIONS, settingDefault, stimDesktopInstalledAsync } from './stim-desktop.ts';
import { IOS_SIMULATOR_APPS, settingDefinition } from '@stim-cli/core/state';

export type IosSimulatorApp = (typeof IOS_SIMULATOR_APPS)[number];

interface IosSimulatorViewer {
  open(udid: string): Promise<void>;
}

const OPEN_OPTIONS = { timeoutMs: 5000, killSignal: 'SIGKILL' } as const;

export function parseIosSimulatorApp(value: unknown, source = 'iosSimulatorApp in machine config'): IosSimulatorApp {
  if ((IOS_SIMULATOR_APPS as readonly unknown[]).includes(value)) return value as IosSimulatorApp;
  const error = new Error(`Invalid ${source}. Use "xcode", "siniulator", or "stim-desktop".`);
  Object.assign(error, { code: 'STIM_BAD_ARG' });
  throw error;
}

export function configuredIosSimulatorViewer(override?: IosSimulatorApp, env?: NodeJS.ProcessEnv): IosSimulatorViewer {
  const configured = loadConfig()?.iosSimulatorApp;
  const chosen = override ?? (configured === undefined ? undefined : parseIosSimulatorApp(configured));
  return {
    open: async (udid) => {
      if (chosen) return openSimulator(chosen, udid);
      const installed = await stimDesktopInstalledAsync(process.platform, env);
      return openSimulator(
        settingDefault(settingDefinition('iosSimulatorApp')!, () => installed).value as IosSimulatorApp,
        udid,
      );
    },
  };
}

async function openSimulator(app: IosSimulatorApp, udid: string): Promise<void> {
  const exec = getExecutor();
  if (app === 'stim-desktop') {
    await exec.runFileQuietAsync(
      'open',
      ['-g', '-a', 'Stim', `stim-desktop://open?udid=${udid}`],
      STIM_DESKTOP_OPEN_OPTIONS,
    );
    return;
  }
  if (app === 'siniulator') {
    await exec.runFileQuietAsync('open', ['-a', 'Siniulator', `siniulator://open?udid=${udid}`], OPEN_OPTIONS);
    return;
  }
  const simctlPath = await exec.runFileQuietAsync('xcrun', ['--find', 'simctl'], OPEN_OPTIONS);
  const deviceHubApp = simctlPath
    ? resolve(dirname(simctlPath), '..', '..', '..', 'Applications', 'DeviceHub.app')
    : null;
  const args =
    deviceHubApp && existsSync(deviceHubApp)
      ? ['-a', deviceHubApp, `devices://device/open?id=${udid}`]
      : ['-a', 'Simulator'];
  await exec.runFileQuietAsync('open', args, OPEN_OPTIONS);
}
