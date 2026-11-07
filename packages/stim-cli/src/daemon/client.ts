import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { SpawnOptions } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PresencePublishParams } from '@stim-cli/core/protocol';
import {
  daemonClaimRoot,
  isJsonObject,
  SETTINGS,
  stimBuildId,
  readJsonObject,
  stimdClaimRoot,
  stimdRecordFile,
  stimdRunDir,
  stimdSocket,
  userHome,
  type DaemonMode,
} from '@stim-cli/core/state';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { cancellableSleep } from '../cancellation.ts';
import { windowsLauncherArgs } from '../detached-entry.ts';
import { ANDROID_LOCATION_VARIABLES } from '../devices/android-locations.ts';
import { endForSwitch, engineShim, ownStoreEngine, switchedEngine } from './engine-switch.ts';
import { getExecutor } from '../exec.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { daemonMode, spawnsDaemon } from './mode.ts';
import { systemdDaemonArgs } from './systemd-launch.ts';

const CONTACT_TIMEOUT_MS = 250;
const CLAIM_WAIT_MS = 5000;
const CLAIM_POLL_MS = 50;
const LAUNCH_TIMEOUT_MS = 5000;
const OP_BEGIN_TIMEOUT_MS = 30_000;
/** The label of the launchd job that runs a stimd, which it removes as it exits. */
export const LAUNCHD_LABEL_ENV = 'STIMD_LAUNCHD_LABEL';

/**
 * Whether a stimd, or a stim-daemon from Stim 1.40 to 1.42, holds this home's daemon claim. A claim Stim cannot resolve
 * counts as held, so nothing else takes an idle decision while it stands; `stim doctor` names the command that removes
 * it.
 */
export function daemonClaimHeld(): boolean {
  try {
    const survey = readClaimSet(daemonClaimRoot());
    return survey.live.length > 0 || survey.unresolved.length > 0;
  } catch {
    return true;
  }
}

/** Whether this home's stimd runs. */
export function stimdLive(): boolean {
  try {
    return readClaimSet(stimdClaimRoot()).live.length > 0;
  } catch {
    return false;
  }
}

let ownBuild: string | undefined;

/** This build's id: its dist's {@link stimBuildId}, or for a run from source, the source directory's hash. */
export function stimdBuildId(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return (ownBuild ??= stimBuildId(dir) ?? `src-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}`);
}

let refusedBuild: string | null = null;
let opSocket: Socket | null = null;
let following: Promise<never> | null = null;
let admitting = false;

/** Whether a stimd of another build refused this process's connection. */
export function stimdRefused(): boolean {
  return refusedBuild !== null;
}

/**
 * Follows the engine to `version` once stimd says it switched: a CLI admitting its command (`op.begin`) runs it again,
 * once, through the root's `bin/stim`, and resolves only by exiting with that run's code; a waiter ends with the rerun
 * line. Null otherwise, and in a process that is not a CLI, which then treats stimd as unreachable.
 */
function followSwitch(version: string, waiter: boolean): Promise<never> | null {
  // compat C26 permanent
  const engine = ownStoreEngine();
  if (!engine || !Reflect.get(globalThis, Symbol.for('stim.cli'))) return null;
  if (waiter || (admitting && process.env.STIM_REEXEC)) endForSwitch(version);
  if (!admitting) return null;
  console.error(`Stim updated to ${version}; running this command on it`);
  const options: SpawnOptions = { stdio: 'inherit', env: { ...process.env, STIM_REEXEC: '1' } };
  const child = getExecutor().spawn(engineShim(engine), process.argv.slice(2), options);
  return new Promise(() => child.once('exit', (code) => process.exit(code ?? 1)));
  // compat end
}

/**
 * Opens a connection to this home's stimd and sends `messages` after the first frame; `onMessage` gets every line
 * after stimd's answer to that frame. A stimd of another build answers `engine-changed` and closes the connection, as
 * does a stimd that relaunches on a new build; a `waiter` connection then ends the command (`followSwitch`).
 */
