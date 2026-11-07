import type { Invocation } from '../stimd/forwarded.ts';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { SpawnOptions } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StimContext } from '@stim-cli/core';
import type { StreamSpec } from '../stimd/logs/streams.ts';
import { operationState } from '../engine/operation-state.ts';
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
import { cancellableSleep, throwIfCancelled } from '../cancellation.ts';
import { windowsLauncherArgs } from '../detached-entry.ts';
import { ANDROID_LOCATION_VARIABLES } from '../devices/android-locations.ts';
import { endForSwitch, engineShim, ownStoreEngine, switchedEngine } from './engine-switch.ts';
import { getExecutor } from '../exec.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { daemonMode, spawnsDaemon } from './mode.ts';
import { systemdDaemonArgs } from './systemd-launch.ts';

const CONTACT_TIMEOUT_MS = 250;
const CLAIM_WAIT_MS = 5000;
const ATTACH_AFTER_MS = 2000;
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

function requireResolvedStimdHome(): void {
  const [claim] = readClaimSet(stimdClaimRoot()).unresolved;
  if (!claim) return;
  throw Object.assign(new Error(`The Stim daemon claim at ${claim.path} cannot be resolved (${claim.reason}).`), {
    code: 'STIM_CLAIM_UNAVAILABLE',
    remedy: `Check that the prior daemon and its children have stopped, then run ${claimRemoveCommand(claim.path)} and retry.`,
  });
}

async function admitExisting(
  held: Socket[] | undefined,
  command: string | undefined,
  knownAttached = false,
  invocation?: Invocation & { workspace?: string | null },
): Promise<void> {
  const attached =
    knownAttached || readClaimSet(stimdClaimRoot()).live.some((claim) => claim.details.attached === true);
  if (!(await admit(held, command, invocation)) && attached)
    throw Object.assign(new Error('The attached Stim daemon could not admit this command.'), {
      code: 'STIM_DAEMON_UNAVAILABLE',
      remedy: 'Wait for the command hosting stimd to finish and retry, or use a separate STIM_HOME.',
    });
}

let ownBuild: string | undefined;

/** This build's id: its dist's {@link stimBuildId}, or for a run from source, the source directory's hash. */
export function stimdBuildId(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return (ownBuild ??= stimBuildId(dir) ?? `src-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}`);
}

let refusedBuild: string | null = null;
let opSocket: Socket | null = null;
const opTokens = new WeakMap<Socket, string>();
let following: Promise<never> | null = null;
let admitting = false;
let socketError: string | null = null;
let refusedByAttached = false;
let attachedHost: import('../stimd/attached.ts').AttachedHost | null = null;

/** The code of the refusal of a command that can neither reach this home's stimd nor host one in its own process. */
export const SANDBOX_BLOCKED = 'STIM_SANDBOX_BLOCKED';

/** Whether `error` is the {@link SANDBOX_BLOCKED} refusal. */
export function isSandboxBlocked(error: unknown): error is Error {
  return error instanceof Error && 'code' in error && error.code === SANDBOX_BLOCKED;
}

function sandboxBlocked(path = stimdSocket()): Error {
  return Object.assign(
    new Error(
      `${path} is outside this sandbox's allowance; run Stim outside the sandbox or see stim guide errors sandbox`,
    ),
    { code: SANDBOX_BLOCKED },
  );
}

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
      if (message.op === 'engine-changed') refusedByAttached = message.attached === true;
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
  socket.once('error', (error: NodeJS.ErrnoException) => {
    socketError = error.code ?? null;
  });
  return socket;
}

/**
 * Sends one op to this home's stimd and resolves with its reply, or null when no stimd answers within `timeoutMs`.
 */
function askStimd(
  op: string,
  timeoutMs: number,
  fields: Record<string, unknown> = {},
  signal?: AbortSignal,
  onProgress?: (line: string) => void,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let socket: Socket | null = null;
    const finish = (reply: Record<string, unknown> | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      socket?.destroy();
      if (!following) resolve(reply);
    };
    const cancel = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      finish(null);
      return;
    }
    socket = openStimd([{ ...fields, op }], (reply) => {
      if (reply.op === 'progress' && typeof reply.line === 'string') onProgress?.(reply.line);
      else finish(reply);
    });
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
export function stimdEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
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

