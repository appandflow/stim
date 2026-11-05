import { readDaemonSnapshot } from '@stim-cli/core/state';

const WARNING_FRESH_MS = 10 * 60_000;

/** Warns on a command's stderr while the stim-daemon's last tick found the disk level critical. */
export function warnCriticalDisk(argv: readonly string[] = process.argv.slice(2)): void {
  try {
    if (
      ['guide', 'settings', 'help'].includes(argv[0] ?? '') ||
      argv.includes('--plan') ||
      (argv[0] === 'gc' && argv.includes('--delete')) ||
      argv.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg))
    )
      return;
    const snapshot = readDaemonSnapshot();
    const measured = Date.parse(snapshot?.tickAt ?? '');
    if (snapshot?.pressure?.disk !== 'critical' || !(Date.now() - measured <= WARNING_FRESH_MS)) return;
    const acting =
      snapshot.mode === 'on'
        ? 'The stim-daemon is running its pressure ladder: idle workspaces, parked devices, caches and dormant devices first'
        : 'daemon.mode is report, so the stim-daemon deletes nothing';
    console.error(
      `Stim: disk pressure is critical (${snapshot.pressure.reasons.join('; ')}). ${acting}; run \`stim status\` to see it, and free space outside Stim.`,
    );
  } catch {}
}