function openStimd(
  messages: Record<string, unknown>[],
  onMessage: (message: Record<string, unknown>) => void,
  waiter = false,
): Socket {
  const socket = connect(stimdSocket());
  let buffer = '';
  let answered = false;
  socket.setEncoding('utf8');
  socket.once('connect', () => {
    // compat C26 permanent
    const lines = [{ kind: 'cli', build: stimdBuildId() }, ...messages];
    // compat end
    socket.write(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  });
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      let message: unknown;
      try {
        message = JSON.parse(buffer.slice(0, end));
      } catch {
        message = {};
      }
      buffer = buffer.slice(end + 1);
      if (!isJsonObject(message)) continue;
      // compat C26 permanent
      if (message.op === 'engine-changed') {
        refusedBuild ??= String(message.build);
        const next = switchedEngine();
        if (next && next.build === message.build) following ??= followSwitch(next.version, waiter);
      }
      // compat end
      if (answered) onMessage(message);
      else answered = true;
    }
  });
  socket.once('error', () => {});
  return socket;
}

/**
 * Sends one op to this home's stimd and resolves with its reply, or null when no stimd answers within `timeoutMs`.
 */
function askStimd(
  op: string,
  timeoutMs: number,
  fields: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let socket: Socket | null = null;
    const finish = (reply: Record<string, unknown> | null) => {
      clearTimeout(timer);
      socket?.destroy();
      if (!following) resolve(reply);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket = openStimd([{ ...fields, op }], (reply) => finish(reply));
    socket.once('close', () => finish(null));
  });
}

/**
 * What stimd inherits from the command that starts it: where things are, `CI`, and the environment override of every
 * setting that is not sensitive, which then holds for its lifetime. Nothing else, so one command's credentials and
 * unrelated environment do not live on in it and its children.
 */
/** The environment variables stimd keeps from the command that starts it. */
export const STIMD_ENV: ReadonlySet<string> = new Set<string>([
  'PATH',
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'CI',
  'DEVELOPER_DIR',
  'JAVA_HOME',
  ...ANDROID_LOCATION_VARIABLES,
  'ANDROID_ADB_SERVER_PORT',
  'GRADLE_USER_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'AGENT_DEVICE_STATE_DIR',
  'AGENT_DEVICE_CLAIMS_DIR',
  'AGENT_DEVICE_IOS_RUNNER_LEASE_DIR',
  'STIM_HOME',
  'STIM_ENGINE_ROOT',
  'STIM_BUILD_CACHE',
  'STIM_METRO_CACHE',
  'STIM_TMPDIR',
  'SYSTEMROOT',
  'LOCALAPPDATA',
  'APPDATA',
  ...SETTINGS.flatMap((setting) => (setting.env && !setting.sensitive ? [setting.env] : [])),
]);

/** Windows environment names are case-insensitive, and `Path` and `SystemRoot` are their usual spelling there. */
function stimdEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && STIMD_ENV.has(platform === 'win32' ? name.toUpperCase() : name)) kept[name] = value;
  return kept;
}

const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The prefix of the labels of this home's stimd launchd jobs. */
export function launchdLabelPrefix(): string {
  return `dev.stim.stimd.${createHash('sha256').update(stimdRunDir()).digest('hex').slice(0, 12)}.`;
}

/**
 * Starts stimd as a transient job of the user's launchd domain, which a command runner that kills what a call started
 * cannot reach. launchd reads the job file only at bootstrap and keeps a job loaded after its process exits, so each
 * job has its own label, which stimd removes as it exits. `AbandonProcessGroup` leaves children such as an adb server
 * running when stimd exits, as they do outside launchd.
 */
