import { type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { MachineOwner, StatusPayload } from '@stim-cli/core/state';
import { getExecutor } from './exec.ts';
import { androidToolPath } from './devices/android.ts';
import { easMachineStateRoot } from './engine/eas-session-ledger.ts';
import { parseSimctlList } from './devices/ios.ts';
import { pidExists } from './metro.ts';

export const WATCH_DEBOUNCE_MS = 250;
export const WATCH_FALLBACK_MS = 30_000;
export const WATCH_LIGHT_INTERVAL_MS = 1_000;
export const WATCH_TABLES_INTERVAL_MS = 5_000;
export const WATCH_MACHINE_INTERVAL_MS = 15_000;
const WATCH_PROCESS_INTERVAL_MS = 2_000;
export const WATCH_MEMORY_STEP_MB = 16;
export const WATCH_CPU_STEP_PERCENT = 5;
const WATCH_SIMCTL_INTERVAL_MS = 30_000;
const ADB_RESTART_MIN_MS = 1_000;
const ADB_RESTART_MAX_MS = 60_000;
const SIMCTL_TIMEOUT_MS = 10_000;

export type RefreshKind = 'full' | 'light';

export interface RefreshScheduler {
  trigger(kind?: RefreshKind, delayMs?: number): void;
  stop(): void;
}

/**
 * Coalesces change signals into refreshes: a burst of full triggers runs `run('full')` once after `debounceMs` of
 * quiet, at most one run is in flight, and a trigger that arrives during a run causes exactly one more run after it.
 * A `light` trigger runs `run('light')` no sooner than `debounceMs` from the trigger and `lightIntervalMs` from the
 * start of the previous run, unless a queued full run covers it; later light triggers do not postpone it.
 */
export function createRefreshScheduler({
  debounceMs,
  lightIntervalMs = 0,
  run,
}: {
  debounceMs: number;
  lightIntervalMs?: number;
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
    if (kind === 'light') {
      if (timer) return;
      queued = 'light';
      timer = setTimeout(() => void fire(), Math.max(delayMs, lastRunAt + lightIntervalMs - Date.now()));
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

type WatchedDir = 'archive' | 'home' | 'workspaces' | 'workspace' | 'logs' | 'leases' | 'eas' | 'maintenance';

/**
 * Which refresh a change to `name` in a watched `$STIM_HOME` directory needs: `light` for a log append or a running
 * build's detail, which can change only the log-derived fields, `full` for anything else that can change the payload,
 * null for none. A null name means the platform did not report one.
 */
export function statusChange(dir: WatchedDir, name: string | null): RefreshKind | null {
  if (
    dir === 'archive' &&
    (name?.startsWith('.incoming-') || name?.startsWith('.removing-') || name?.startsWith('.lock'))
  )
    return null;
  if (name?.includes('.lock')) return null;
  if (dir === 'logs') return 'light';
  if (name === null) return 'full';
  switch (dir) {
    case 'home':
      if (name === 'maintenance') return 'light';
      return name.startsWith('config.json') || name === 'archive' || name === 'workspaces' || name === 'device-locks'
        ? 'full'
        : null;
    case 'workspace':
      if (name.startsWith('build-detail.json')) return 'light';
      return name.startsWith('state.json') || name.startsWith('ended-agents.json') || name === 'logs' ? 'full' : null;
    case 'maintenance':
      return name === 'state.json' ? 'light' : null;
    case 'eas':
      return name.startsWith('sessions.json') ? 'full' : null;
    default:
      return 'full';
  }
}

/**
 * Whether a change to `name`, relative to a repository's git common directory, can change a worktree's git summary:
 * its HEAD, index or a ref, in the main worktree or a linked one. Objects, logs and lock files cannot on their own.
 */
export function gitChange(name: string | null): boolean {
  if (name === null) return true;
  const path = name.replaceAll('\\', '/');
  if (path.endsWith('.lock')) return false;
  return (
    /^(HEAD|index|packed-refs|FETCH_HEAD)$/.test(path) ||
    path.startsWith('refs/') ||
    /^worktrees\/[^/]+(\/(HEAD|index))?$/.test(path) ||
    path === 'worktrees'
  );
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
  /** Watches these repositories' git common directories, and no others. */
  watchRepositories(commonDirs: readonly string[]): void;
  /** Reports a change when one of these processes exits; replaces the previous set. */
  watchProcesses(pids: readonly number[]): void;
  /**
   * The output of the last readable simulator listing, or null when that read started more than two safety poll
   * intervals ago, before the last Stim state write or before the last device set change: Stim creates, boots and
   * shuts down simulators as it writes state.
   */
  simulatorListing(): string | null;
  stop(): void;
}

const SIMULATOR_DIR = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * Calls `onChange` when anything `stim status` reports may have changed:
 * `$STIM_HOME` files, git HEADs, indexes and refs of the watched repositories,
 * exits of the watched processes, adb device arrivals and departures, and
 * simulator state. Process liveness is polled with a signal 0 that spawns
 * nothing. simctl has no push API reachable from Node, so a simulator change is
 * a write CoreSimulator makes in `deviceSet`: to `device_set.plist`, a device
 * directory, or a device's `device.plist`, which carries its state. A slow
 * simctl poll covers events FSEvents drops and a device set that cannot be watched.
 */
export function watchStatusSources({
  home,
  deviceSet,
  onChange,
  platform = process.platform,
  simctlIntervalMs = WATCH_SIMCTL_INTERVAL_MS,
}: {
  home: string;
  /** CoreSimulator's default device set, `~/Library/Developer/CoreSimulator/Devices` of the account. */
  deviceSet: string | null;
  onChange: (kind: RefreshKind) => void;
  platform?: NodeJS.Platform;
  simctlIntervalMs?: number;
}): StatusSources {
  let stopped = false;
  const watchers = new Map<string, FSWatcher>();

  const desiredDirs = (): Map<string, WatchedDir> => {
    const dirs = new Map<string, WatchedDir>([
      [home, 'home'],
      [join(home, 'archive'), 'archive'],
      [join(home, 'workspaces'), 'workspaces'],
      [join(home, 'maintenance'), 'maintenance'],
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
          if (kind === 'home' || kind === 'workspaces' || kind === 'workspace') {
            listingVersion++;
            reconcile();
          }
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

  const repositories = new Map<string, FSWatcher>();
  const watchRepositories = (commonDirs: readonly string[]) => {
    if (stopped) return;
    const wanted = new Set(commonDirs);
    for (const [dir, watcher] of repositories) {
      if (wanted.has(dir)) continue;
      watcher.close();
      repositories.delete(dir);
    }
    for (const dir of wanted) {
      if (repositories.has(dir)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, (_event, name) => {
          if (gitChange(name === null ? null : String(name))) onChange('full');
        });
        watcher.on('error', () => {
          watcher.close();
          repositories.delete(dir);
        });
        repositories.set(dir, watcher);
      } catch {}
    }
  };

  let processes: number[] = [];
  const processTimer = setInterval(() => {
    if (processes.some((pid) => !pidExists(pid))) {
      processes = [];
      onChange('full');
    }
  }, WATCH_PROCESS_INTERVAL_MS);
  processTimer.unref();

  const adb = trackAdbDevices(() => onChange('full'));

  let simctl: ChildProcess | null = null;
  let listing: { at: number; version: number; json: string } | null = null;
  let listingVersion = 0;
  let simTimer: ReturnType<typeof setInterval> | null = null;
  const deviceWatchers = new Map<string, FSWatcher>();
  if (platform === 'darwin' && deviceSet) {
    const changed = () => {
      listingVersion++;
      check();
      onChange('full');
    };
    const watchDir = (dir: string, listener: (name: string | null) => void) => {
      if (deviceWatchers.has(dir)) return;
      try {
        const watcher = watch(dir, (_event, name) => listener(name === null ? null : String(name)));
        watcher.on('error', () => {
          watcher.close();
          deviceWatchers.delete(dir);
        });
        deviceWatchers.set(dir, watcher);
      } catch {}
    };
    const watchDeviceSet = () => {
      if (stopped) return;
      let names: string[] | null = null;
      try {
        names = readdirSync(deviceSet);
      } catch {}
      const wanted = new Set<string>();
      if (names) {
        wanted.add(deviceSet);
        for (const name of names) if (SIMULATOR_DIR.test(name)) wanted.add(join(deviceSet, name));
      } else {
        let dir = dirname(deviceSet);
        while (dirname(dir) !== dir && !isDirectory(dir)) dir = dirname(dir);
        wanted.add(dir);
      }
      for (const [dir, watcher] of deviceWatchers) {
        if (wanted.has(dir)) continue;
        watcher.close();
        deviceWatchers.delete(dir);
      }
      for (const dir of wanted) {
        if (dir === deviceSet) {
          watchDir(dir, () => {
            watchDeviceSet();
            changed();
          });
        } else if (dirname(dir) === deviceSet) {
          watchDir(dir, (name) => {
            if (name === null || name === 'device.plist') changed();
          });
        } else {
          watchDir(dir, () => {
            watchDeviceSet();
            if (deviceWatchers.has(deviceSet)) changed();
          });
        }
      }
    };

    let last: string | null = null;
    const check = () => {
      watchDeviceSet();
      if (simctl || stopped) return;
      const startedAt = Date.now();
      const version = listingVersion;
      let out = '';
      const child = getExecutor().spawn('xcrun', ['simctl', 'list', 'devices', '--json'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: SIMCTL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      simctl = child;
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('error', () => {});
      child.on('close', () => {
        simctl = null;
        if (stopped) return;
        if (version !== listingVersion) {
          check();
          return;
        }
        const signature = simulatorSignature(out);
        if (signature === null) return;
        const wasStale = listing?.version !== version;
        listing = { at: startedAt, version, json: out };
        if (last !== null && (signature !== last || wasStale)) onChange('full');
        last = signature;
      });
    };
    check();
    simTimer = setInterval(check, simctlIntervalMs);
  }

  reconcile();

  return {
    reconcile,
    watchRepositories,
    watchProcesses(pids) {
      processes = [...new Set(pids)];
    },
    simulatorListing: () =>
      listing && listing.version === listingVersion && Date.now() - listing.at <= 2 * simctlIntervalMs
        ? listing.json
        : null,
    stop() {
      stopped = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      for (const watcher of repositories.values()) watcher.close();
      repositories.clear();
      clearInterval(processTimer);
      if (simTimer) clearInterval(simTimer);
      for (const watcher of deviceWatchers.values()) watcher.close();
      deviceWatchers.clear();
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function ownerKey(owner: MachineOwner): string {
  return JSON.stringify([owner.kind, owner.name, owner.workspace, owner.slot ?? null, owner.id, owner.owned]);
}

function ownerSteady(before: MachineOwner, after: MachineOwner): boolean {
  return (
    Math.abs(after.cpuPercent - before.cpuPercent) < WATCH_CPU_STEP_PERCENT &&
    Math.abs(after.memoryMb - before.memoryMb) < WATCH_MEMORY_STEP_MB
  );
}

/**
 * The payload `status --watch --json` prints. A usage figure keeps its value from the `previous` printed payload until it moves by a step: an owner's `cpuPercent`
 * and `memoryMb`, an environment's `memoryMb` and `capacity.committedMb`. An owner's row is kept whole, `residentMb`
 * and `processes` included, until one of its two figures moves, so a Mac whose processes only jitter prints no new line.
 */
export function watchPayload(previous: StatusPayload | null, next: StatusPayload): StatusPayload {
  const payload: StatusPayload = { ...next };
  if (!previous) return payload;

  if (previous.machine && next.machine && previous.machine.memorySource === next.machine.memorySource) {
    const before = new Map(previous.machine.owners.map((owner) => [ownerKey(owner), owner]));
    payload.machine = {
      ...next.machine,
      owners: next.machine.owners.map((owner) => {
        const old = before.get(ownerKey(owner));
        return old && ownerSteady(old, owner) ? old : owner;
      }),
    };
  }

  const memory = new Map(previous.environments.map((env) => [env.path, env]));
  payload.environments = payload.environments.map((env) => {
    const old = memory.get(env.path);
    return old && old.memorySource === env.memorySource && Math.abs(env.memoryMb - old.memoryMb) < WATCH_MEMORY_STEP_MB
      ? { ...env, memoryMb: old.memoryMb }
      : env;
  });

  const { capacity } = previous;
  if (
    capacity.overCapacity === next.capacity.overCapacity &&
    capacity.liveCount === next.capacity.liveCount &&
    capacity.totalMemoryMb === next.capacity.totalMemoryMb &&
    Math.abs(next.capacity.committedMb - capacity.committedMb) < WATCH_MEMORY_STEP_MB
  ) {
    payload.capacity = capacity;
  }
  return payload;
}

const holdPullRequest = <T extends { pullRequest?: { checkedAt: string } | null }>(worktree: T): T =>
  worktree.pullRequest ? { ...worktree, pullRequest: { ...worktree.pullRequest, checkedAt: '' } } : worktree;

/**
 * The string `status --watch --json` compares to decide whether a line is new. It is the payload with the bookkeeping
 * timestamps masked: each `pullRequest.checkedAt`, `maintenance.lastChecks`, `maintenance.lastPass.startedAt` and
 * `durationMs`, and `maintenance.running.startedAt`. A change in only those fields prints no line; any printed line
 * carries the current values.
 */
export function watchChangeKey(payload: StatusPayload): string {
  const { maintenance } = payload;
  return JSON.stringify({
    ...payload,
    environments: payload.environments.map((env) =>
      env.worktree ? { ...env, worktree: holdPullRequest(env.worktree) } : env,
    ),
    unprovisionedWorktrees: payload.unprovisionedWorktrees.map(holdPullRequest),
    maintenance: maintenance && {
      ...maintenance,
      lastChecks: { pressure: null, size: null, worktree: null, sweep: null },
      lastPass: maintenance.lastPass && { ...maintenance.lastPass, startedAt: 0, durationMs: 0 },
      running: maintenance.running && { ...maintenance.running, startedAt: '' },
    },
  });
}
