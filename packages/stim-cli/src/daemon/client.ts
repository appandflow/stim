import { mkdirSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import {
  daemonClaimRoot,
  daemonDir,
  daemonHandoverClaimRoot,
  daemonSocket,
  isJsonObject,
  SETTINGS,
  type DaemonMode,
} from '@stim-cli/core/state';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { cancellableSleep } from '../cancellation.ts';
import { ANDROID_LOCATION_VARIABLES } from '../devices/android-locations.ts';
import { getExecutor } from '../exec.ts';
import { compareStimVersions } from '../diagnostics/stim-installations.ts';
import { spawnEntry, stimBuild } from '../spawn-entry.ts';
import { daemonMode, platformHasDaemon, spawnsDaemon } from './mode.ts';
import { systemdDaemonArgs } from './systemd-launch.ts';

const CONTACT_TIMEOUT_MS = 250;
const CLAIM_WAIT_MS = 5000;
const CLAIM_POLL_MS = 50;
const SYSTEMD_RUN_TIMEOUT_MS = 5000;
/**
 * Whether a stim-daemon holds this home's claim. A claim Stim cannot resolve counts as held, so nothing else takes
 * an idle decision while it stands; `stim doctor` names the command that removes it.
 */
export function daemonClaimHeld(): boolean {
  try {
    const survey = readClaimSet(daemonClaimRoot());
    return survey.live.length > 0 || survey.unresolved.length > 0;
  } catch {
    return true;
  }
}

function daemonLive(): boolean {
  try {
    return readClaimSet(daemonClaimRoot()).live.length > 0;
  } catch {
    return false;
  }
}

/** Whether a starting daemon is taking over this home from a running daemon of another build. */
function handoverInProgress(): boolean {
  try {
    return readClaimSet(daemonHandoverClaimRoot()).live.length > 0;
  } catch {
    return false;
  }
}

/**
 * Sends one op to this home's daemon and resolves with its first reply line, `{}` when that line is not a JSON
 * object, or null when the daemon closes, fails or stays silent for `timeoutMs`.
 */
export function askDaemon(
  op: string,
  timeoutMs: number,
  fields: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const socket = connect(daemonSocket());
    let done = false;
    let buffer = '';
    const finish = (reply: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('error', () => finish(null));
    socket.once('connect', () => socket.write(`${JSON.stringify({ ...fields, op })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const reply: unknown = JSON.parse(buffer.slice(0, end));
        finish(isJsonObject(reply) ? reply : {});
      } catch {
        finish({});
      }
    });
    socket.once('close', () => finish(null));
  });
}

/**
 * What the daemon inherits from the command that starts it: where things are, `CI`, and the environment override of
 * every setting that is not sensitive, which then holds for the daemon's lifetime. Nothing else, so one command's
 * credentials and unrelated environment do not live on in it and its children.
 */
const DAEMON_ENV = new Set<string>([
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
  'STIM_BUILD_CACHE',
  'STIM_METRO_CACHE',
  'STIM_TMPDIR',
  ...SETTINGS.flatMap((setting) => (setting.env && !setting.sensitive ? [setting.env] : [])),
]);

function daemonEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && DAEMON_ENV.has(name)) kept[name] = value;
  return kept;
}

/**
 * Asks the user's systemd manager to run the daemon as a transient service, which a runner that kills everything a
 * command started cannot reach (#5084). False where that cannot be asked: not Linux, no `systemd-run`, no user
 * runtime directory, or `systemd-run` fails because no user manager answers.
 */
function startDaemonService(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  command: readonly string[],
  daemonEnvironment: NodeJS.ProcessEnv,
): boolean {
  if (platform !== 'linux' || !env.XDG_RUNTIME_DIR) return false;
  const executor = getExecutor();
  const systemdRun = executor.findExecutable('systemd-run', { env });
  if (!systemdRun) return false;
  try {
    executor.runFile(systemdRun, systemdDaemonArgs(daemonDir(), daemonEnvironment, command), {
      timeoutMs: SYSTEMD_RUN_TIMEOUT_MS,
      cwd: daemonDir(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts a daemon; `settled` resolves once it has exited or failed to spawn. With `replace`, the daemon first asks
 * the running daemon with that pid to hand over after its current tick. Where a user systemd manager answers, the
 * daemon runs as its service and `settled` never resolves: `systemd-run` returns once the service starts, which says
 * nothing about the daemon, so the caller keeps polling for its claim.
 */
function spawnDaemon(
  env: NodeJS.ProcessEnv,
  mode: DaemonMode,
  replace: number | undefined,
  platform: NodeJS.Platform,
): { settled: Promise<void>; exited: () => boolean } {
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  const args = [
    spawnEntry('daemon-run'),
    '--mode',
    mode,
    ...(replace === undefined ? [] : ['--replace', String(replace)]),
  ];
  const kept = daemonEnv(env);
  if (startDaemonService(env, platform, [process.execPath, ...args], kept))
    return { settled: new Promise<void>(() => {}), exited: () => false };
  const child = getExecutor().spawn(process.execPath, args, {
    cwd: daemonDir(),
    detached: true,
    stdio: 'ignore',
    env: kept,
  });
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

/** Whether a live daemon claim shows up within `CLAIM_WAIT_MS`, checking again as soon as the started daemon exits. */
async function claimTaken({ settled, exited }: ReturnType<typeof spawnDaemon>): Promise<boolean> {
  const deadline = Date.now() + CLAIM_WAIT_MS;
  for (;;) {
    if (daemonLive()) return true;
    if (exited() || Date.now() >= deadline) return daemonLive();
    await Promise.race([new Promise((done) => setTimeout(done, CLAIM_POLL_MS)), settled]);
  }
}

/**
 * Waits up to `CLAIM_WAIT_MS` for the daemon taking over this home to take its claim. True once it does, and also
 * while the takeover still runs, so no command starts a daemon or runs the passes in its place meanwhile; false when
 * the takeover ended without a daemon.
 */
async function handoverSettled(): Promise<boolean> {
  const deadline = Date.now() + CLAIM_WAIT_MS;
  while (!daemonLive() && handoverInProgress() && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, CLAIM_POLL_MS));
  return daemonLive() || handoverInProgress();
}

/**
 * Makes sure this home's daemon runs before a command creates running state: tells a live one about the contact so
 * it does not exit under the command, or starts one in the mode this command resolves, `STIM_DAEMON` included, and
 * waits up to five seconds for it to take the claim. An installed build replaces a live daemon that reports no installed
 * build or an older Stim version: the daemon keeps serving the command while a new one from this build waits to take
 * over after its current tick. A development build never replaces a daemon, and no command starts a daemon while
 * one takes over. Returns whether a daemon holds the home; a claim Stim cannot resolve is reported
 * and counts as held.
 */
export async function ensureDaemon(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!spawnsDaemon(env, platform)) return false;
  const mode = daemonMode(env);
  try {
    const survey = readClaimSet(daemonClaimRoot());
    const [claim] = survey.unresolved;
    if (claim) {
      console.error(
        `Stim: the stim-daemon claim at ${claim.path} cannot be resolved (${claim.reason}), so no daemon decides idle in this Stim home. If no stim-daemon process runs, remove it with \`${claimRemoveCommand(claim.path)}\`.`,
      );
      return true;
    }
    const running = survey.live.length ? await askDaemon('hello', CONTACT_TIMEOUT_MS) : null;
    if (running) {
      const own = stimBuild();
      const older =
        typeof running.build !== 'string' ||
        (typeof running.version === 'string' && (compareStimVersions(own.version, running.version) ?? 0) > 0);
      if (own.installed && older && typeof running.pid === 'number' && !handoverInProgress())
        spawnDaemon(env, mode, running.pid, platform);
      return true;
    }
    if (handoverInProgress() && (await handoverSettled())) return true;
    return await claimTaken(spawnDaemon(env, mode, undefined, platform));
  } catch {
    return false;
  }
}

const DAEMON_COMMANDS = ['start', 'ios', 'android', 'web', 'macos', 'revive'];
const INLINE_COMMANDS = ['doctor', 'start', 'ios', 'android'];
/** Commands that never run the passes: `gc` runs its own, and `agent-device` runs once per UI action. */
const PASSLESS_COMMANDS = ['guide', 'settings', 'help', 'gc', 'agent-device'];

export type PassPlacement = 'inline' | 'background' | 'none';

/**
 * Where a top-level command runs the in-process passes when no daemon holds the home. `doctor`, `start`, `ios` and
 * `android` run them before the command; on a platform with no daemon every other command but `guide`, `settings`,
 * `help`, `gc` and `agent-device` starts them in a detached child, at most once a minute.
 */
export function passPlacement(name: string, platform: NodeJS.Platform = process.platform): PassPlacement {
  if (INLINE_COMMANDS.includes(name)) return 'inline';
  return !platformHasDaemon(platform) && !PASSLESS_COMMANDS.includes(name) ? 'background' : 'none';
}

/**
 * Before a top-level command runs: commands that create running state record the use of their workspace (unless
 * `recordUse` is false, for an operation that records it itself) and make sure the home's daemon runs; unless `passes`
 * is false, the commands `passPlacement` names run the in-process passes (maintenance, the activity pass over
 * workspaces with no dev server, the pressure ladder), never taking the command's own workspace, the registered
 * workspace containing `cwd`.
 */
export async function beforeCommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  { cwd, recordUse, passes }: { cwd: string; recordUse: boolean; passes: boolean } = {
    cwd: process.cwd(),
    recordUse: true,
    passes: true,
  },
): Promise<void> {
  const creates = DAEMON_COMMANDS.includes(name);
  const placement = passes ? passPlacement(name) : 'none';
  if (!creates && placement === 'none') return;
  const { commandWorkspace } = await import('./command-workspace.ts');
  const root = commandWorkspace(creates && recordUse, env, cwd);
  const held = creates && (await ensureDaemon(env));
  if (held || placement === 'none') return;
  if (placement === 'background') {
    const { spawnBackgroundPasses } = await import('./background.ts');
    spawnBackgroundPasses(name, env);
    return;
  }
  const { runPassesInProcess } = await import('./passes.ts');
  await runPassesInProcess(name, env, root);
}

