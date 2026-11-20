import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isServiceLabel,
  LABEL_VARIABLE,
  parseInstalledPlist,
  parseUnit,
  readStimdService,
  type InstalledService,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';

const PLUTIL_TIMEOUT_MS = 5_000;
const SYSTEMCTL_TIMEOUT_MS = 5_000;
const LAUNCHCTL_TIMEOUT_MS = 5_000;

function installedUnit(label: string, platform: NodeJS.Platform): InstalledService | null {
  if (platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (!existsSync(plist)) return null;
    const json = getExecutor().runFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
      timeoutMs: PLUTIL_TIMEOUT_MS,
    });
    return parseInstalledPlist(JSON.parse(json));
  }
  const unit = join(homedir(), '.config', 'systemd', 'user', `${label}.service`);
  return existsSync(unit) ? parseUnit(readFileSync(unit, 'utf8')) : null;
}

/** The unit `stim service install` wrote that started this process, and whether its job runs the engine's shim. */
export interface ServiceJob {
  label: string;
  /** The job runs `<engineRoot>/bin/stimd`, so the service manager's next start of it runs the engine's current build. */
  followsEngine: boolean;
}

/**
 * The unit `stim service install` wrote for `port` that started this process, or null. launchd names the job a process
 * runs in `XPC_SERVICE_NAME`, and a systemd unit that install wrote sets `STIM_SERVICE_LABEL`; Task Scheduler gives
 * none.
 */
export function serviceJob(
  env: NodeJS.ProcessEnv,
  port: number,
  engineRoot: string | null,
  platform: NodeJS.Platform = process.platform,
): ServiceJob | null {
  const label = platform === 'darwin' ? env.XPC_SERVICE_NAME : platform === 'linux' ? env[LABEL_VARIABLE] : undefined;
  if (!label || !isServiceLabel(label)) return null;
  try {
    const installed = installedUnit(label, platform);
    if (installed?.managed !== true || installed.label !== label || installed.port !== port) return null;
    return { label, followsEngine: followsEngine(installed, engineRoot, platform) };
  } catch {
    return null;
  }
}

function followsEngine(installed: InstalledService, engineRoot: string | null, platform: NodeJS.Platform): boolean {
  return engineRoot !== null && runsShim(installed.script, engineRoot) && keepsChildren(installed.label, platform);
}

/**
 * The label of the service unit whose job is the only starter of the stimd of `home`, or null: `run/service.json` names
 * a unit `stim service install` wrote for that port and home, its job follows the engine (`serviceJob`), and the service
 * manager has the job loaded to restart it. A unit the user stopped is not started behind their back. Null in a process
 * whose environment names that unit, as the job's own does.
 */
export function deferringService(
  home: string,
  engineRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const record = platform === 'darwin' || platform === 'linux' ? readStimdService(home) : null;
  const own = platform === 'darwin' ? env.XPC_SERVICE_NAME : env[LABEL_VARIABLE];
  if (!record || !isServiceLabel(record.label) || record.label === own) return null;
  try {
    const installed = installedUnit(record.label, platform);
    if (
      installed?.managed !== true ||
      installed.label !== record.label ||
      installed.port !== record.port ||
      realpathSync(installed.stimHome || join(homedir(), '.stim')) !== realpathSync(home) ||
      !followsEngine(installed, engineRoot, platform)
    )
      return null;
    return restarts(record.label, platform) ? record.label : null;
  } catch {
    return null;
  }
}

function restarts(label: string, platform: NodeJS.Platform): boolean {
  if (platform === 'darwin') {
    getExecutor().runFile('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${label}`], {
      timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    });
    return true;
  }
  const shown = systemctl(['show', `${label}.service`, '-p', 'ActiveState', '-p', 'SubState']);
  const state = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(shown)?.[1]?.trim();
  return (
    state('ActiveState') === 'active' || (state('ActiveState') === 'activating' && state('SubState') === 'auto-restart')
  );
}

/**
 * Asks the service manager to start the job of `label` now: `launchctl kickstart` without `-k` leaves a running job
 * alone, and `systemctl start` also skips the `RestartSec` of a unit waiting to restart.
 */
export function startServiceJob(label: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin')
    getExecutor().runFile('launchctl', ['kickstart', `gui/${process.getuid?.() ?? 501}/${label}`], {
      timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    });
  else systemctl(['start', `${label}.service`]);
}

function systemctl(args: string[]): string {
  return getExecutor().runFile('systemctl', ['--user', ...args], {
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
    env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}` },
  });
}

/**
 * systemd kills a unit's whole cgroup when its main process exits unless the unit sets `KillMode=process`. The mode
 * systemd has loaded decides, drop-ins included, not the unit file, which can name a mode systemd has not loaded.
 */
function keepsChildren(label: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return true;
  try {
    return systemctl(['show', `${label}.service`, '-p', 'KillMode', '--value']).trim() === 'process';
  } catch {
    return false;
  }
}

function runsShim(script: string | null, engineRoot: string): boolean {
  try {
    return script !== null && realpathSync(script) === realpathSync(join(engineRoot, 'bin', 'stimd'));
  } catch {
    return false;
  }
}

/** The unit label a predecessor passed with `--unit-successor <label>`, or undefined. */
export function unitSuccessorLabel(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--unit-successor');
  const label = at >= 0 ? argv[at + 1] : undefined;
  return label && isServiceLabel(label) ? label : undefined;
}
