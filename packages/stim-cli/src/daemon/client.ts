import { closeSync, mkdirSync, openSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import {
  coerceSettingText,
  daemonClaimRoot,
  daemonDir,
  daemonLogFile,
  daemonSocket,
  loadConfig,
  settingDefinition,
  settingValueError,
} from '@stim-cli/core/state';
import { claimRemoveCommand, readClaimSet } from '@stim-cli/core/ownership-claim';
import { cancellableSleep } from '../cancellation.ts';
import { getExecutor } from '../exec.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { MODE_COMMAND } from '../supervisor/state.ts';

const CONTACT_TIMEOUT_MS = 250;

/** `STIM_DAEMON` (1/true on, 0/false off), else the machine setting `daemon.enabled`. Windows has no daemon. */
export function daemonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform === 'win32') return false;
  const definition = settingDefinition('daemon.enabled');
  if (!definition?.env) return false;
  const raw = env[definition.env];
  if (raw !== undefined && raw !== '') {
    const value = coerceSettingText(definition, raw);
    return settingValueError(definition, value) === null && value === true;
  }
  try {
    return loadConfig()?.daemon?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Whether the daemon, rather than the workspace's supervisor, times a supervised workspace's idle stop: only when
 * the supervisor reports its bundle and HMR requests, so they reach the Metro log the daemon reads, and both idle
 * settings are on, so stopping the two together never overrides a 0.
 */
export function daemonOwnsSupervisedIdle({
  mode,
  hmrUpdates,
  idleStopMinutes,
  deviceIdleMinutes,
}: {
  mode: unknown;
  hmrUpdates: unknown;
  idleStopMinutes: number;
  deviceIdleMinutes: number;
}): boolean {
  return mode !== MODE_COMMAND && hmrUpdates === true && idleStopMinutes > 0 && deviceIdleMinutes > 0;
}

/** Whether this home's daemon holds its claim with a process proven alive. */
export function daemonLive(): boolean {
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

function spawnDaemon(env: NodeJS.ProcessEnv): void {
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  const fd = openSync(daemonLogFile(), 'a');
  try {
    const child = getExecutor().spawn(process.execPath, [spawnEntry('daemon-run')], {
      cwd: daemonDir(),
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
    });
    child.on?.('error', () => {});
    child.unref?.();
  } finally {
    closeSync(fd);
  }
}

/**
 * Makes sure this home's daemon runs before a command creates a resource: tells a live one about the contact so it
 * does not exit under the command, or starts one. Never blocks the command on the daemon: a claim Stim cannot
 * resolve is reported and the command goes on with the timers of its own processes.
 */
export async function ensureDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!daemonEnabled(env)) return;
  try {
    const survey = readClaimSet(daemonClaimRoot());
    const [claim] = survey.unresolved;
    if (claim) {
      console.error(
        `Stim: the home daemon's claim at ${claim.path} cannot be resolved (${claim.reason}); running without the daemon. If no stim-daemon process runs, remove it with \`${claimRemoveCommand(claim.path)}\`.`,
      );
      return;
    }
    if (survey.live.length && (await answersHello(CONTACT_TIMEOUT_MS))) return;
    spawnDaemon(env);
  } catch {}
}

/** Tells a live daemon that this process released a build slot, so it wakes the runs waiting for one. */
export function notifyBuildSlotReleased(): void {
  if (!daemonEnabled() || !daemonLive()) return;
  const socket = connect(daemonSocket());
  socket.setTimeout(CONTACT_TIMEOUT_MS, () => socket.destroy());
  socket.once('error', () => {});
  socket.once('connect', () => socket.end(`${JSON.stringify({ op: 'slot.released' })}\n`));
}

export interface BuildSlotWaiter {
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  close(): void;
}

/**
 * Subscribes once to the daemon's build-slot releases for one acquisition, so a waiting build retries as soon as a
 * slot frees instead of on its next poll; a release that arrives while it is trying counts for its next wait.
 * Without a reachable daemon each wait is a plain sleep.
 */
export function buildSlotWaiter(): BuildSlotWaiter {
  let socket: Socket | null = null;
  let released = false;
  let wake: (() => void) | null = null;
  const subscribe = () => {
    if (socket || !daemonEnabled() || !daemonLive()) return;
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
