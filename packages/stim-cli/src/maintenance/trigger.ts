import { closeSync, openSync } from 'node:fs';
import {
  maintenanceChildLogFile,
  maintenanceRunClaims,
  readMaintenanceState,
  readMaintenanceAttempt,
} from '@stim-cli/core/state';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { getExecutor } from '../exec.ts';
import { windowsLauncherArgs } from '../detached-entry.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { resolveMaintenanceSettings } from './settings.ts';
import { due } from './due.ts';
import { capChildLog, stampAttempt } from './attempt.ts';

export function triggerMaintenance(
  trigger: string,
  {
    argv = process.argv.slice(2),
    platform = process.platform,
  }: { argv?: readonly string[]; platform?: NodeJS.Platform } = {},
): void {
  try {
    const env = process.env;
    if (
      ['guide', 'settings', 'help'].includes(argv[0] ?? '') ||
      (argv[0] === 'gc' && argv.includes('--delete')) ||
      argv.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg))
    )
      return;
    if (env.STIM_MAINTENANCE_CHILD === '1' || ((env.STIM_HOME || env.CI) && env.STIM_MAINTENANCE === undefined)) return;
    const settings = resolveMaintenanceSettings();
    if (
      settings.mode === 'off' ||
      due(readMaintenanceState(), settings, Date.now(), readMaintenanceAttempt()).length === 0
    )
      return;
    const claims = readClaimSet(maintenanceRunClaims());
    if (claims.live.length || claims.unresolved.length) return;
    const now = Date.now();
    stampAttempt(now);
    capChildLog();
    const logFile = maintenanceChildLogFile();
    const fd = openSync(logFile, 'a');
    try {
      const cwd = process.cwd();
      const entry = spawnEntry('maintenance-run');
      const args = [trigger];
      const launcher = platform === 'win32' ? windowsLauncherArgs({ entry, args, cwd, logFile }) : null;
      const child = getExecutor().spawn(launcher?.file ?? process.execPath, launcher?.args ?? [entry, ...args], {
        cwd,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...env, STIM_MAINTENANCE_CHILD: '1', ...launcher?.env },
        ...(launcher ? { windowsHide: true } : {}),
      });
      child.on?.('error', () => {});
      child.unref?.();
    } finally {
      closeSync(fd);
    }
  } catch {}
}
