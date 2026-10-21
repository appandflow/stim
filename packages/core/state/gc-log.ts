import { gcLogFile } from './paths.ts';
import { readNdjsonGenerations, type NdjsonRecord } from './ndjson.ts';

export type GcLogTrigger = 'manual' | 'desktop' | 'maintenance' | 'budget';

export type GcLogStatus = 'done' | 'kept' | 'failed';

export interface GcLogOptions {
  delete?: boolean;
  worktrees?: boolean;
  olderThan?: number;
  cache?: string;
  idleMs?: number;
}

export interface GcLogRecord extends NdjsonRecord {
  ts: number;
  src: 'gc';
  level: 'info' | 'error';
  msg: string;
  event: 'gc_item';
  /** The invocation for `stim gc` and budget runs; the `pass` id of `maintenance.ndjson` for maintenance. */
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

export function readGcLog(file: string = gcLogFile()): GcLogRecord[] {
  return readNdjsonGenerations(file).filter(isGcLogRecord);
}
