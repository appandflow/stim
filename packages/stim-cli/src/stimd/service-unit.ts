import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isServiceLabel,
  LABEL_VARIABLE,
  parseInstalledPlist,
  parseUnit,
  type InstalledService,
} from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';

const PLUTIL_TIMEOUT_MS = 5_000;
const SYSTEMCTL_TIMEOUT_MS = 5_000;

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
    return {
      label,
      followsEngine: engineRoot !== null && runsShim(installed.script, engineRoot) && keepsChildren(label, platform),
    };
  } catch {
    return null;
  }
}

/**
 * systemd kills a unit's whole cgroup when its main process exits unless the unit sets `KillMode=process`. The mode
 * systemd has loaded decides, drop-ins included, not the unit file, which can name a mode systemd has not loaded.
 */
function keepsChildren(label: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return true;
  try {
    const loaded = getExecutor().runFile(
      'systemctl',
      ['--user', 'show', `${label}.service`, '-p', 'KillMode', '--value'],
      {
        timeoutMs: SYSTEMCTL_TIMEOUT_MS,
        env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}` },
      },
    );
    return loaded.trim() === 'process';
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
