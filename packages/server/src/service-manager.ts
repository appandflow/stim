import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  argumentsWithScript,
  parseInstalledPlist,
  parseLaunchctlPrint,
  renderPlist,
  ServiceError,
  validateLabel,
  type InstalledService,
  type ServeRecord,
  type ServiceSpec,
} from './service-plist.ts';
import {
  editUnit,
  LABEL_VARIABLE,
  parseSystemctlShow,
  parseUnit,
  renderUnit,
  SHOW_PROPERTIES,
} from './service-unit.ts';
import { installHostApp, type HostApp } from './stim-host.ts';

const MANAGER_TIMEOUT_MS = 15_000;

export interface Run {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeout: number = MANAGER_TIMEOUT_MS,
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr: stderr || (error ? error.message : '') }),
    );
  });
}

export interface ServiceJob {
  state: string;
  pid: number | null;
  runs: number | null;
  lastExitCode: string | null;
}

type ServiceChange = { script: string; previousScript: string } | { serve: ServeRecord };

/** What differs between running stim-server as a launchd LaunchAgent and as a systemd user unit. */
export interface ServiceManager {
  name: 'launchd' | 'systemd';
  /** What the service is called in messages: "LaunchAgent" or "systemd user service". */
  noun: string;
  file(label: string): string;
  logPath(label: string): string;
  root(label: string): string;
  /** The service `file` (or `path`) describes, or null when it does not exist. */
  read(label: string, path?: string): Promise<InstalledService | null>;
  /** The job the manager runs for `label`, or null when it runs none (launchd: not loaded; systemd: stopped). */
  job(label: string): Promise<ServiceJob | null>;
  render(spec: ServiceSpec): string;
  /** Starts the service from its file; the manager reads the file again first. */
  start(label: string): Promise<Run>;
  /** Asks the manager to stop the job; callers wait for it to go. */
  stop(label: string): Promise<Run>;
  /** Removes the stopped service's file and every registration of it. */
  remove(label: string): Promise<void>;
  /** Writes `change` into `staged`, a copy of the service file. */
  rewrite(installed: InstalledService, staged: string, change: ServiceChange): Promise<void>;
  /** The commands that start the service from its file by hand. */
  restartRemedy(label: string): string;
  /** The launcher the server runs under, so macOS attributes its permissions to Stim Host; null on Linux. */
  host(): Promise<HostApp | null>;
  /** How the service survives logout and reboot. */
  sessionNotes(): Promise<string[]>;
  /** Why this login cannot manage services, or null. */
  sessionProblem(): Promise<string | null>;
  /** Whether the service keeps running without a login: systemd's linger; null where it does not apply. */
  linger(): Promise<boolean | null>;
  /** The command that runs `node args` so it outlives a restart of the service that started it. */
  detached(node: string, args: string[]): { file: string; args: string[] };
  /** The label of the service this process runs as, from the variable the manager sets. */
  runningLabel(env: NodeJS.ProcessEnv): string | null;
}

const labelFrom = (value: string | undefined) => (value && !validateLabel(value) ? value : null);

const domain = () => `gui/${process.getuid?.() ?? 501}`;

const launchd: ServiceManager = {
  name: 'launchd',
  noun: 'LaunchAgent',
  file: (label) => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
  logPath: (label) => join(homedir(), 'Library', 'Logs', 'Stim', `${label}.log`),
  root: (label) => join(homedir(), 'Library', 'Application Support', 'Stim', 'services', label),
  async read(label, path = launchd.file(label)) {
    if (!existsSync(path)) return null;
    const converted = await run('plutil', ['-convert', 'json', '-o', '-', path]);
    if (!converted.ok)
      throw new ServiceError(
        `Could not read ${path} to check that install wrote it: ${converted.stderr.trim()}. Fix or remove the file, then run this again.`,
      );
    return parseInstalledPlist(JSON.parse(converted.stdout));
  },
  async job(label) {
    const printed = await run('launchctl', ['print', `${domain()}/${label}`]);
    if (printed.ok) return parseLaunchctlPrint(printed.stdout);
    if (/could not find service/i.test(printed.stderr)) return null;
    throw new ServiceError(`launchctl print ${label} failed: ${printed.stderr.trim()}`);
  },
  render: renderPlist,
  start: (label) => run('launchctl', ['bootstrap', domain(), launchd.file(label)]),
  stop: (label) => run('launchctl', ['bootout', `${domain()}/${label}`]),
  async remove(label) {
    rmSync(launchd.file(label), { force: true });
  },
  async rewrite(installed, staged, change) {
    const edits =
      'serve' in change
        ? [
            ['-replace', 'StimService.ServePort', '-integer', String(change.serve.port), staged],
            ['-replace', 'StimService.ServeCreated', '-bool', String(change.serve.created), staged],
          ]
        : [
            [
              '-replace',
              'ProgramArguments',
              '-json',
              JSON.stringify(argumentsWithScript(installed, change.script)),
              staged,
            ],
            ['-replace', 'StimService.PreviousScript', '-string', change.previousScript, staged],
          ];
    for (const args of edits) {
      const edited = await run('plutil', args);
      if (!edited.ok) throw new ServiceError(`plutil ${args.slice(0, 2).join(' ')} failed: ${edited.stderr.trim()}`);
    }
  },
  restartRemedy: (label) =>
    `run \`launchctl bootout ${domain()}/${label}\` and \`launchctl bootstrap ${domain()} ${launchd.file(label)}\``,
  host: installHostApp,
  sessionNotes: async () => [
    'The service runs in your GUI login session (gui/<uid>), so after a reboot it starts when you log in. On a headless Mac, turn on automatic login.',
  ],
  async sessionProblem() {
    const gui = await run('launchctl', ['print', domain()]);
    return gui.ok ? null : 'Log in to a GUI session on this Mac before running setup.';
  },
  linger: async () => null,
  detached: (node, args) => ({ file: node, args }),
  runningLabel: (env) => labelFrom(env.XPC_SERVICE_NAME),
};

