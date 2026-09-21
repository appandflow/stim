import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getExecutor } from '../exec.ts';
import { loadConfig } from '../workspace/config.ts';

type IosSimulatorApp = 'xcode' | 'siniulator';

interface IosSimulatorViewer {
  open(udid: string): void;
}

const OPEN_OPTIONS = { timeoutMs: 5000, killSignal: 'SIGKILL' } as const;

function parseIosSimulatorApp(value: unknown): IosSimulatorApp {
  if (value === undefined || value === 'xcode') return 'xcode';
  if (value === 'siniulator') return 'siniulator';
  const error = new Error('Invalid iosSimulatorApp in machine config. Use "xcode" or "siniulator".');
  Object.assign(error, { code: 'STIM_BAD_ARG' });
  throw error;
}

export function configuredIosSimulatorViewer(): IosSimulatorViewer {
  const app = parseIosSimulatorApp(loadConfig()?.iosSimulatorApp);
  const exec = getExecutor();
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
