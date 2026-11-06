import { join } from 'node:path';
import { configDir } from '../index.ts';
import { unitLines, unitWords } from '../systemd-unit.ts';
import { isJsonObject, readJsonObject } from './json-file.ts';

/** `tailscale serve` route a `stim-server service install --serve` recorded: its HTTPS port and who created it. */
export interface ServeRecord {
  port: number;
  /** Whether `service install` created the `tailscale serve` route, so `uninstall` removes it. */
  created: boolean;
}

export interface InstalledService {
  label: string;
  host: string | null;
  node: string | null;
  script: string | null;
  port: number | null;
  env: string[];
  pathPrepend: string[];
  stimHome: string | null;
  logPath: string | null;
  /** Whether `install` wrote this plist. */
  managed: boolean;
  serve: ServeRecord | null;
  /** The server script the job ran before `service update` or `service rollback` switched it. */
  previousScript: string | null;
  programArguments: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** What a job file records besides its arguments, read by `parseInstalledPlist` and `parseUnit`. */
export interface JobFields {
  label: string;
  programArguments: string[];
  environment: Record<string, unknown>;
  logPath: string | null;
  managed: boolean;
  servePort: unknown;
  serveCreated: boolean;
  previousScript: unknown;
}

export function installedService(job: JobFields): InstalledService {
  const { programArguments, environment } = job;
  const host =
    programArguments[1] === 'run' && programArguments[0]?.endsWith('/Contents/MacOS/stim-host')
      ? programArguments[0]
      : null;
  const [node = null, script = null, ...args] = host ? programArguments.slice(2) : programArguments;
  const env: string[] = [];
  const pathPrepend: string[] = [];
  let port: number | null = null;
  for (let index = args[0] === 'serve' && args[1] === '--service' ? 2 : 0; index < args.length; index += 2) {
    const flag = args[index];
    const next = args[index + 1];
    if (next === undefined) break;
    if (flag === '--port') port = Number(next);
    if (flag === '--env') {
      const stored = environment[next];
      if (next.includes('=')) env.push(next);
      else if (typeof stored === 'string') env.push(`${next}=${stored}`);
    }
    if (flag === '--path-prepend') pathPrepend.push(next);
  }
  const servePort = job.servePort;
  return {
    label: job.label,
    host,
    node,
    script,
    port: Number.isInteger(port) ? port : null,
    env,
    pathPrepend,
    stimHome: typeof environment.STIM_HOME === 'string' ? environment.STIM_HOME : null,
    logPath: job.logPath,
    managed: job.managed,
    serve:
      typeof servePort === 'number' && Number.isInteger(servePort)
        ? { port: servePort, created: job.serveCreated }
        : null,
    previousScript: typeof job.previousScript === 'string' ? job.previousScript : null,
    programArguments,
  };
}

/** Reads `plutil -convert json` output of a plist `renderPlist` wrote. */
export function parseInstalledPlist(value: unknown): InstalledService | null {
  if (!isJsonObject(value) || typeof value.Label !== 'string') return null;
  const meta = isJsonObject(value.StimService) ? value.StimService : {};
  return installedService({
    label: value.Label,
    programArguments: strings(value.ProgramArguments),
    environment: isJsonObject(value.EnvironmentVariables) ? value.EnvironmentVariables : {},
    logPath: typeof value.StandardOutPath === 'string' ? value.StandardOutPath : null,
    managed: meta.Managed === true,
    servePort: meta.ServePort,
    serveCreated: meta.ServeCreated === true,
    previousScript: meta.PreviousScript,
  });
}

export interface LaunchdJob {
  state: string;
  pid: number | null;
  runs: number | null;
  lastExitCode: string | null;
}

/** Reads the top-level fields of `launchctl print gui/<uid>/<label>`; nested `state =` lines are indented further. */
export function parseLaunchctlPrint(output: string): LaunchdJob {
  const field = (name: string) => new RegExp(`^\\t${name} = (.+)$`, 'm').exec(output)?.[1]?.trim() ?? null;
  const number = (name: string) => {
    const text = field(name);
    return text !== null && /^\d+$/.test(text) ? Number(text) : null;
  };
  return {
    state: field('state') ?? 'unknown',
    pid: number('pid'),
    runs: number('runs'),
    lastExitCode: field('last exit code'),
  };
}

/** The variable a systemd unit sets so the server knows its own label; launchd sets `XPC_SERVICE_NAME` itself. */
export const LABEL_VARIABLE = 'STIM_SERVICE_LABEL';

/** Reads a unit `renderUnit` wrote, or null when it has no `ExecStart=` and label in that form. */
export function parseUnit(text: string): InstalledService | null {
  const lines = unitLines(text);
  const value = (section: string, key: string) =>
    lines.findLast((line) => line.section === section && line.key === key)?.value ?? null;
  const exec = value('Service', 'ExecStart');
  const programArguments = exec === null ? null : unitWords(exec, true);
  const environment: Record<string, string> = {};
  for (const line of lines) {
    if (line.section !== 'Service' || line.key !== 'Environment') continue;
    for (const entry of unitWords(line.value, false) ?? []) {
      const equals = entry.indexOf('=');
      if (equals > 0) environment[entry.slice(0, equals)] = entry.slice(equals + 1);
    }
  }
  const label = environment[LABEL_VARIABLE];
  if (!programArguments || !label) return null;
  const output = value('Service', 'StandardOutput');
  const previous = value('X-Stim', 'PreviousScript');
  const servePort = value('X-Stim', 'ServePort');
  return installedService({
    label,
    programArguments,
    environment,
    logPath: output?.startsWith('append:') ? output.slice('append:'.length).replace(/%%/g, '%') : null,
    managed: value('X-Stim', 'Managed') === 'true',
    servePort: servePort !== null && /^\d+$/.test(servePort) ? Number(servePort) : null,
    serveCreated: value('X-Stim', 'ServeCreated') === 'true',
    previousScript: previous === null ? null : (unitWords(previous, false)?.[0] ?? null),
  });
}

/** A unit's state from `systemctl --user show -p <SHOW_PROPERTIES>`, or null when it is not loaded or not running. */
export interface UnitJob {
  state: string;
  pid: number | null;
  runs: number | null;
  lastExitCode: string | null;
}

export const SHOW_PROPERTIES = 'LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainCode,ExecMainStatus';

/**
 * Reads `systemctl show` output. A unit that is not loaded, or is inactive or failed, has no job, as launchd lists no
 * job after `bootout`. A unit waiting to restart after its server exited is a job with no pid and a last exit code.
 */
export function parseSystemctlShow(output: string): UnitJob | null {
  const fields = new Map<string, string>();
  for (const line of output.split('\n')) {
    const equals = line.indexOf('=');
    if (equals > 0) fields.set(line.slice(0, equals), line.slice(equals + 1).trim());
  }
  const active = fields.get('ActiveState');
  if (fields.get('LoadState') !== 'loaded' || !active || active === 'inactive' || active === 'failed') return null;
  const number = (name: string) => {
    const text = fields.get(name);
    return text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
  };
  const pid = number('MainPID');
  const restarts = number('NRestarts');
  const code = fields.get('ExecMainCode');
  const status = fields.get('ExecMainStatus');
  return {
    state: fields.get('SubState') ? `${active} (${fields.get('SubState')})` : active,
    pid: pid ? pid : null,
    runs: restarts === null ? null : restarts + 1,
    lastExitCode: code === '1' ? (status ?? null) : code === '2' || code === '3' ? `signal ${status}` : null,
  };
}

function clientCount(name: string): number {
  const devices = readJsonObject(join(configDir(), 'server', name))?.devices;
  return Array.isArray(devices) ? devices.length : 0;
}

/**
 * How many clients this Stim home's stim-server approved for builds and for hosted devices, counted from its
 * `build-clients.json` and `device-host-clients.json`. A file that is missing or unreadable counts none.
 */
export function readServerClientCounts(): { build: number; deviceHost: number } {
  return { build: clientCount('build-clients.json'), deviceHost: clientCount('device-host-clients.json') };
}

/** The System Settings pane names for the Screen Recording and device control grants on macOS `major`. */
export function permissionPanes(major: number): { screen: string; control: string } {
  return {
    screen: major >= 15 ? 'Screen & System Audio Recording' : 'Screen Recording',
    control: major >= 27 ? 'Device Control and Data Access' : 'Accessibility',
  };
}
