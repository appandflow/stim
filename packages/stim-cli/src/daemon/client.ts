import { mkdirSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import {
  daemonClaimRoot,
  daemonDir,
  daemonSocket,
  loadConfig,
  settingDefinition,
  type DaemonMode,
} from '@stim-cli/core/state';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { cancellableSleep } from '../cancellation.ts';
import { getExecutor } from '../exec.ts';
import { spawnEntry } from '../spawn-entry.ts';

const CONTACT_TIMEOUT_MS = 250;
const MODE = settingDefinition('daemon.mode');

const DAEMON_MODES: readonly DaemonMode[] = ['on', 'report', 'off'];

export function parseDaemonMode(value: unknown): DaemonMode | null {
  return DAEMON_MODES.find((mode) => mode === value) ?? null;
}

/** The machine setting `daemon.mode` alone, or null when it is unset or invalid. */
export function configuredDaemonMode(): DaemonMode | null {
  try {
    return parseDaemonMode(loadConfig()?.daemon?.mode);
  } catch {
    return null;
  }
}

/** Whichever of two modes acts less: off, then report, then on. */
export function stricterDaemonMode(a: DaemonMode, b: DaemonMode): DaemonMode {
  return DAEMON_MODES.indexOf(a) >= DAEMON_MODES.indexOf(b) ? a : b;
}

/** `daemon.mode` from `STIM_DAEMON` in `env`, else off in CI, else the machine setting, else on. Windows has none. */
export function daemonMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DaemonMode {
  if (platform === 'win32') return 'off';
  const fromEnv = MODE?.env ? parseDaemonMode(env[MODE.env]) : null;
  if (fromEnv) return fromEnv;
  if (env.CI) return 'off';
  return configuredDaemonMode() ?? 'on';
}

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

/** What the daemon inherits from the command that starts it: where things are, never a setting override. */
const DAEMON_ENV = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'DEVELOPER_DIR',
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_AVD_HOME',
  'ANDROID_USER_HOME',
  'ANDROID_EMULATOR_HOME',
  'XDG_CONFIG_HOME',
  'AGENT_DEVICE_STATE_DIR',
  'AGENT_DEVICE_CLAIMS_DIR',
  'AGENT_DEVICE_IOS_RUNNER_LEASE_DIR',
  'STIM_HOME',
  'STIM_BUILD_CACHE',
  'STIM_METRO_CACHE',
  'STIM_TMPDIR',
];

function spawnDaemon(env: NodeJS.ProcessEnv, mode: DaemonMode): void {
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  const daemonEnv: NodeJS.ProcessEnv = {};
  for (const name of DAEMON_ENV) if (env[name] !== undefined) daemonEnv[name] = env[name];
  const child = getExecutor().spawn(process.execPath, [spawnEntry('daemon-run'), '--mode', mode], {
    cwd: daemonDir(),
    detached: true,
    stdio: 'ignore',
    env: daemonEnv,
  });
  child.on?.('error', () => {});
  child.unref?.();
}

/**
 * Makes sure this home's daemon runs before a command creates running state: tells a live one about the contact so
 * it does not exit under the command, or starts one in the mode this command resolves, `STIM_DAEMON` included. Never
 * blocks the command on the daemon. Returns whether a daemon holds the home or was started; a claim Stim cannot
 * resolve is reported and counts as held.
 */
export async function ensureDaemon(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const mode = daemonMode(env);
  if (mode === 'off') return false;
  try {
    const survey = readClaimSet(daemonClaimRoot());
    const [claim] = survey.unresolved;
    if (claim) {
      console.error(
        `Stim: the stim-daemon claim at ${claim.path} cannot be resolved (${claim.reason}), so no daemon decides idle in this Stim home. If no stim-daemon process runs, remove it with \`${claimRemoveCommand(claim.path)}\`.`,
      );
      return;
    }
    if (survey.live.length && (await answersHello(CONTACT_TIMEOUT_MS))) return;
    spawnDaemon(env);
  } catch {}
}

function send(op: string): void {
  if (!daemonLive()) return;
  const socket = connect(daemonSocket());
  socket.setTimeout(CONTACT_TIMEOUT_MS, () => socket.destroy());
  socket.once('error', () => {});
  socket.once('connect', () => socket.end(`${JSON.stringify({ op })}\n`));
}

/** Tells a live daemon that this process released a build slot, so it wakes the oldest run waiting for one. */
export function notifyBuildSlotReleased(): void {
  send('slot.released');
}

export interface BuildSlotWaiter {
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  close(): void;
}

/**
 * Subscribes once to the daemon's build-slot releases for one acquisition, so the oldest waiting build retries as
 * soon as a slot frees instead of on its next poll; a release that arrives while it is trying counts for its next
 * wait. Without a reachable daemon each wait is a plain sleep.
 */
export function buildSlotWaiter(): BuildSlotWaiter {
  let socket: Socket | null = null;
  let released = false;
  let wake: (() => void) | null = null;
  const subscribe = () => {
    if (socket || !daemonLive()) return;
    const opened = connect(daemonSocket());
    socket = opened;
    opened.setEncoding('utf8');
    opened.once('connect', () => opened.write(`${JSON.stringify({ op: 'slot.wait' })}\n`));
    opened.on('data', (chunk: string) => {
      if (!chunk.includes('"slot.changed"')) return;
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
        await cancellableSleep(ms, { signal: controller.signal, what: 'build slot' });
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
