import { quoteUnitWord } from '@stim-cli/core';
import { LABEL_VARIABLE } from '@stim-cli/core/state';
import {
  environmentValues,
  serverArguments,
  THROTTLE_SECONDS,
  type ServeRecord,
  type ServiceSpec,
} from './service-plist.ts';

export { LABEL_VARIABLE, parseSystemctlShow, parseUnit, SHOW_PROPERTIES } from '@stim-cli/core/state';

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