/** Whether a live stimd claim shows up within `waitMs`, checking again as soon as the started stimd exits. */
async function claimTaken(
  { settled, exited }: ReturnType<typeof launchStimd>,
  waitMs = CLAIM_WAIT_MS,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (stimdLive()) return true;
    if (exited() || Date.now() >= deadline) return stimdLive();
    await Promise.race([new Promise((done) => setTimeout(done, CLAIM_POLL_MS)), settled]);
  }
}

/**
 * Makes sure this home's stimd runs before a command creates running state: tells a live one about the contact so it
 * does not exit under the command, or starts one in the mode this command resolves, `STIM_DAEMON` included, and waits
 * for it to take its claim. When that detached stimd has not taken it within 2 s, a CLI command (not an API caller)
 * hosts stimd as its own child for its lifetime (`hostStimd`), and otherwise waits up to five seconds in all. Under
 * `daemon.mode` off it starts stimd for device logs when requested; otherwise a pinned command begins its op only
 * with a live stimd, such as the one `stim ci` hosts. Throws {@link SANDBOX_BLOCKED} when the sandbox denies this home's stimd socket. Returns whether a
 * stimd holds the home; an unresolvable daemon claim is reported and counts as held.
 */
export async function ensureStimd(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  pin = false,
  held?: Socket[],
  command?: string,
  allowAttached = true,
  invocation?: Invocation & { workspace?: string | null },
  requireForLogs = false,
): Promise<boolean> {
  if (pin) requireResolvedStimdHome();
  if (!spawnsDaemon(env) && !requireForLogs) {
    if (pin && stimdLive()) await admitExisting(held, command, false, invocation);
    return false;
  }
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
      else await admitExisting(held, command, false, invocation);
      return true;
    }
    let launched: ReturnType<typeof launchStimd>;
    try {
      launched = launchStimd(env, daemonMode(env), platform);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || (error.code !== 'EPERM' && error.code !== 'EACCES'))
        throw error;
      launched = { settled: Promise.resolve(), exited: () => true };
    }
    let taken = await claimTaken(launched, ATTACH_AFTER_MS);
    let attachedAttempt = false;
    if (!taken && !held && allowAttached && Reflect.get(globalThis, Symbol.for('stim.cli'))) {
      attachedAttempt = true;
      const { hostStimd } = await import('../stimd/attached.ts');
      const host = await hostStimd(env);
      if (host && typeof host === 'object' && 'refusal' in host)
        throw Object.assign(new Error(host.refusal.message), host.refusal);
      if (host === 'engine-unavailable')
        throw Object.assign(new Error('The selected Stim engine cannot be verified.'), {
          code: 'STIM_ENGINE_UNAVAILABLE',
          remedy: 'Run stim engine rollback or stim engine use to restore the engine pointer.',
        });
      if (host && typeof host === 'object' && 'switched' in host)
        (await import('./engine-switch.ts')).endForSwitch(host.switched);
      if (host && typeof host === 'object' && 'end' in host) attachedHost = host;
      taken = stimdLive() || (await claimTaken(launched, CLAIM_WAIT_MS - ATTACH_AFTER_MS));
      if ((host === 'blocked' || host === 'blocked-lock') && !taken) {
        const path =
          host === 'blocked-lock'
            ? (await import('../engine-store/locks.ts')).engineLockSocket(
                (await import('../engine-store/store.ts')).engineRoot(env),
              )
            : undefined;
        throw sandboxBlocked(path);
      }
    }
    taken ||= await claimTaken(launched, CLAIM_WAIT_MS - ATTACH_AFTER_MS);
    if (attachedAttempt && !taken)
      throw Object.assign(new Error('The attached Stim daemon could not take this home.'), {
        code: 'STIM_DAEMON_UNAVAILABLE',
        remedy: 'Retry the command; if the daemon still cannot start, run stim doctor.',
      });
    if (taken && pin) await admitExisting(held, command, attachedAttempt, invocation);
    return taken;
  } catch (error) {
    if (
      isSandboxBlocked(error) ||
      (error instanceof Error &&
        'code' in error &&
        (error.code === 'STIM_DAEMON_UNAVAILABLE' ||
          error.code === 'STIM_ENGINE_UNAVAILABLE' ||
          error.code === 'STIM_CLAIM_UNAVAILABLE' ||
          error.code === 'STIM_CLAIM_REFUSED'))
    )
      throw error;
    return false;
  } finally {
    admitting = false;
    delete process.env.STIM_REEXEC;
  }
}

