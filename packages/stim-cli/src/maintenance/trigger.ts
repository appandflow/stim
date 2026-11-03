import { readMaintenanceState } from '@stim-cli/core/state';
import { resolveMaintenanceSettings } from './settings.ts';

const WARNING_FRESH_MS = 10 * 60_000;

/** Warns on a command's stderr while the last measurement found disk pressure level 3. */
export function warnCriticalDisk(argv: readonly string[] = process.argv.slice(2)): void {
  try {
    if (
      ['guide', 'settings', 'help'].includes(argv[0] ?? '') ||
      argv.includes('--plan') ||
      (argv[0] === 'gc' && argv.includes('--delete')) ||
      argv.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg))
    )
      return;
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
  } catch {}
}