function startLaunchdJob(command: readonly string[], env: Record<string, string>): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const label = `${launchdLabelPrefix()}${randomBytes(3).toString('hex')}`;
  const plist = join(stimdRunDir(), `${label}.plist`);
  const strings = (values: readonly string[]) => values.map((value) => `<string>${xml(value)}</string>`).join('');
  const environment = Object.entries({ ...env, [LAUNCHD_LABEL_ENV]: label })
    .map(([name, value]) => `<key>${xml(name)}</key><string>${xml(value)}</string>`)
    .join('');
  const log = xml(join(stimdRunDir(), 'stimd.log'));
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${strings(command)}</array><key>EnvironmentVariables</key><dict>${environment}</dict><key>WorkingDirectory</key><string>${xml(stimdRunDir())}</string><key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>AbandonProcessGroup</key><true/></dict></plist>\n`,
    { mode: 0o600 },
  );
  try {
    getExecutor().runFile('launchctl', ['bootstrap', `gui/${uid}`, plist], { timeoutMs: LAUNCH_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(plist, { force: true });
  }
}

/**
 * Asks the user's systemd manager to run stimd as a transient service, which a runner that kills everything a command
 * started cannot reach (#5084). False where that cannot be asked: no `systemd-run`, no user runtime directory, or
 * `systemd-run` fails because no user manager answers.
 */
function startSystemdService(
  env: NodeJS.ProcessEnv,
  command: readonly string[],
  kept: Record<string, string>,
): boolean {
  if (!env.XDG_RUNTIME_DIR) return false;
  const executor = getExecutor();
  const systemdRun = executor.findExecutable('systemd-run', { env });
  if (!systemdRun) return false;
  try {
    executor.runFile(systemdRun, systemdDaemonArgs(stimdRunDir(), kept, command), {
      timeoutMs: LAUNCH_TIMEOUT_MS,
      cwd: stimdRunDir(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Stim Host's launcher, when it is installed, so it becomes the macOS privacy-responsible process of stimd. */
function stimHost(env: NodeJS.ProcessEnv): string | null {
  for (const name of ['Stim Host', 'Stim Host Dev']) {
    const executable = join(userHome(env), 'Applications', `${name}.app`, 'Contents', 'MacOS', 'stim-host');
    if (existsSync(executable)) return executable;
  }
  return null;
}

/**
 * Starts this build's stimd, `<node> <dist>/cli.mjs __stimd --mode <mode>`: through a transient launchd job on macOS
 * (under `stim-host run` where Stim Host is installed) and a transient systemd user service on Linux where a user
 * manager answers, else as a detached process. `settled` resolves once a detached stimd exits; a job or service never
 * settles, so the caller polls for its claim.
 */
export function launchStimd(
  env: NodeJS.ProcessEnv,
  mode: DaemonMode,
  platform: NodeJS.Platform = process.platform,
  entry: string = spawnEntry('cli'),
  extra: readonly string[] = [],
): { settled: Promise<void>; exited: () => boolean } {
  mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
  const args = [entry, '__stimd', '--mode', mode, ...extra];
  const kept = stimdEnv(env, platform);
  const never = { settled: new Promise<void>(() => {}), exited: () => false };
  if (platform === 'darwin') {
    const host = stimHost(env);
    if (startLaunchdJob([...(host ? [host, 'run'] : []), process.execPath, ...args], kept)) return never;
  }
  if (platform === 'linux' && startSystemdService(env, [process.execPath, ...args], kept)) return never;
  const launcher =
    platform === 'win32'
      ? windowsLauncherArgs({
          entry,
          args: args.slice(1),
          cwd: stimdRunDir(),
          logFile: join(stimdRunDir(), 'stimd.log'),
        })
      : null;
  const child = getExecutor().spawn(launcher?.file ?? process.execPath, launcher?.args ?? args, {
    cwd: stimdRunDir(),
    detached: !launcher,
    stdio: 'ignore',
    env: { ...kept, ...launcher?.env },
    ...(launcher ? { windowsHide: true } : {}),
  });
  if (launcher) {
    child.on?.('error', () => {});
    return never;
  }
  let exited = false;
  const settled = new Promise<void>((done) => {
    const end = () => {
      exited = true;
      done();
    };
    child.once?.('exit', end);
    child.once?.('error', end);
  });
  child.unref?.();
  return { settled, exited: () => exited };
}

/** Whether a live stimd claim shows up within `CLAIM_WAIT_MS`, checking again as soon as the started stimd exits. */
async function claimTaken({ settled, exited }: ReturnType<typeof launchStimd>): Promise<boolean> {
  const deadline = Date.now() + CLAIM_WAIT_MS;
  for (;;) {
    if (stimdLive()) return true;
    if (exited() || Date.now() >= deadline) return stimdLive();
    await Promise.race([new Promise((done) => setTimeout(done, CLAIM_POLL_MS)), settled]);
  }
}

/**
 * Makes sure this home's stimd runs before a command creates running state: tells a live one about the contact so it
 * does not exit under the command, or starts one in the mode this command resolves, `STIM_DAEMON` included, and waits
 * up to five seconds for it to take its claim. Returns whether a stimd holds the home; an unresolvable daemon claim is
 * reported and counts as held.
 */
export async function ensureStimd(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  pin = false,
  held?: Socket[],
): Promise<boolean> {
  if (!spawnsDaemon(env)) return false;
  try {
    const [claim] = [...readClaimSet(daemonClaimRoot()).unresolved, ...readClaimSet(stimdClaimRoot()).unresolved];
    if (claim) {
      console.error(
        `Stim: the claim at ${claim.path} cannot be resolved (${claim.reason}), so no stimd decides idle in this Stim home. If no stimd or stim-daemon process runs, remove it with \`${claimRemoveCommand(claim.path)}\`.`,
      );
      return true;
    }
    admitting = pin && !held;
    if (stimdLive()) {
      if (!pin) await askStimd('hello', CONTACT_TIMEOUT_MS);
      else if (!(await beginOp(held)) && stimdRefused() && (await successorBound())) await beginOp(held);
      return true;
    }
    const taken = await claimTaken(launchStimd(env, daemonMode(env), platform));
    if (taken && pin) await beginOp(held);
    return taken;
  } catch {
    return false;
  } finally {
    admitting = false;
    delete process.env.STIM_REEXEC;
  }
}