/** Waits for this build's stimd to acknowledge a socket request or a sandbox to deny it. */
export async function waitForStimdHello(): Promise<'held' | 'held-attached' | 'blocked' | null> {
  for (const deadline = Date.now() + CLAIM_WAIT_MS; Date.now() < deadline;) {
    socketError = null;
    const reply = await askStimd('hello', CONTACT_TIMEOUT_MS);
    if (reply?.op === 'hello' && reply.build === stimdBuildId())
      return reply.attached === true ? 'held-attached' : 'held';
    if (socketError === 'EPERM' || socketError === 'EACCES') return 'blocked';
    await new Promise((done) => setTimeout(done, CLAIM_POLL_MS));
  }
  return null;
}

/** Whether a live persistent stimd can enforce a deferred simulator shutdown. */
export async function ensurePersistentStimd(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!(await ensureStimd(env, process.platform, false, undefined, undefined, false))) return false;
  const reply = await askStimd('hello', CONTACT_TIMEOUT_MS);
  return reply?.op === 'hello' && reply.attached !== true && reply.mode === 'on';
}

/**
 * Begins this command's op with the live stimd: again while it has its claim but does not listen yet (up to five
 * seconds), and once more after a stimd of this build replaced one of an older build that refused it, which an
 * attached stimd never does. Throws {@link SANDBOX_BLOCKED} when the sandbox denied the connection.
 */
async function admit(
  held: Socket[] | undefined,
  command: string | undefined,
  invocation?: Invocation & { workspace?: string | null },
): Promise<boolean> {
  for (const until = Date.now() + CLAIM_WAIT_MS; ;) {
    socketError = null;
    if (await beginOp(held, command, invocation)) return true;
    if (socketError === 'EPERM' || socketError === 'EACCES') throw sandboxBlocked();
    if (stimdRefused()) {
      if (!refusedByAttached && (await successorBound())) return beginOp(held, command, invocation);
      return false;
    }
    if ((socketError !== 'ENOENT' && socketError !== 'ECONNREFUSED') || Date.now() >= until) return false;
    await new Promise((done) => setTimeout(done, CLAIM_POLL_MS));
  }
}

/**
 * How to end the stimd this command hosts, if it hosts one: close this command's own op first, then wait for the
 * stimd to finish the other commands' ops (up to `daemon.attachedExitWaitSeconds`) and exit.
 */
export function attachedHostEnd(): (() => Promise<void>) | undefined {
  const host = attachedHost;
  if (!host) return undefined;
  return () => {
    attachedHost = null;
    opSocket?.destroy();
    return host.end();
  };
}

/**
 * Sends `op.begin` and keeps the connection open until this process exits, which is the op's `op.end`: until then
 * stimd counts the command's work as pinned, except while it waits at a build slot (`opWaiting`). With `held`, an API
 * operation's, the connection goes into it instead, and closing it ends the op. stimd answers at once, or after a
 * switch already under way, with `engine-changed`. False when it does not answer.
 */
function beginOp(
  held?: Socket[],
  command?: string,
  invocation?: Invocation & { workspace?: string | null },
  expectedInstance?: string | null,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (begun: boolean) => {
      if (settled || (following && !signal?.aborted)) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (begun) {
        if (held) held.push(socket);
        else opSocket = socket;
        socket.unref();
      } else socket.destroy();
      resolve(begun);
    };
    const timer = setTimeout(() => finish(false), OP_BEGIN_TIMEOUT_MS);
    const socket = openStimd([{ op: 'op.begin', ...(command ? { command } : {}), params: invocation }], (reply) => {
      if (reply.op === 'op.begun' && typeof reply.opToken === 'string') opTokens.set(socket, reply.opToken);
      finish(
        reply.op === 'op.begun' &&
          (expectedInstance === undefined ||
            (expectedInstance === null
              ? reply.attached !== true
              : reply.attached === true && reply.instance === expectedInstance)),
      );
    });
    const abort = () => finish(false);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    socket.once('close', () => {
      if (opSocket === socket) opSocket = null;
      finish(false);
    });
  });
}