const unit = (label: string) => `${label}.service`;

/** `systemctl --user` finds the user manager through `XDG_RUNTIME_DIR`, which a login without a session lacks. */
function userEnv(): NodeJS.ProcessEnv {
  return process.env.XDG_RUNTIME_DIR
    ? process.env
    : { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 1000}` };
}

const systemctl = (...args: string[]) => run('systemctl', ['--user', ...args], userEnv());

const lingerCommand = () => `sudo loginctl enable-linger ${userInfo().username}`;

function busProblem(stderr: string): string {
  return `systemctl --user cannot reach your systemd user manager (${stderr.trim()}). Log in to this machine over SSH or a desktop session, or run \`${lingerCommand()}\`, then run this again.`;
}

const systemd: ServiceManager = {
  name: 'systemd',
  noun: 'systemd user service',
  file: (label) => join(homedir(), '.config', 'systemd', 'user', unit(label)),
  logPath: (label) => join(homedir(), '.local', 'state', 'stim', `${label}.log`),
  root: (label) => join(homedir(), '.local', 'share', 'stim', 'services', label),
  async read(label, path = systemd.file(label)) {
    if (!existsSync(path)) return null;
    return parseUnit(readFileSync(path, 'utf8'));
  },
  async job(label) {
    const shown = await systemctl('show', unit(label), '-p', SHOW_PROPERTIES);
    if (!shown.ok) throw new ServiceError(busProblem(shown.stderr));
    return parseSystemctlShow(shown.stdout);
  },
  render: (spec) => renderUnit(spec),
  async start(label) {
    for (const args of [['daemon-reload'], ['enable', unit(label)]]) {
      const step = await systemctl(...args);
      if (!step.ok) return step;
    }
    return systemctl('start', unit(label));
  },
  stop: (label) => systemctl('stop', '--no-block', unit(label)),
  async remove(label) {
    const disabled = await systemctl('disable', unit(label));
    if (!disabled.ok)
      throw new ServiceError(`systemctl --user disable ${unit(label)} failed: ${disabled.stderr.trim()}`);
    rmSync(systemd.file(label), { force: true });
    await systemctl('daemon-reload');
    await systemctl('reset-failed', unit(label));
  },
  async rewrite(installed, staged, change) {
    const text = readFileSync(staged, 'utf8');
    writeFileSync(
      staged,
      editUnit(
        text,
        'serve' in change
          ? change
          : {
              programArguments: argumentsWithScript(installed, change.script),
              previousScript: change.previousScript,
            },
      ),
    );
  },
  restartRemedy: (label) => `run \`systemctl --user daemon-reload\` and \`systemctl --user restart ${unit(label)}\``,
  host: async () => null,
  async sessionNotes() {
    return (await systemd.linger())
      ? ['Linger is on for this user, so the service starts at boot and keeps running after you log out.']
      : [
          `The service runs in your systemd user manager, which stops when you log out. Run \`${lingerCommand()}\` so it starts at boot and keeps running.`,
        ];
  },
  async sessionProblem() {
    const shown = await systemctl('show-environment');
    return shown.ok ? null : busProblem(shown.stderr);
  },
  async linger() {
    const shown = await run('loginctl', ['show-user', userInfo().username, '-p', 'Linger', '--value']);
    return shown.ok && shown.stdout.trim() === 'yes';
  },
  detached: (node, args) => ({
    file: 'systemd-run',
    args: ['--user', '--scope', '--quiet', '--collect', '--', node, ...args],
  }),
  runningLabel: (env) => labelFrom(env[LABEL_VARIABLE]),
};

/** Where `service update` keeps server versions and its outcome for `label`: the launchd layout off Linux. */
export const serviceRoot = (label: string): string => (process.platform === 'linux' ? systemd : launchd).root(label);

/** The service manager of this platform, or null where `stim-server service` does not run. */
export function serviceManagerOrNull(platform: NodeJS.Platform = process.platform): ServiceManager | null {
  return platform === 'darwin' ? launchd : platform === 'linux' ? systemd : null;
}

export function serviceManager(): ServiceManager {
  const manager = serviceManagerOrNull();
  if (!manager) {
    throw new ServiceError(
      `stim-server service manages a launchd LaunchAgent on macOS or a systemd user service on Linux, and does not run on ${process.platform}. On this system, start stim-server from your own service manager.`,
    );
  }
  return manager;
}