/**
 * Sends `op.begin` and keeps the connection open until this process exits, which is the op's `op.end`: until then
 * stimd counts the command's work as pinned, except while it waits at a build slot (`opWaiting`). With `held`, an API
 * operation's, the connection goes into it instead, and closing it ends the op. stimd answers at once, or after a
 * switch already under way, with `engine-changed`. False when it does not answer.
 */
function beginOp(held?: Socket[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (begun: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (following) return;
      if (begun) {
        if (held) held.push(socket);
        else opSocket = socket;
        socket.unref();
      } else socket.destroy();
      resolve(begun);
    };
    const timer = setTimeout(() => finish(false), OP_BEGIN_TIMEOUT_MS);
    const socket = openStimd([{ op: 'op.begin' }], (reply) => finish(reply.op === 'op.begun'));
    socket.once('close', () => {
      if (opSocket === socket) opSocket = null;
      finish(false);
    });
  });
}

/** Whether a stimd of this build replaced, within `CLAIM_WAIT_MS`, the one of an older build that refused it. */
async function successorBound(): Promise<boolean> {
  for (const deadline = Date.now() + CLAIM_WAIT_MS; Date.now() < deadline;) {
    if (readJsonObject(stimdRecordFile())?.build === stimdBuildId()) {
      refusedBuild = null;
      return true;
    }
    await new Promise((done) => setTimeout(done, CLAIM_POLL_MS));
  }
  return false;
}

/** Tells stimd that this command's op waits at a build slot (`true`), so its work is not pinned, or runs again. */
export function opWaiting(waiting: boolean): void {
  opSocket?.write(`${JSON.stringify({ op: waiting ? 'op.wait' : 'op.resume' })}\n`);
}

const DAEMON_COMMANDS = ['start', 'ios', 'android', 'web', 'macos', 'revive'];
const INLINE_COMMANDS = ['doctor', 'start', 'ios', 'android'];

/**
 * Before a top-level command runs: commands that create running state record the use of their workspace (unless
 * `recordUse` is false, for an operation that records it itself) and make sure the home's stimd runs; unless `passes`
 * is false, `doctor`, `start`, `ios` and `android` run the in-process passes (maintenance, the activity pass over
 * workspaces with no dev server, the pressure ladder) when no stimd holds the home, never taking the command's own
 * workspace, the registered workspace containing `cwd`.
 */
