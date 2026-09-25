import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getExecutor } from '../exec.ts';
import { loadConfig } from '../workspace/config.ts';
import { IOS_SIMULATOR_APPS } from '@stim-cli/core/state';

export type IosSimulatorApp = (typeof IOS_SIMULATOR_APPS)[number];

interface IosSimulatorViewer {
  open(udid: string): void;
}

const OPEN_OPTIONS = { timeoutMs: 5000, killSignal: 'SIGKILL' } as const;

export function parseIosSimulatorApp(value: unknown, source = 'iosSimulatorApp in machine config'): IosSimulatorApp {
  if (value === undefined) return 'xcode';
  if ((IOS_SIMULATOR_APPS as readonly unknown[]).includes(value)) return value as IosSimulatorApp;
  const error = new Error(`Invalid ${source}. Use "xcode", "siniulator", or "stim-desktop".`);
  Object.assign(error, { code: 'STIM_BAD_ARG' });
  throw error;
}

export function configuredIosSimulatorViewer(override?: IosSimulatorApp): IosSimulatorViewer {
  const app = override ?? parseIosSimulatorApp(loadConfig()?.iosSimulatorApp);
  const exec = getExecutor();
  if (app === 'stim-desktop') {
    return {
      open: (udid) => {
        exec.runFileQuiet('open', ['-g', '-a', 'Stim', `stim-desktop://open?udid=${udid}`], OPEN_OPTIONS);
      },
    };
  }
  if (app === 'siniulator') {
    return {
      open: (udid) => {
        exec.runFileQuiet('open', ['-a', 'Siniulator', `siniulator://open?udid=${udid}`], OPEN_OPTIONS);
      },
    };
  }
  return {
    open: (udid) => {
      const simctlPath = exec.runFileQuiet('xcrun', ['--find', 'simctl'], OPEN_OPTIONS);
      const deviceHubApp = simctlPath
        ? resolve(dirname(simctlPath), '..', '..', '..', 'Applications', 'DeviceHub.app')
        : null;
      const args =
        deviceHubApp && existsSync(deviceHubApp)
          ? ['-a', deviceHubApp, `devices://device/open?id=${udid}`]
          : ['-a', 'Simulator'];
      exec.runFileQuiet('open', args, OPEN_OPTIONS);
    },
  };
}