export function admittedOpToken(held?: Socket[]): string | undefined {
  const socket = held?.[0] ?? opSocket;
  return socket ? opTokens.get(socket) : undefined;
}

export function operationToken(operation?: StimContext): string | undefined {
  const state = operationState(operation);
  return state.stimdOpToken ?? (!operation || state.takesSignals ? admittedOpToken() : undefined);
}

export function cancelCliOp(): void {
  opSocket?.destroy();
}

export async function acquireDeviceTicket(
  params: {
    root: string;
    platform: 'ios' | 'android';
    slot: string;
    id: string;
    deviceName: string | null;
    idLabel: string;
    waitSeconds: number;
    noWait: boolean;
    installBoundMs: number;
    appId: string | null;
  },
  operation: StimContext,
  warn: (line: string) => void,
): Promise<import('../engine/device-lease-run.ts').AcquireRunLeaseResult & { ticket?: string }> {
  const opToken = operationToken(operation);
  if (!opToken) throw new Error('the operation has no stimd connection');
  const prepared = await askStimd('lease.prepare', 10_000, { opToken, params }, operation.signal);
  throwIfCancelled(operation.signal, 'device lease wait');
  if (prepared?.op !== 'lease.prepared' || typeof prepared.ticket !== 'string')
    throw new Error(
      typeof prepared?.message === 'string' ? prepared.message : 'stimd did not prepare the device lease',
    );
  const ticket = prepared.ticket;
  const answer = await askStimd(
    'lease.acquire',
    params.waitSeconds * 1000 + 10_000,
    { opToken, params: { ticket } },
    operation.signal,
    warn,
  );
  throwIfCancelled(operation.signal, 'device lease wait');
  if (answer?.op !== 'lease.acquired' || !isJsonObject(answer.result))
    throw new Error(typeof answer?.message === 'string' ? answer.message : 'stimd did not acquire the device lease');
  return { ...(answer.result as import('../engine/device-lease-run.ts').AcquireRunLeaseResult), ticket };
}

export async function releaseDeviceTicket(ticket: string, operation: StimContext): Promise<void> {
  const opToken = operationToken(operation);
  if (!opToken) throw new Error('device lease operation is no longer admitted');
  const reply = await askStimd('lease.release', 10_000, { opToken, params: { ticket } });
  if (reply?.op !== 'lease.released') {
    throw new Error(typeof reply?.message === 'string' ? reply.message : 'stimd did not release the device lease');
  }
}

export async function checkPhysicalIosLog(operation?: StimContext): Promise<{ error: string; remedy: string } | null> {
  const reply = await askStimd('hello', CONTACT_TIMEOUT_MS, {}, operation?.signal);
  throwIfCancelled(operation?.signal, 'device log startup');
  if (reply?.op === 'hello' && reply.attached !== true) return null;
  return {
    error:
      reply?.attached === true
        ? 'A physical iOS console cannot use an attached stimd: devicectl ends the app when its console exits.'
        : 'Stim could not verify a persistent stimd for the physical iOS console.',
    remedy: 'Run `stim serve` in a foreground terminal, then retry.',
  };
}

export async function startDeviceLogStream(
  spec: StreamSpec,
  operation?: StimContext,
): Promise<{ streamId: string } | { error: string }> {
  throwIfCancelled(operation?.signal, 'device log startup');
  const opToken = operationToken(operation);
  if (!opToken) return { error: 'the operation has no stimd connection' };
  const reply = await askStimd('logs.start', 10_000, { opToken, params: spec }, operation?.signal);
  throwIfCancelled(operation?.signal, 'device log startup');
  if (reply?.op === 'logs.started' && typeof reply.streamId === 'string') return { streamId: reply.streamId };
  return { error: typeof reply?.message === 'string' ? reply.message : 'stimd did not start the device log stream' };
}

