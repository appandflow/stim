import { readJsonObject } from './json-file.ts';
import { daemonSnapshotFile } from './paths.ts';

export type DaemonMode = 'on' | 'report' | 'off';

/** One tick's measurement of the machine. A null field is one the tick could not read. */
export interface DaemonMeasurement {
  disk: { volume: string; freeMb: number }[];
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
  /** The focused Simulator or emulator window a person used within the last two minutes, when there was one. */
  interaction: { platform: 'ios' | 'android'; id: string; at: string } | null;
}

/** What one tick decided for a workspace that had something running. */
export interface DaemonWorkspaceDecision {
  path: string;
  /** The newest activity signal, by its basis. */
  lastActivity: { basis: string; at: string } | null;
  /** `idle` when the tick moved it into the idle stage, or would have in report mode. */
  outcome: 'active' | 'kept' | 'idle' | 'would-idle' | 'failed';
  detail: string;
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
}

/** Whether the home daemon runs, and when it last ticked; `status` and `doctor` print it. */
export interface DaemonStatus {
  mode: DaemonMode;
  running: { pid: number; since: string } | null;
  lastTickAt: string | null;
  intervalMs: number | null;
  claim?: { unresolved: string; removeCommand: string };
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