export async function beforeCommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  {
    cwd,
    recordUse,
    passes,
    pin = false,
    held,
  }: { cwd: string; recordUse: boolean; passes: boolean; pin?: boolean; held?: Socket[] } = {
    cwd: process.cwd(),
    recordUse: true,
    passes: true,
  },
): Promise<void> {
  const creates = DAEMON_COMMANDS.includes(name);
  const inline = passes && INLINE_COMMANDS.includes(name);
  if (!creates && !inline) return;
  const { commandWorkspace } = await import('./command-workspace.ts');
  const root = commandWorkspace(creates && recordUse, env, cwd);
  const taken = creates && (await ensureStimd(env, process.platform, pin, held));
  if (taken || !inline) return;
  const { runPassesInProcess } = await import('./passes.ts');
  await runPassesInProcess(name, env, root);
}

function send(message: Record<string, unknown>): void {
  if (!stimdLive()) return;
  const socket = openStimd([message], () => socket.end());
  socket.setTimeout(CONTACT_TIMEOUT_MS, () => socket.destroy());
}

/**
 * Hands one agent action's presence to this home's stimd, which forwards it to the clients that show presence. Never
 * starts a stimd and never fails the action.
 */
export async function publishPresence(params: PresencePublishParams, timeoutMs: number): Promise<void> {
  if (stimdLive()) await askStimd('presence.publish', timeoutMs, { params });
}

const OBSERVE_MS = 30_000;

/**
 * Asks this home's stimd to observe what the op at `root` launched through `spawnOwned`: the owned Chrome's DevTools
 * session and the macOS app's output. Starts a stimd when none runs, whatever `daemon.mode` says, since nothing else
 * records that output. Resolves to null once stimd observes it, or to why it does not.
 */
export async function observeOwned(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!stimdLive() && !(await claimTaken(launchStimd(env, daemonMode(env))))) return 'no stimd runs in this Stim home';
  const ask = () => askStimd('logs.observe', OBSERVE_MS, { params: { root } });
  let reply = await ask();
  if (!reply && stimdRefused() && (await successorBound())) reply = await ask();
  if (reply?.op !== 'logs.observed')
    return stimdRefused()
      ? `this Stim home's stimd runs another Stim build (${refusedBuild}); run the command with that build`
      : 'stimd did not answer';
  return typeof reply.error === 'string' ? reply.error : null;
}

/** Whether the net thread serves, on which port, or why it does not. */
export type NetAnswer = { listening: true; port: number } | { listening: false; message: string };

const NET_START_MS = 60_000;

function netAnswer(reply: Record<string, unknown> | null): NetAnswer | null {
  if (reply?.op !== 'net') return null;
  return reply.listening === true && typeof reply.port === 'number'
    ? { listening: true, port: reply.port }
    : { listening: false, message: String(reply.message) };
}

/**
 * Asks this home's stimd to start its net thread, for a web share (`share`: loopback only, ending with its last share)
 * or a pairing. A web share starts a stimd first when none runs, whatever `daemon.mode` says; a pairing only where
 * `daemon.mode` lets commands start one. Null when no stimd answers.
 */
export async function ensureNet(share: boolean, env: NodeJS.ProcessEnv = process.env): Promise<NetAnswer | null> {
  if (!stimdLive() && (!(share || spawnsDaemon(env)) || !(await claimTaken(launchStimd(env, daemonMode(env))))))
    return null;
  return netAnswer(await askStimd('net.ensure', NET_START_MS, share ? { params: { share: true } } : {}));
}

/**
 * Asks the stimd that holds this home to start its net thread on `port`, for a `stim serve` that found one running, and
 * resolves once that stimd closes the connection. A net thread that already runs keeps its own port and options.
 */
export function serveThroughStimd(
  params: { port: number; loopbackOnly: boolean; extraEnv: string[]; pathPrepend: string[] },
  onAnswer: (answer: NetAnswer | null) => void,
): Promise<void> {
  return new Promise((done) => {
    const socket = openStimd([{ op: 'net.ensure', params }], (reply) => onAnswer(netAnswer(reply)));
    socket.once('close', () => done());
  });
}

/**
 * A connection to this home's net thread through stimd's CLI socket, past its `net.connected` answer, on which the
 * caller speaks stim-server's WebSocket protocol as a local client. Null when no stimd or no net thread answers.
 */
