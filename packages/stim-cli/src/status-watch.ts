import { type FSWatcher, readdirSync, watch } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { getExecutor } from './exec.ts';
import { androidToolPath } from './devices/android.ts';
import { easMachineStateRoot } from './engine/eas-session-ledger.ts';
import { parseSimctlList } from './devices/ios.ts';

export const WATCH_DEBOUNCE_MS = 250;
export const WATCH_FALLBACK_MS = 30_000;
export const WATCH_LOGS_INTERVAL_MS = 15_000;
const WATCH_SIMCTL_INTERVAL_MS = 2_000;
const ADB_RESTART_MIN_MS = 1_000;
const ADB_RESTART_MAX_MS = 60_000;
const SIMCTL_TIMEOUT_MS = 10_000;

export type RefreshKind = 'full' | 'logs';

export interface RefreshScheduler {
  trigger(kind?: RefreshKind, delayMs?: number): void;
  stop(): void;
}

/**
 * Coalesces change signals into refreshes: a burst of full triggers runs `run('full')` once after `debounceMs` of
 * quiet, at most one run is in flight, and a trigger that arrives during a run causes exactly one more run after it.
 * A `logs` trigger runs `run('logs')` no sooner than `debounceMs` from the trigger and `logsIntervalMs` from the start
 * of the previous run, unless a queued full run covers it; later log triggers do not postpone it.
 */
