import { gcLogFile } from './paths.ts';
import { readNdjsonGenerations, type NdjsonRecord } from './ndjson.ts';
import type { PressureLevel } from './daemon.ts';

export type GcLogTrigger = 'manual' | 'desktop' | 'maintenance' | 'budget';

export type GcLogStatus = 'done' | 'kept' | 'failed';

export interface GcLogOptions {
  /** The pressure level the run ran at. */
  level?: PressureLevel;
  /** Whether `--pressure` chose the level instead of the measured one. */
  pressure?: boolean;
  /** Written by the removed `--delete`, `--worktrees`, `--older-than` and `--cache` flags; older records keep them. */
  delete?: boolean;
  worktrees?: boolean;
  olderThan?: number;
  cache?: string;
  /** Written by `stim gc --idle`, which no longer exists; older records keep it. */
  idleMs?: number;
}

export interface GcLogRecord extends NdjsonRecord {
  ts: number;
  src: 'gc';
  level: 'info' | 'error';
  msg: string;
  event: 'gc_item';
  /** The invocation for `stim gc` and budget runs; the pass id for maintenance. */
  runId: string;
  trigger: GcLogTrigger;
  /** For maintenance, the command whose invocation started the pass. */
  via?: string;
  options?: GcLogOptions;
  kind: string;
  status: GcLogStatus;
  label: string;
  id: string | null;
  path: string | null;
  bytes: number | null;
  detail: string | null;
}

/**
 * A record of a maintenance pass in the machine cleanup log that is not an item: the pass summary, a skip with its
 * reason, a failure, a check, or, in report mode, a planned action. It carries no `status`, `kind` or `label`.
 */
export interface GcLogEntry extends NdjsonRecord {
  ts: number;
  src: 'gc';
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  event: 'maintenance_pass' | 'maintenance_action' | 'maintenance_skip' | 'maintenance_failure' | 'maintenance_check';
  runId: string;
  trigger: 'maintenance';
  via: string;
  mode: 'report' | 'on';
}

const TRIGGERS: readonly string[] = ['manual', 'desktop', 'maintenance', 'budget'];
const STATUSES: readonly string[] = ['done', 'kept', 'failed'];

export function isGcLogRecord(record: NdjsonRecord): record is GcLogRecord {
  return (
    record.src === 'gc' &&
    record.event === 'gc_item' &&
    typeof record.ts === 'number' &&
    typeof record.runId === 'string' &&
    typeof record.trigger === 'string' &&
    TRIGGERS.includes(record.trigger) &&
    typeof record.status === 'string' &&
    STATUSES.includes(record.status) &&
    typeof record.kind === 'string' &&
    typeof record.label === 'string'
  );
}

export function readGcLog(file: string = gcLogFile()): (GcLogRecord | GcLogEntry)[] {
  return readNdjsonGenerations(file)
    .filter((record): record is GcLogRecord | GcLogEntry => record.src === 'gc' && typeof record.ts === 'number')
    .toSorted((a, b) => a.ts - b.ts);
}