export function connectNet(timeoutMs: number): Promise<Socket | null> {
  if (!stimdLive()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = connect(stimdSocket());
    let buffer = Buffer.alloc(0);
    let lines = 0;
    const finish = (connected: boolean) => {
      clearTimeout(timer);
      socket.off('data', data);
      if (!connected) socket.destroy();
      resolve(connected ? socket : null);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
        let message: unknown;
        try {
          message = JSON.parse(buffer.subarray(0, end).toString('utf8'));
        } catch {}
        buffer = buffer.subarray(end + 1);
        if (++lines === 2) return finish(isJsonObject(message) && message.op === 'net.connected');
      }
    };
    socket.on('data', data);
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
    socket.once('connect', () => {
      // compat C26 permanent
      const first = { kind: 'cli', build: stimdBuildId() };
      // compat end
      socket.write(`${JSON.stringify(first)}\n${JSON.stringify({ op: 'net.connect' })}\n`);
    });
  });
}

export type DaemonResource = 'build' | 'boot';

const OPS: Record<DaemonResource, { wait: string; released: string; changed: string; what: string }> = {
  build: {
    wait: 'slot.wait',
    released: 'slot.released',
    changed: 'slot.changed',
    what: 'build slot',
  },
  boot: {
    wait: 'boot.wait',
    released: 'boot.released',
    changed: 'boot.changed',
    what: 'device boot',
  },
};

/** Tells a live stimd that this process released a build slot or finished a boot, so it wakes the oldest waiter. */
export function notifyReleased(resource: DaemonResource): void {
  send({ op: OPS[resource].released });
}

export interface DaemonWaiter {
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  close(): void;
}

/**
 * Subscribes once to stimd's releases of `resource` for one acquisition, so the oldest waiting run retries as soon as
 * one frees instead of on its next poll; a release that arrives while it is trying counts for its next wait. Without a
 * reachable stimd each wait is a plain sleep.
 */
export function daemonWaiter(resource: DaemonResource): DaemonWaiter {
  const ops = OPS[resource];
  let socket: Socket | null = null;
  let released = false;
  let wake: (() => void) | null = null;
  const subscribe = () => {
    if (socket || !stimdLive()) return;
    const opened = openStimd(
      [{ op: ops.wait }],
      (message) => {
        if (message.op !== ops.changed) return;
        released = true;
        wake?.();
      },
      true,
    );
    socket = opened;
    opened.once('close', () => {
      if (socket === opened) socket = null;
    });
  };
  return {
    async wait(ms, signal) {
      subscribe();
      if (released) {
        released = false;
        return;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      wake = abort;
      try {
        await cancellableSleep(ms, {
          signal: controller.signal,
          what: ops.what,
        });
      } catch (error) {
        if (signal?.aborted || !released) throw error;
      } finally {
        wake = null;
        signal?.removeEventListener('abort', abort);
        released = false;
      }
    },
    close() {
      socket?.destroy();
      socket = null;
    },
  };
}

const TICK_REPLY_TIMEOUT_MS = 10 * 60_000;
const START_WAIT_MS = 3000;

/** Asks stimd for one tick; false when it closes or fails without answering. */
function tickOnce(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (ticked: boolean) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      resolve(ticked);
    };
    const abort = () => finish(true);
    const timer = setTimeout(() => finish(true), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const socket = openStimd([{ op: 'tick' }], (message) => {
      if (message.op === 'ticked') finish(true);
    });
    socket.once('close', () => finish(false));
  });
}

/**
 * Asks this home's stimd for a tick now and waits for it to finish, waiting briefly for a stimd this command just
 * started. False when no stimd runs or it closes without answering, so the caller runs the passes itself.
 */
export async function requestDaemonTick(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<boolean> {
  if (!spawnsDaemon(env)) return false;
  for (let waited = 0; !stimdLive(); waited += 100) {
    if (waited >= START_WAIT_MS) return false;
    await cancellableSleep(100, { signal, what: 'stimd' });
  }
  return tickOnce(TICK_REPLY_TIMEOUT_MS, signal);
}
