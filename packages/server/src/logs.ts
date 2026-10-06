import { compileGrep, isJsonObject, queryJsonLogs } from '@stim-cli/core/state';
import { SLOT_NAME } from './control.ts';
import type { JsonObject } from './feed.ts';
import { LOG_LEVELS, LOG_SOURCES, MAX_LOG_TAIL, type LogFilter, type LogLevel, type LogSource } from './protocol.ts';

export function parseLogFilter(params: unknown): { filter: LogFilter } | { error: string } {
  if (!isJsonObject(params)) return { error: 'params must be an object.' };
  const error = readTargetError(params);
  if (error) return { error };
  const { sources, level, slot, grep, errors, tail } = params;
  if (
    sources !== undefined &&
    (!Array.isArray(sources) ||
      sources.length === 0 ||
      !sources.every((source) => LOG_SOURCES.includes(source as LogSource)))
  ) {
    return { error: `sources must be a non-empty list of ${LOG_SOURCES.join(', ')}.` };
  }
  if (level !== undefined && !LOG_LEVELS.includes(level as LogLevel)) {
    return { error: `level must be one of ${LOG_LEVELS.join(', ')}.` };
  }
  if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
    return { error: 'slot must be 1-64 letters, digits, underscores or hyphens.' };
  }
  if (grep !== undefined && (typeof grep !== 'string' || grep.includes('\0') || compileGrep(grep).error)) {
    return { error: 'grep must be a valid regular expression without NUL characters.' };
  }
  if (errors !== undefined && typeof errors !== 'boolean') return { error: 'errors must be true or false.' };
  if (tail !== undefined && (!Number.isInteger(tail) || (tail as number) < 1 || (tail as number) > MAX_LOG_TAIL)) {
    return { error: `tail must be an integer from 1 to ${MAX_LOG_TAIL}.` };
  }
  return {
    filter: {
      ...(typeof params.archive === 'string' ? { archive: params.archive } : { workspace: params.workspace as string }),
      ...(sources ? { sources: sources as LogSource[] } : {}),
      ...(level && level !== 'debug' ? { level: level as LogLevel } : {}),
      ...(slot ? { slot } : {}),
      ...(grep ? { grep } : {}),
      ...(errors ? { errors } : {}),
      tail: (tail as number | undefined) ?? MAX_LOG_TAIL,
    },
  };
}

export function readTargetError(params: JsonObject): string | null {
  if ((params.workspace === undefined) === (params.archive === undefined)) {
    return 'Exactly one of params.workspace or params.archive is required.';
  }
  if (params.archive !== undefined) {
    return typeof params.archive === 'string' && params.archive.length > 0 && !/[\\/\0]|\.\./.test(params.archive)
      ? null
      : "params.archive must be an archive id without path separators, NUL or '..'.";
  }
  return typeof params.workspace === 'string' ? null : 'params.workspace is required.';
}

export function archivedLogs(dir: string, filter: LogFilter): JsonObject[] {
  return queryJsonLogs({
    dir,
    sources: filter.sources,
    minLevel: filter.level,
    slot: filter.slot,
    grep: filter.grep,
    errorsOnly: filter.errors,
    tail: filter.tail,
  });
}

export function logArgs(filter: LogFilter, follow: boolean): string[] {
  const args = ['logs', '--json', ...(follow ? ['--follow'] : []), `--tail=${filter.tail ?? MAX_LOG_TAIL}`];
  if (filter.sources) args.push('--source', ...LOG_SOURCES.filter((source) => filter.sources!.includes(source)));
  if (filter.slot) args.push(`--slot=${filter.slot}`);
  if (filter.level) args.push(`--level=${filter.level}`);
  if (filter.grep) args.push(`--grep=${filter.grep}`);
  if (filter.errors) args.push('--errors');
  return args;
}

export interface LogSink {
  send: (records: JsonObject[]) => void;
  bufferedBytes: () => number;
  overflow: () => void;
  ended?: () => void;
}

export interface LogLimits {
  maxBufferedBytes: number;
  maxPendingRecords: number;
}

const BATCH_MS = 100;
const MAX_BATCH = 500;

export class LogBatcher {
  private pending: JsonObject[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private finishing = false;

  private readonly sink: LogSink;
  private readonly limits: LogLimits;

  constructor(sink: LogSink, limits: LogLimits) {
    this.sink = sink;
    this.limits = limits;
  }

  push(record: JsonObject): void {
    if (this.stopped) return;
    this.pending.push(record);
    if (this.pending.length > this.limits.maxPendingRecords) {
      this.stop();
      queueMicrotask(this.sink.overflow);
      return;
    }
    this.timer ??= setTimeout(() => this.flush(false), BATCH_MS);
  }

  finish(): void {
    if (this.stopped) return;
    this.finishing = true;
    this.flush(false);
  }

  flush(force: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.pending.length) {
      if (!force && this.sink.bufferedBytes() >= this.limits.maxBufferedBytes) break;
      this.sink.send(this.pending.splice(0, MAX_BATCH));
    }
    if (this.pending.length && !this.stopped) this.timer = setTimeout(() => this.flush(false), BATCH_MS);
    else if (this.finishing && !this.stopped) {
      this.stop();
      this.sink.ended?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }
}
