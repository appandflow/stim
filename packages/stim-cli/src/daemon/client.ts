import { mkdirSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { daemonClaimRoot, daemonDir, daemonSocket, SETTINGS, type DaemonMode } from '@stim-cli/core/state';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { cancellableSleep } from '../cancellation.ts';
import { ANDROID_LOCATION_VARIABLES } from '../devices/android-locations.ts';
import { getExecutor } from '../exec.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { daemonMode, platformHasDaemon, spawnsDaemon } from './mode.ts';

const CONTACT_TIMEOUT_MS = 250;
const CLAIM_WAIT_MS = 5000;
const CLAIM_POLL_MS = 50;
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

function answersHello(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(daemonSocket());
    let done = false;
    const finish = (answered: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('error', () => finish(false));
    socket.once('connect', () => socket.write(`${JSON.stringify({ op: 'hello' })}\n`));
    socket.on('data', (chunk: string) => {
      if (chunk.includes('\n')) finish(true);
    });
    socket.once('close', () => finish(false));
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

/** Starts a daemon; `settled` resolves once it has exited or failed to spawn. */
function spawnDaemon(env: NodeJS.ProcessEnv, mode: DaemonMode): { settled: Promise<void>; exited: () => boolean } {
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  const child = getExecutor().spawn(process.execPath, [spawnEntry('daemon-run'), '--mode', mode], {
    cwd: daemonDir(),
    detached: true,
    stdio: 'ignore',
    env: daemonEnv(env),
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
 * Makes sure this home's daemon runs before a command creates running state: tells a live one about the contact so
 * it does not exit under the command, or starts one in the mode this command resolves, `STIM_DAEMON` included, and
 * waits up to five seconds for it to take the claim. Returns whether a daemon holds the home; a claim Stim cannot
 * resolve is reported and counts as held.
 */
export async function ensureDaemon(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!spawnsDaemon(env)) return false;
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
    if (survey.live.length && (await answersHello(CONTACT_TIMEOUT_MS))) return true;
    return await claimTaken(spawnDaemon(env, mode));
  } catch {
    return false;
  }
}

const DAEMON_COMMANDS = ['start', 'ios', 'android', 'web', 'macos', 'revive'];
const PASS_COMMANDS = ['doctor', 'start', 'ios', 'android'];
const PASSLESS_COMMANDS = ['guide', 'settings', 'help', 'gc'];

/**
 * Before a top-level command runs: commands that create running state record the use of their workspace and make sure
 * the home's daemon runs; `doctor`, and `start`, `ios` and `android` when no daemon holds the home, run the in-process
 * passes (maintenance, the activity pass over workspaces with no dev server, the pressure ladder), never taking the
 * command's own workspace. On a platform with no daemon every command but `guide`, `settings`, `help` and `gc` does.
 */
export async function beforeCommand(name: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const creates = DAEMON_COMMANDS.includes(name);
  const runsPasses = PASS_COMMANDS.includes(name) || (!platformHasDaemon() && !PASSLESS_COMMANDS.includes(name));
  if (!creates && !runsPasses) return;
  const { commandWorkspace } = await import('./command-workspace.ts');
  const root = commandWorkspace(creates, env);
  const held = creates && (await ensureDaemon(env));
  if (held || !runsPasses) return;
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

/**
 * Asks this home's daemon for a tick now and waits for it to finish, waiting briefly for a daemon this command just
 * started. False when no daemon runs, so the caller runs the passes itself.
 */
export async function requestDaemonTick(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<boolean> {
  if (!spawnsDaemon(env)) return false;
  for (let waited = 0; !daemonLive(); waited += 100) {
    if (waited >= START_WAIT_MS) return false;
    await cancellableSleep(100, { signal, what: 'stim-daemon' });
  }
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
    const timer = setTimeout(() => finish(true), TICK_REPLY_TIMEOUT_MS);
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