function send(op: string): void {
  if (!daemonLive()) return;
  const socket = connect(daemonSocket());
  socket.setTimeout(CONTACT_TIMEOUT_MS, () => socket.destroy());
  socket.once('error', () => {});
  socket.once('connect', () => socket.end(`${JSON.stringify({ op })}\n`));
}

export type DaemonResource = 'build' | 'boot';

const OPS: Record<DaemonResource, { wait: string; released: string; changed: string; what: string }> = {
  build: { wait: 'slot.wait', released: 'slot.released', changed: 'slot.changed', what: 'build slot' },
  boot: { wait: 'boot.wait', released: 'boot.released', changed: 'boot.changed', what: 'device boot' },
};

/** Tells a live daemon that this process released a build slot or finished a boot, so it wakes the oldest waiter. */
export function notifyReleased(resource: DaemonResource): void {
  send(OPS[resource].released);
}

export interface DaemonWaiter {
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  close(): void;
}

/**
 * Subscribes once to the daemon's releases of `resource` for one acquisition, so the oldest waiting run retries as
 * soon as one frees instead of on its next poll; a release that arrives while it is trying counts for its next wait.
 * Without a reachable daemon each wait is a plain sleep.
 */
export function daemonWaiter(resource: DaemonResource): DaemonWaiter {
  const ops = OPS[resource];
  let socket: Socket | null = null;
  let released = false;
  let wake: (() => void) | null = null;
  const subscribe = () => {
    if (socket || !daemonLive()) return;
    const opened = connect(daemonSocket());
    socket = opened;
    opened.setEncoding('utf8');
    opened.once('connect', () => opened.write(`${JSON.stringify({ op: ops.wait })}\n`));
    opened.on('data', (chunk: string) => {
      if (!chunk.includes(`"${ops.changed}"`)) return;
      released = true;
      wake?.();
    });
    opened.once('error', () => {});
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
        await cancellableSleep(ms, { signal: controller.signal, what: ops.what });
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

/** Asks the daemon for one tick; false when it closes or fails without answering. */
function tickOnce(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(daemonSocket());
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
    socket.setEncoding('utf8');
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(answered));
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'tick' })}\n`));
    socket.on('data', (chunk: string) => {
      if (chunk.includes('"ticked"')) finish(true);
    });
  });
}

/**
 * Asks this home's daemon for a tick now and waits for it to finish, waiting briefly for a daemon this command just
 * started. A daemon that exits without answering, as one handing over to another build does, passes the request to
 * the daemon that holds or takes the claim next. False when no daemon runs, so the caller runs the passes itself.
 */
export async function requestDaemonTick(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<boolean> {
  if (!spawnsDaemon(env)) return false;
  const coming = () => daemonLive() || handoverInProgress();
  for (let waited = 0; !coming(); waited += 100) {
    if (waited >= START_WAIT_MS) return false;
    await cancellableSleep(100, { signal, what: 'stim-daemon' });
  }
  const deadline = Date.now() + TICK_REPLY_TIMEOUT_MS;
  for (;;) {
    if (await tickOnce(deadline - Date.now(), signal)) return true;
    if (!coming()) return false;
    try {
      await cancellableSleep(100, { signal, what: 'stim-daemon' });
    } catch {
      return true;
    }
  }
}
