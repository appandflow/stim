import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unitWords } from '@stim-cli/core';
import {
  isServiceLabel,
  LABEL_VARIABLE,
  parseInstalledPlist,
  parseUnit,
  readStimdService,
  type InstalledService,
} from '@stim-cli/core/state';
import { readRecords } from '../engine-store/store.ts';
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

/** The service job that starts a home's stimd, and how long to wait for it to: its restart delay and a boot. */
export interface ServiceStarter {
  label: string;
  waitMs: number;
}

/** A stimd boot, with margin: the 45 s main's job record allowed on top of systemd's restart delay. */
const BOOT_MS = 45_000;

const RESTART_UNITS: Record<string, number> = { us: 1e-6, ms: 1e-3, min: 60, s: 1, h: 3600 };

/**
 * The service job that is the only starter of the stimd of `home`, or null: `run/service.json` names a unit `stim
 * service install` wrote for that port and home, its job follows the engine (`serviceJob`), the shim runs the build the
 * engine selected, and the service manager has the job loaded, with that home and shim, to restart it. A unit the user
 * stopped is not started behind their back. Null in a process whose environment names that unit, as the job's own does.
 */
export function deferringService(
  home: string,
  engineRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ServiceStarter | null {
  const record = platform === 'darwin' || platform === 'linux' ? readStimdService(home) : null;
  const own = platform === 'darwin' ? env.XPC_SERVICE_NAME : env[LABEL_VARIABLE];
  if (!record || !isServiceLabel(record.label) || record.label === own || engineRoot === null) return null;
  try {
    const installed = installedUnit(record.label, platform);
    if (
      installed?.managed !== true ||
      installed.label !== record.label ||
      installed.port !== record.port ||
      !sameHome(installed.stimHome, home) ||
      !followsEngine(installed, engineRoot, platform) ||
      !shimSelected(engineRoot)
    )
      return null;
    const waitMs = loadedRestartMs(record, home, engineRoot, platform);
    return waitMs === null ? null : { label: record.label, waitMs: waitMs + BOOT_MS };
  } catch {
    return null;
  }
}

const sameHome = (stimHome: string | null | undefined, home: string) =>
  realpathSync(stimHome || join(homedir(), '.stim')) === realpathSync(home);

/** Whether the engine's `bin/stimd` starts the build `current.json` selects; a promotion writes the shim second. */
function shimSelected(engineRoot: string): boolean {
  const current = readRecords(engineRoot).current?.dir;
  return (
    current !== undefined && readFileSync(join(engineRoot, 'bin', 'stimd'), 'utf8').includes(`/${current}/dist/cli.mjs`)
  );
}

/**
 * The restart delay of the job the service manager has loaded for `record` to restart, or null when it has none: launchd
 * starts a kicked job at once; systemd must have the unit active, or waiting to restart, with the record's home, port
 * and shim, drop-ins included, and a start it is asked for during `auto-restart` can wait out `RestartSec`.
 */
function loadedRestartMs(
  record: { label: string; port: number },
  home: string,
  engineRoot: string,
  platform: NodeJS.Platform,
): number | null {
  if (platform === 'darwin') {
    getExecutor().runFile('launchctl', ['print', `gui/${process.getuid?.() ?? 501}/${record.label}`], {
      timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    });
    return 0;
  }
  const properties = ['ActiveState', 'SubState', 'RestartUSec', 'Environment', 'ExecStart'];
  const shown = systemctl(['show', `${record.label}.service`, ...properties.flatMap((name) => ['-p', name])]);
  const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(shown)?.[1]?.trim() ?? '';
  const restarts =
    value('ActiveState') === 'active' ||
    (value('ActiveState') === 'activating' && value('SubState') === 'auto-restart');
  const environment = unitWords(value('Environment'), false) ?? [];
  const loadedHome = environment.find((entry) => entry.startsWith('STIM_HOME='))?.slice('STIM_HOME='.length);
  const path = /\bpath=(.*?) ; argv\[\]=/.exec(value('ExecStart'))?.[1];
  const argv = /argv\[\]=([^;]*)/.exec(value('ExecStart'))?.[1]?.trim().split(/\s+/) ?? [];
  if (
    !restarts ||
    !sameHome(loadedHome, home) ||
    path === undefined ||
    realpathSync(path) !== realpathSync(join(engineRoot, 'bin', 'stimd')) ||
    argv[argv.indexOf('--port') + 1] !== String(record.port)
  )
    return null;
  let seconds = 0;
  for (const [, amount, unit] of value('RestartUSec').matchAll(/([\d.]+)\s*(us|ms|min|s|h)?/g))
    seconds += Number(amount) * (RESTART_UNITS[unit ?? 's'] ?? 1);
  return Math.round(seconds * 1000);
}

/**
 * Asks the service manager to start the job of `label` now: `launchctl kickstart` without `-k` leaves a running job
 * alone; `systemctl start --no-block` returns at once, and before systemd 257 a unit waiting to restart still waits out
 * its `RestartSec`.
 */
export function startServiceJob(label: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin')
    getExecutor().runFile('launchctl', ['kickstart', `gui/${process.getuid?.() ?? 501}/${label}`], {
      timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    });
  else systemctl(['start', '--no-block', `${label}.service`]);
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
