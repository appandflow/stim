import { gcLogFile, gcReportCacheFile } from './paths.ts';
import { isJsonObject, readJsonObject } from './json-file.ts';
import { readNdjsonGenerations, type NdjsonRecord } from './ndjson.ts';
import type { PressureLevel } from './daemon.ts';

export type GcLogTrigger = 'manual' | 'desktop' | 'maintenance' | 'budget';

export type GcLogStatus = 'done' | 'kept' | 'failed' | 'pending';

export interface GcLogOptions {
  /** The pressure level the run ran at. */
  level?: PressureLevel;
  /** Whether `--pressure` chose the level instead of the measured one. */
  pressure?: boolean;
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
  /** Set when a size walk timed out, so `bytes` is a lower bound. */
  partial?: true;
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
const STATUSES: readonly string[] = ['done', 'kept', 'failed', 'pending'];

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

export const GC_REPORT_CACHE_VERSION = 2;

/** A cached gc report older than this is stale: a read starts a new sweep; about three of the slowest sweeps seen (#6606). */
export const GC_REPORT_STALE_MS: number = 15 * 60_000;

/** The parts of a gc report, in the order a sweep reads them: the maintenance plan, the storage sections, the inventory. */
export type GcReportPart = 'plan' | 'sections' | 'inventory';

export interface GcReportCache {
  version: typeof GC_REPORT_CACHE_VERSION;
  /** When the sweep that produced `report` started, as an ISO time. */
  measuredAt: string;
  /** When the sweep started reading each part, as ISO times: no row of a part is older than its time. */
  parts: Record<GcReportPart, string>;
  /** The dry-run payload `stim gc --dry-run --json` prints. */
  report: Record<string, unknown>;
  /** The plan's internal fields the plain dry-run summary reads; carries no compatibility. */
  run: Record<string, unknown>;
}

const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** The cached gc report, or null when it is missing, of another version or does not parse; it is rebuildable. */
export function readGcReportCache(file: string = gcReportCacheFile()): GcReportCache | null {
  return parseGcReportCache(readJsonObject(file));
}

/** `value` as a gc report cache entry, or null when it is not one of this version. */
export function parseGcReportCache(value: unknown): GcReportCache | null {
  if (
    !isJsonObject(value) ||
    value.version !== GC_REPORT_CACHE_VERSION ||
    !isTime(value.measuredAt) ||
    !isJsonObject(value.parts) ||
    !isJsonObject(value.report) ||
    !isJsonObject(value.run)
  )
    return null;
  const { plan, sections, inventory } = value.parts;
  if (!isTime(plan) || !isTime(sections) || !isTime(inventory)) return null;
  return {
    version: GC_REPORT_CACHE_VERSION,
    measuredAt: value.measuredAt,
    parts: { plan, sections, inventory },
    report: value.report,
    run: value.run,
  };
}
