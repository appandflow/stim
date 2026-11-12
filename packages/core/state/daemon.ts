import { isJsonObject, readJsonObject } from './json-file.ts';
import { daemonSnapshotFile } from './paths.ts';

export type DaemonMode = 'on' | 'report' | 'off';

/** One tick's measurement of the machine. A null field is one the tick could not read. */
export interface DaemonMeasurement {
  disk: { volume: string; freeMb: number; device?: number }[];
  memory: {
    level: 'normal' | 'warning' | 'critical' | null;
    availableBytes: number | null;
    totalBytes: number;
  };
  load1: number;
  cores: number;
  /** Booted simulators from the tick's one `simctl list`; null when it failed. */
  bootedSimulators: number | null;
  /** Running emulators from the tick's one `adb devices`; null when it failed or no workspace owns an emulator. */
  runningEmulators: number | null;
  /**
   * The owned devices a person used in the focused Simulator, Device Hub or emulator window within the last two
   * minutes, when there were some. Without a readable focused simulator, every booted owned simulator counts.
   */
  interaction: { platform: 'ios' | 'android'; ids: string[]; at: string } | null;
}

/** What one tick decided for a workspace that had something running. */
export interface DaemonWorkspaceDecision {
  path: string;
  /** The newest activity signal, by its basis. */
  lastActivity: { basis: string; at: string } | null;
  /** `idle` when the tick moved it into the idle stage, or would have in report mode. */
  outcome: 'active' | 'kept' | 'idle' | 'would-idle' | 'failed';
  detail: string;
  /** The bytes of build outputs the idle stage deleted. */
  freedBytes?: number;
}

export type PressureLevel = 'normal' | 'high' | 'critical';

/** The machine's pressure level for one tick: the higher of the disk and memory levels, and why. */
export interface DaemonPressure {
  level: PressureLevel;
  disk: PressureLevel;
  memory: PressureLevel;
  /** One line per condition that raised the level; empty at normal. */
  reasons: string[];
  /** When macOS memory pressure turned warning, while it still is; the level counts it after 10 minutes. */
  memoryWarningSince: string | null;
}

/** One action of the pressure ladder or the dormant stage, as the daemon logged it. */
export interface DaemonLadderAction {
  /**
   * The ladder rung, 1 to 6; the dormant stage reached by `idle.dormantDays` is rung 4, and the admission reclaim of
   * a device for a run waiting to boot is 0.
   */
  rung: number;
  kind: string;
  target: string;
  workspace?: string;
  outcome: 'done' | 'kept' | 'failed' | 'would';
  bytes: number;
  detail: string;
  /** The command that brings back what the action removed, when one does. */
  restore?: string;
  /** The idle setting that took a dormant-stage action when it is not `idle.dormantDays`. */
  setting?: string;
}

/** A ladder, stage or reclaim action a daemon took, or would have in report mode, with the tick that took it. */
export type DaemonRecentAction = DaemonLadderAction & { at: string };

/** A run waiting for a build slot or a device boot, in arrival order per resource. */
export interface DaemonWaiter {
  resource: 'build' | 'boot';
  /** 1 for the run that gets the next free slot of its resource. */
  position: number;
  workspace: string | null;
  label: string;
  platform?: string;
  since: string;
}

/** `$STIM_HOME/daemon/snapshot.json`: the daemon's identity and its last tick. */
export interface DaemonSnapshot {
  version: 1;
  pid: number;
  startedAt: string;
  mode: DaemonMode;
  tickAt: string;
  tickMs: number;
  intervalMs: number;
  measurement: DaemonMeasurement;
  workspaces: DaemonWorkspaceDecision[];
  /** Absent from snapshots written before the pressure ladder existed. */
  pressure?: DaemonPressure;
  /** The ladder and dormant actions this tick took, or would take in report mode. */
  actions?: DaemonLadderAction[];
  /** The last 20 actions any daemon of this home took, the idle stage included, oldest first. */
  recent?: DaemonRecentAction[];
  waiting?: DaemonWaiter[];
}

/** A child whose cleanup the running stimd could not verify, which keeps it up until the child has stopped. */
export interface UnverifiedCleanup {
  since: string;
  /** The child's pid, whose process group ending ends the wait. */
  child: number;
  message: string;
  /** How to check the child, how the wait ends, and that stopping this stimd is safe. */
  remedy: string;
}

/** The well-formed entries of a daemon claim's `unverified` details. */
export function parseUnverifiedCleanups(value: unknown): UnverifiedCleanup[] {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        isJsonObject(entry) &&
        typeof entry.since === 'string' &&
        typeof entry.child === 'number' &&
        typeof entry.message === 'string' &&
        typeof entry.remedy === 'string'
          ? [{ since: entry.since, child: entry.child, message: entry.message, remedy: entry.remedy }]
          : [],
      )
    : [];
}

/** Whether the home daemon runs, and when it last ticked; `status` and `doctor` print it. */
export interface DaemonStatus {
  /** The running daemon's mode, else the mode `daemon.mode` resolves to here. */
  mode: DaemonMode;
  /** The mode `daemon.mode` resolves to here, when the running daemon started in another one. */
  setting?: DaemonMode;
  running: { pid: number; since: string } | null;
  lastTickAt: string | null;
  intervalMs: number | null;
  claim?: { unresolved: string; removeCommand: string };
  /** The last tick's pressure level; absent until a daemon with the pressure ladder ticked. */
  pressure?: DaemonPressure;
  /** Runs waiting for a build slot or a device boot now, read from the wait queues. */
  waiting?: DaemonWaiter[];
  /** The last actions a daemon of this home took, oldest first, from its snapshot. */
  recent?: DaemonRecentAction[];
  /** The children the running daemon stays up for, from its claim. */
  unverified?: UnverifiedCleanup[];
}

function isDaemonSnapshot(record: Record<string, unknown> | null): record is Record<string, unknown> & DaemonSnapshot {
  return (
    record?.version === 1 &&
    typeof record.pid === 'number' &&
    typeof record.startedAt === 'string' &&
    typeof record.tickAt === 'string' &&
    typeof record.intervalMs === 'number'
  );
}

export function readDaemonSnapshot(file: string = daemonSnapshotFile()): DaemonSnapshot | null {
  const record = readJsonObject(file);
  return isDaemonSnapshot(record) ? record : null;
}
