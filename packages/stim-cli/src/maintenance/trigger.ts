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

const WARNING_FRESH_MS = 10 * 60_000;

function warnCriticalDisk(): void {
  const state = readMaintenanceState();
  const pressure = state?.pressure;
  const measured = state?.lastAt.pressure;
  if (pressure?.diskLevel !== 3 || measured === undefined || Date.now() - measured > WARNING_FRESH_MS) return;
  const disk = pressure.disk.map((volume) => `${(volume.freeMb / 1024).toFixed(1)} GB free on ${volume.volume}`);
  const acting =
    resolveMaintenanceSettings().mode === 'on'
      ? 'Automatic maintenance is stopping idle workspaces and deleting regenerable build outputs'
      : 'Automatic maintenance is not in on mode, so it deletes nothing';
  console.error(
    `Stim: disk pressure level 3 (${disk.join(', ')}). ${acting}; run \`stim status\` to see its plan, and free space outside Stim.`,
  );
}

export function triggerMaintenance(
  trigger: string,
  {
    argv = process.argv.slice(2),
    platform = process.platform,
    warn = true,
  }: { argv?: readonly string[]; platform?: NodeJS.Platform; warn?: boolean } = {},
): void {
  try {
    const env = process.env;
    if (
      ['guide', 'settings', 'help'].includes(argv[0] ?? '') ||
      argv.includes('--plan') ||
      (argv[0] === 'gc' && argv.includes('--delete')) ||
      argv.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg))
    )
      return;
    if (warn) warnCriticalDisk();
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
    try {
      stampAttempt(now);
    } catch {}
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
