import { isJsonObject } from '@stim-cli/core/state';
import {
  environmentValues,
  installedService,
  serverArguments,
  THROTTLE_SECONDS,
  type InstalledService,
  type ServeRecord,
  type ServiceSpec,
} from './service-plist.ts';
import { LABEL_VARIABLE } from './service-unit.ts';

/**
 * The service file `install` writes on Windows: what the supervisor starts, read again by the supervisor each time it
 * starts the server. `managed` marks a file `install` wrote, so `install` and `uninstall` never touch another one.
 */
interface TaskFile {
  label: string;
  programArguments: string[];
  environment: Record<string, string>;
  workingDirectory: string;
  logPath: string;
  managed: boolean;
  servePort?: number;
  serveCreated?: boolean;
  previousScript?: string;
}

export function renderTask(spec: ServiceSpec): string {
  const environment: Record<string, string> = { ...spec.environment };
  for (const [name, value] of environmentValues(spec.env)) environment[name] = value;
  environment[LABEL_VARIABLE] = spec.label;
  const file: TaskFile = {
    label: spec.label,
    programArguments: [spec.node, spec.script, ...serverArguments(spec)],
    environment,
    workingDirectory: spec.workingDirectory,
    logPath: spec.logPath,
    managed: true,
    ...(spec.serve ? { servePort: spec.serve.port, serveCreated: spec.serve.created } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

const strings = (list: unknown[]) => list.filter((entry): entry is string => typeof entry === 'string');

/** The `TaskFile` in `text`, or null when it is not one `renderTask` wrote. */
function readTaskFile(text: string): TaskFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isJsonObject(value) || typeof value.label !== 'string' || !Array.isArray(value.programArguments)) return null;
  const environment: Record<string, string> = {};
  if (isJsonObject(value.environment)) {
    for (const [name, entry] of Object.entries(value.environment))
      if (typeof entry === 'string') environment[name] = entry;
  }
  return {
    label: value.label,
    programArguments: strings(value.programArguments),
    environment,
    workingDirectory: typeof value.workingDirectory === 'string' ? value.workingDirectory : '',
    logPath: typeof value.logPath === 'string' ? value.logPath : '',
    managed: value.managed === true,
    ...(typeof value.servePort === 'number' ? { servePort: value.servePort } : {}),
    ...(value.serveCreated === true ? { serveCreated: true } : {}),
    ...(typeof value.previousScript === 'string' ? { previousScript: value.previousScript } : {}),
  };
}

export function parseTask(text: string): InstalledService | null {
  const file = readTaskFile(text);
  if (!file) return null;
  return installedService({
    label: file.label,
    programArguments: file.programArguments,
    environment: file.environment,
    logPath: file.logPath || null,
    managed: file.managed,
    servePort: file.servePort ?? null,
    serveCreated: file.serveCreated === true,
    previousScript: file.previousScript ?? null,
  });
}

/** `text` with the server arguments and previous script, or the serve record, replaced. */
export function editTask(
  text: string,
  change: { programArguments: string[]; previousScript: string } | { serve: ServeRecord },
): string {
  const file = readTaskFile(text);
  if (!file) throw new Error('The service file is not one install wrote.');
  const edited: TaskFile =
    'serve' in change
      ? { ...file, servePort: change.serve.port, serveCreated: change.serve.created }
      : { ...file, programArguments: change.programArguments, previousScript: change.previousScript };
  return `${JSON.stringify(edited, null, 2)}\n`;
}

const xml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A command-line word as the Windows C runtime splits it: quoted, with backslashes before a quote doubled. */
export function windowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * The Task Scheduler definition that starts the supervisor `runner` with `node` at `user`'s logon. S4U runs it
 * without an interactive session, and a user registers it without elevation. Task Scheduler's restart-on-failure
 * reacts only to a task that fails to start, not to its process exiting, so the supervisor restarts the server.
 */
export function renderTaskXml(options: {
  label: string;
  user: string;
  node: string;
  runner: string;
  file: string;
  state: string;
  workingDirectory: string;
}): string {
  const args = [options.runner, options.file, options.state, String(THROTTLE_SECONDS)].map(windowsArgument).join(' ');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>stim-server (${xml(options.label)})</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(options.user)}</UserId></LogonTrigger></Triggers>`,
    '  <Principals><Principal id="Author">',
    `    <UserId>${xml(options.user)}</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel>`,
    '  </Principal></Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
    '    <Hidden>true</Hidden>',
    '  </Settings>',
    '  <Actions Context="Author"><Exec>',
    `    <Command>${xml(options.node)}</Command>`,
    `    <Arguments>${xml(args)}</Arguments>`,
    `    <WorkingDirectory>${xml(options.workingDirectory)}</WorkingDirectory>`,
    '  </Exec></Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}