export function createRefreshScheduler({
  debounceMs,
  logsIntervalMs = 0,
  run,
}: {
  debounceMs: number;
  logsIntervalMs?: number;
  run: (kind: RefreshKind) => Promise<void>;
}): RefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queued: RefreshKind = 'full';
  let running = false;
  let pending: RefreshKind | null = null;
  let stopped = false;
  let lastRunAt = -Infinity;

  const fire = async () => {
    timer = null;
    running = true;
    lastRunAt = Date.now();
    try {
      await run(queued);
    } finally {
      running = false;
      if (pending) {
        const next = pending;
        pending = null;
        trigger(next);
      }
    }
  };

  function trigger(kind: RefreshKind = 'full', delayMs = debounceMs): void {
    if (stopped) return;
    if (running) {
      pending = pending === 'full' ? 'full' : kind;
      return;
    }
    if (kind === 'logs') {
      if (timer) return;
      queued = 'logs';
      timer = setTimeout(() => void fire(), Math.max(delayMs, lastRunAt + logsIntervalMs - Date.now()));
      return;
    }
    if (timer) clearTimeout(timer);
    queued = 'full';
    timer = setTimeout(() => void fire(), delayMs);
  }

  return {
    trigger,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

type WatchedDir = 'home' | 'workspaces' | 'workspace' | 'logs' | 'leases' | 'eas';

/**
 * Which refresh a change to `name` in a watched `$STIM_HOME` directory needs: `logs` for a log append, which can
 * change only the log-derived fields, `full` for anything else that can change the payload, null for none. A null
 * name means the platform did not report one.
 */
export function statusChange(dir: WatchedDir, name: string | null): RefreshKind | null {
  if (name?.includes('.lock')) return null;
  if (dir === 'logs') return 'logs';
  if (name === null) return 'full';
  switch (dir) {
    case 'home':
      return name.startsWith('config.json') || name === 'workspaces' || name === 'device-locks' ? 'full' : null;
    case 'workspace':
      return name.startsWith('state.json') || name === 'logs' ? 'full' : null;
    case 'eas':
      return name.startsWith('sessions.json') ? 'full' : null;
    default:
      return 'full';
  }
}

/** A stable summary of every simulator's state, or null when the listing is unreadable. */
function simulatorSignature(simctlJson: string): string | null {
  try {
    return parseSimctlList(simctlJson, { includeUnavailable: true })
      .map((sim) => `${sim.udid}:${sim.state}`)
      .toSorted()
      .join(',');
  } catch {
    return null;
  }
}

export interface StatusSources {
  /** Re-reads the workspace list and watches the directories that exist now. */
  reconcile(): void;
  stop(): void;
}

/**
 * Calls `onChange` when anything `stim status` reports may have changed:
 * `$STIM_HOME` files, adb device arrivals and departures, and simulator
 * state. simctl has no push API reachable from Node, so it is polled.
 */
export function watchStatusSources({
  home,
  onChange,
  platform = process.platform,
  simctlIntervalMs = WATCH_SIMCTL_INTERVAL_MS,
}: {
  home: string;
  onChange: (kind: RefreshKind) => void;
  platform?: NodeJS.Platform;
  simctlIntervalMs?: number;
}): StatusSources {
  let stopped = false;
  const watchers = new Map<string, FSWatcher>();

  const desiredDirs = (): Map<string, WatchedDir> => {
    const dirs = new Map<string, WatchedDir>([
      [home, 'home'],
      [join(home, 'workspaces'), 'workspaces'],
      [join(home, 'device-locks'), 'leases'],
      [easMachineStateRoot(), 'eas'],
    ]);
    let names: string[] = [];
    try {
      names = readdirSync(join(home, 'workspaces'));
    } catch {}
    for (const name of names) {
      const dir = join(home, 'workspaces', name);
      dirs.set(dir, 'workspace');
      dirs.set(join(dir, 'logs'), 'logs');
    }
    return dirs;
  };

  const reconcile = () => {
    if (stopped) return;
    const desired = desiredDirs();
    for (const [dir, watcher] of watchers) {
      if (!desired.has(dir)) {
        watcher.close();
        watchers.delete(dir);
      }
    }
    for (const [dir, kind] of desired) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, (_event, name) => {
          const change = statusChange(kind, name === null ? null : String(name));
          if (!change) return;
          if (kind === 'home' || kind === 'workspaces' || kind === 'workspace') reconcile();
          onChange(change);
        });
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch {}
    }
  };

  const adb = trackAdbDevices(() => onChange('full'));

  let simctl: ChildProcess | null = null;
  let simTimer: ReturnType<typeof setInterval> | null = null;
  if (platform === 'darwin') {
    let last: string | null = null;
    const check = () => {
      if (simctl || stopped) return;
      let out = '';
      const child = getExecutor().spawn('xcrun', ['simctl', 'list', 'devices', '--json'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: SIMCTL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      simctl = child;
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('error', () => {
        simctl = null;
      });
      child.on('close', () => {
        simctl = null;
        const signature = simulatorSignature(out);
        if (signature === null || stopped) return;
        if (last !== null && signature !== last) onChange('full');
        last = signature;
      });
    };
    check();
    simTimer = setInterval(check, simctlIntervalMs);
  }

  reconcile();

  return {
    reconcile,
    stop() {
      stopped = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      if (simTimer) clearInterval(simTimer);
      simctl?.kill('SIGKILL');
      adb.stop();
    },
  };
}

/**
 * Runs `adb track-devices` and calls `onChange` on every device list it
 * reports. adb exits when its server restarts, so the tracker restarts with a
 * doubling delay that resets once a run lasts a minute.
 */
function trackAdbDevices(onChange: () => void): { stop(): void } {
  const exec = getExecutor();
  const resolved = androidToolPath('adb');
  const adb = resolved === 'adb' ? exec.findExecutable('adb') : resolved;
  if (!adb) return { stop() {} };

  let child: ChildProcess | null = null;
  let restart: ReturnType<typeof setTimeout> | null = null;
  let delay = ADB_RESTART_MIN_MS;
  let stopped = false;

  const start = () => {
    restart = null;
    if (stopped) return;
    const startedAt = Date.now();
    const current = exec.spawn(adb, ['track-devices'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child = current;
    current.stdout?.on('data', () => onChange());
    current.on('error', () => {});
    current.on('close', () => {
      if (child === current) child = null;
      if (stopped) return;
      if (Date.now() - startedAt >= ADB_RESTART_MAX_MS) delay = ADB_RESTART_MIN_MS;
      restart = setTimeout(start, delay);
      delay = Math.min(delay * 2, ADB_RESTART_MAX_MS);
    });
  };
  start();

  return {
    stop() {
      stopped = true;
      if (restart) clearTimeout(restart);
      child?.kill('SIGTERM');
    },
  };
}
