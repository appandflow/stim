import { homedir } from 'node:os';
import {
  loadConfig,
  machineSettingValue,
  readDaemonSnapshot,
  readDiscoveryCensusFile,
  readDiscoveryScanFile,
} from '@stim-cli/core/state';
import {
  AUTO_DISCOVER_KEY,
  DISCOVER_ROOTS_KEY,
  discoveryReport,
  lowDiskLine,
} from '../../workspace/discovery-report.ts';

const WARNING_FRESH_MS = 10 * 60_000;

/**
 * Warns on a command's stderr while the stim-daemon's last tick found the disk level critical, and, on a second line,
 * what the checkouts Stim does not fully manage hold when the daemon's cached census measured any. It reads the scan
 * file, the census file and the config, and walks nothing; a census it cannot read adds no line.
 */
export function warnCriticalDisk(argv: readonly string[] = process.argv.slice(2)): void {
  try {
    if (
      ['guide', 'settings', 'help'].includes(argv[0] ?? '') ||
      argv.includes('--plan') ||
      (argv[0] === 'gc' && !argv.includes('--dry-run')) ||
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
    const home = homedir();
    const config = loadConfig();
    const line = lowDiskLine(
      discoveryReport({
        scan: readDiscoveryScanFile(),
        census: readDiscoveryCensusFile(),
        setting: machineSettingValue(DISCOVER_ROOTS_KEY, { config, env: process.env }),
        autoDiscover: machineSettingValue(AUTO_DISCOVER_KEY, { config, env: process.env }).value === true,
        home,
        canonical: null,
      }),
      home,
    );
    if (line) console.error(line);
  } catch {}
}
