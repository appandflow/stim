import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJsonObject } from '@stim-cli/core/state';
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
import type { SupervisorState } from './service-runner.ts';
import { editTask, parseTask, renderTask, renderTaskXml } from './service-task.ts';
import { installHostApp, type HostApp } from './stim-host.ts';

const MANAGER_TIMEOUT_MS = 15_000;
const SUPERVISOR_WAIT_MS = 30_000;

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
  cwd?: string,
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout, cwd, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
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
  name: 'launchd' | 'systemd' | 'taskscheduler';
  /** What the service is called in messages: "LaunchAgent", "systemd user service" or "scheduled task". */
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
  /** The launcher the server runs under, so macOS attributes its permissions to Stim Host; null elsewhere. */
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

const localAppData = () => process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
const taskName = (label: string) => `Stim\\${label}`;
const supervisorState = (label: string) => join(taskScheduler.root(label), 'supervisor.json');

/**
 * The supervisor's state while the task runs: the state file counts only when the pid it names is the process
 * Task Scheduler started for the task's running instance (its `EnginePID`), read through the Task Scheduler COM API.
 * `GetInstances(1)` includes hidden tasks.
 */
async function runningSupervisor(label: string): Promise<SupervisorState | null> {
  const task = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$s = New-Object -ComObject Schedule.Service; $s.Connect(); foreach ($i in $s.GetFolder('\\Stim').GetTask('${label}').GetInstances(1)) { $i.EnginePID }`,
  ]);
  const running = new Set(task.stdout.split(/\s+/).filter(Boolean).map(Number));
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(supervisorState(label), 'utf8'));
  } catch {
    return null;
  }
  if (!isJsonObject(value) || typeof value.supervisor !== 'number' || !running.has(value.supervisor)) return null;
  return {
    supervisor: value.supervisor,
    server: typeof value.server === 'number' ? value.server : null,
    runs: typeof value.runs === 'number' ? value.runs : 0,
    lastExitCode: typeof value.lastExitCode === 'string' ? value.lastExitCode : null,
  };
}

function serverAlive(pid: number | null): pid is number {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Starts `node args` so it outlives `stop`, which ends the supervisor's process tree with `taskkill /T`: the middle
 * process exits at once, and `taskkill /T` follows only live parents. This one waits for that process to exit.
 */
const ORPHAN =
  "const c=require('node:child_process').spawn(process.argv[1],process.argv.slice(2),{detached:true,stdio:['ignore',2,2],windowsHide:true});process.stdout.write(String(c.pid));c.unref();";
const WAIT = `const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(ORPHAN)},...process.argv.slice(1)],{stdio:['ignore','pipe','inherit'],windowsHide:true});const pid=Number(String(r.stdout));if(!pid)process.exit(1);const t=setInterval(()=>{try{process.kill(pid,0)}catch{clearInterval(t)}},1000);`;

const taskScheduler: ServiceManager = {
  name: 'taskscheduler',
  noun: 'scheduled task',
  file: (label) => join(localAppData(), 'Stim', 'services', `${label}.json`),
  logPath: (label) => join(localAppData(), 'Stim', 'Logs', `${label}.log`),
  root: (label) => join(localAppData(), 'Stim', 'services', label),
  async read(label, path = taskScheduler.file(label)) {
    if (!existsSync(path)) return null;
    return parseTask(readFileSync(path, 'utf8'));
  },
  async job(label) {
    const state = await runningSupervisor(label);
    if (!state) return null;
    return {
      state: 'running',
      pid: serverAlive(state.server) ? state.server : null,
      runs: state.runs,
      lastExitCode: state.lastExitCode,
    };
  },
  render: renderTask,
  async start(label) {
    const installed = await taskScheduler.read(label);
    const [node] = installed?.programArguments ?? [];
    if (!node) return { ok: false, stdout: '', stderr: `${taskScheduler.file(label)} names no server.` };
    const runner = join(taskScheduler.root(label), 'stim-service-runner.mjs');
    mkdirSync(taskScheduler.root(label), { recursive: true });
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'stim-service-runner.mjs'), runner);
    const whoami = await run('whoami', ['/user', '/fo', 'csv', '/nh']);
    const user = /"(S-1-[\d-]+)"\s*$/.exec(whoami.stdout.trim())?.[1];
    if (!user)
      return { ok: false, stdout: '', stderr: `whoami /user did not print this user's SID: ${whoami.stderr.trim()}` };
    const definition = `${taskScheduler.file(label)}.${process.pid}.xml`;
    writeFileSync(
      definition,
      `\ufeff${renderTaskXml({
        label,
        user,
        node,
        runner,
        file: taskScheduler.file(label),
        state: supervisorState(label),
        workingDirectory: homedir(),
      })}`,
      'utf16le',
    );
    rmSync(supervisorState(label), { force: true });
    try {
      const created = await run('schtasks', ['/Create', '/TN', taskName(label), '/XML', definition, '/F']);
      if (!created.ok) return created;
    } finally {
      rmSync(definition, { force: true });
    }
    const started = await run('schtasks', ['/Run', '/TN', taskName(label)]);
    if (!started.ok) return started;
    const deadline = Date.now() + SUPERVISOR_WAIT_MS;
    let observer: FSWatcher | undefined;
    let changed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const notify = () => {
      changed = true;
      wake?.();
    };
    try {
      try {
        observer = watch(taskScheduler.root(label), { persistent: false }, (_event, filename) => {
          if (filename === null || filename.toString() === 'supervisor.json') notify();
        });
        observer.once('error', () => {
          observer?.close();
          observer = undefined;
          notify();
        });
      } catch {}
      for (;;) {
        changed = false;
        if (await runningSupervisor(label)) return started;
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          return {
            ok: false,
            stdout: '',
            stderr: `${taskName(label)} did not start its supervisor within ${SUPERVISOR_WAIT_MS / 1000} s; see ${join(taskScheduler.root(label), 'supervisor.log')} and \`schtasks /Query /TN ${taskName(label)} /V /FO LIST\`.`,
          };
        if (changed) continue;
        await new Promise<void>((resolve) => {
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
          timer = setTimeout(wake, Math.min(remaining, observer ? 1000 : 250));
        });
      }
    } finally {
      clearTimeout(timer);
      observer?.close();
    }
  },
  async stop(label) {
    const state = await runningSupervisor(label);
    const killed = state ? await run('taskkill', ['/PID', String(state.supervisor), '/T', '/F']) : null;
    const ended = await run('schtasks', ['/End', '/TN', taskName(label)]);
    return killed ?? ended;
  },
  async remove(label) {
    const deleted = await run('schtasks', ['/Delete', '/TN', taskName(label), '/F']);
    if (!deleted.ok && (await run('schtasks', ['/Query', '/TN', taskName(label)])).ok)
      throw new ServiceError(`schtasks /Delete ${taskName(label)} failed: ${deleted.stderr.trim()}`);
    rmSync(taskScheduler.file(label), { force: true });
  },
  async rewrite(installed, staged, change) {
    writeFileSync(
      staged,
      editTask(
        readFileSync(staged, 'utf8'),
        'serve' in change
          ? change
          : { programArguments: argumentsWithScript(installed, change.script), previousScript: change.previousScript },
      ),
    );
  },
  restartRemedy: (label) => `run \`schtasks /Run /TN ${taskName(label)}\``,
  host: async () => null,
  sessionNotes: async () => [
    'The scheduled task starts stim-server when you log on to Windows and keeps it running after you sign out. After a reboot it starts at your next logon.',
  ],
  sessionProblem: async () => null,
  linger: async () => null,
  detached: (node, args) => ({ file: node, args: ['-e', WAIT, node, ...args] }),
  runningLabel: (env) => labelFrom(env[LABEL_VARIABLE]),
};

/** Where `service update` keeps server versions and its outcome for `label`. */
export const serviceRoot = (label: string): string =>
  (process.platform === 'linux' ? systemd : process.platform === 'win32' ? taskScheduler : launchd).root(label);

/** The service manager of this platform, or null where `stim-server service` does not run. */
export function serviceManagerOrNull(platform: NodeJS.Platform = process.platform): ServiceManager | null {
  return platform === 'darwin' ? launchd : platform === 'linux' ? systemd : platform === 'win32' ? taskScheduler : null;
}

export function serviceManager(): ServiceManager {
  const manager = serviceManagerOrNull();
  if (!manager) {
    throw new ServiceError(
      `stim-server service manages a launchd LaunchAgent on macOS, a systemd user service on Linux or a scheduled task on Windows, and does not run on ${process.platform}. On this system, start stim-server from your own service manager.`,
    );
  }
  return manager;
}
