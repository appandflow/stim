import { quoteUnitWord, unitLines, unitWords } from '@stim-cli/core';
import {
  environmentValues,
  installedService,
  serverArguments,
  THROTTLE_SECONDS,
  type InstalledService,
  type ServeRecord,
  type ServiceSpec,
} from './service-plist.ts';

/** The variable a systemd unit sets so the server knows its own label; launchd sets `XPC_SERVICE_NAME` itself. */
export const LABEL_VARIABLE = 'STIM_SERVICE_LABEL';
const STOP_TIMEOUT_SECONDS = 30;

const execLine = (args: string[]) => `ExecStart=${args.map((arg) => quoteUnitWord(arg, true)).join(' ')}`;

/**
 * The systemd user unit for `spec`. The `[X-Stim]` section is inert to systemd, which ignores `X-` sections: it marks
 * the unit as one `install` wrote, so `install` and `uninstall` never touch another unit, and records the serve
 * route and the previous server script.
 */
export function renderUnit(spec: ServiceSpec, previousScript: string | null = null): string {
  const environment = new Map(Object.entries(spec.environment));
  for (const [name, value] of environmentValues(spec.env)) environment.set(name, value);
  environment.set(LABEL_VARIABLE, spec.label);
  const lines = [
    '# Written by `stim-server service install`; change it with `stim-server service`.',
    '[Unit]',
    `Description=stim-server (${spec.label})`,
    '',
    '[Service]',
    execLine([spec.node, spec.script, ...serverArguments(spec)]),
    ...[...environment].map(([name, value]) => `Environment=${quoteUnitWord(`${name}=${value}`, false)}`),
    'WorkingDirectory=%h',
    'Restart=always',
    `RestartSec=${THROTTLE_SECONDS}`,
    `TimeoutStopSec=${STOP_TIMEOUT_SECONDS}`,
    `StandardOutput=append:${spec.logPath.replace(/%/g, '%%')}`,
    'StandardError=inherit',
    '',
    '[X-Stim]',
    'Managed=true',
    ...(spec.serve ? [`ServePort=${spec.serve.port}`, `ServeCreated=${spec.serve.created}`] : []),
    ...(previousScript ? [`PreviousScript=${quoteUnitWord(previousScript, false)}`] : []),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

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

/** `text` with the server arguments and previous script, or the serve record, replaced; every other line kept. */
export function editUnit(
  text: string,
  change: { programArguments: string[]; previousScript: string } | { serve: ServeRecord },
): string {
  const replaced =
    'serve' in change
      ? { ServePort: String(change.serve.port), ServeCreated: String(change.serve.created) }
      : { PreviousScript: quoteUnitWord(change.previousScript, false) };
  let section = '';
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const header = /^\[(.+)\]$/.exec(trimmed)?.[1];
    if (header) section = header;
    const key = trimmed.slice(0, Math.max(0, trimmed.indexOf('='))).trim();
    if (section === 'Service' && key === 'ExecStart' && 'programArguments' in change) {
      out.push(execLine(change.programArguments));
    } else if (section === 'X-Stim' && key in replaced) {
      continue;
    } else {
      out.push(line);
      if (header && section === 'X-Stim') {
        for (const [name, value] of Object.entries(replaced)) out.push(`${name}=${value}`);
      }
    }
  }
  return out.join('\n');
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