export async function stopDeviceLogStream(
  root: string,
  platform: string,
  slot: string,
  streamId: string,
  operation?: StimContext,
): Promise<{ stopped: boolean } | { error: string }> {
  throwIfCancelled(operation?.signal, 'device log cleanup');
  if (!stimdLive())
    await ensureStimd(operation?.env, process.platform, false, undefined, undefined, true, undefined, true);
  const reply = await askStimd('logs.stop', 10_000, { params: { root, platform, slot, streamId } }, operation?.signal);
  throwIfCancelled(operation?.signal, 'device log cleanup');
  if (reply?.op === 'logs.stopped' && typeof reply.stopped === 'boolean') return { stopped: reply.stopped };
  return { error: typeof reply?.message === 'string' ? reply.message : 'stimd did not stop the device log stream' };
}

export function deviceLogReadinessWait(
  root: string,
  platform: 'ios' | 'android',
  slot: string,
  streamId: string,
  since: number,
  operation?: StimContext,
): ((ms: number) => Promise<void>) & {
  coverage: () => 'pending' | 'covered' | 'failed';
  coverThrough: (at: number) => void;
} {
  let revision = 0;
  let through = 0;
  let coverage: 'pending' | 'covered' | 'failed' = 'pending';
  let sequence = 0;
  const wait = async (ms: number) => {
    const started = Date.now();
    const requestSequence = ++sequence;
    const requestThrough = through;
    const opToken = operationToken(operation);
    const timeoutMs = Math.min(30_000, Math.max(0, Math.ceil(ms)));
    const reply = opToken
      ? await askStimd(
          'readiness.wait',
          timeoutMs + 1000,
          {
            opToken,
            params: {
              root,
              platform,
              slot,
              streamId,
              since,
              through: requestThrough,
              checkCoverage: coverage === 'pending',
              after: revision,
              timeoutMs,
            },
          },
          operation?.signal,
        )
      : null;
    throwIfCancelled(operation?.signal, 'launch readiness check');
    if (reply?.op === 'readiness.changed' && typeof reply.revision === 'number') {
      revision = Math.max(revision, reply.revision);
      if (
        requestSequence === sequence &&
        requestThrough === through &&
        (reply.coverage === 'pending' || reply.coverage === 'covered' || reply.coverage === 'failed')
      )
        coverage = reply.coverage;
      if (reply.gone !== true) return;
    }
    if (requestSequence === sequence && requestThrough === through) coverage = 'failed';
    await cancellableSleep(Math.max(0, ms - (Date.now() - started)), {
      signal: operation?.signal,
      what: 'launch readiness check',
    });
  };
  return Object.assign(wait, {
    coverage: () => coverage,
    coverThrough: (at: number) => {
      if (at > through) {
        through = Math.ceil(at);
        if (coverage === 'covered') coverage = 'pending';
      }
    },
  });
}

/** Pins an already-running stimd until the returned closure is called. */
export async function holdExistingStimd(ownedInstance: string | null, signal?: AbortSignal): Promise<() => void> {
  const held: Socket[] = [];
  socketError = null;
  if (!(await beginOp(held, 'stim ci', undefined, ownedInstance, signal))) {
    signal?.throwIfAborted();
    if (socketError === 'EPERM' || socketError === 'EACCES') throw sandboxBlocked();
    throw new Error('Could not pin the Stim daemon for this CI job.');
  }
  return () => held.forEach((socket) => socket.destroy());
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
    invocation,
    deviceLogs = true,
  }: {
    cwd: string;
    recordUse: boolean;
    passes: boolean;
    pin?: boolean;
    held?: Socket[];
    invocation?: Invocation & { workspace?: string | null };
    deviceLogs?: boolean;
  } = {
    cwd: process.cwd(),
    recordUse: true,
    passes: true,
  },
): Promise<void> {
  const creates = DAEMON_COMMANDS.includes(name);
  const inline = passes && INLINE_COMMANDS.includes(name);
  if (!creates && !inline) return;
  if (creates && pin) requireResolvedStimdHome();
  const { commandWorkspace } = await import('./command-workspace.ts');
  const root = commandWorkspace(creates && recordUse, env, cwd);
  const taken =
    creates &&
    (await ensureStimd(
      env,
      process.platform,
      pin,
      held,
      `stim ${name}`,
      true,
      invocation && { ...invocation, workspace: root },
      deviceLogs && (name === 'ios' || name === 'android'),
    ));
  if ((taken && daemonMode(env) !== 'off') || !inline) return;
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
