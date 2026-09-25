import { compileGrep, isJsonObject } from '@stim-cli/core/state';
import type { JsonObject } from './feed.ts';
import { LOG_LEVELS, LOG_SOURCES, MAX_LOG_TAIL, type LogFilter, type LogLevel, type LogSource } from './protocol.ts';

export function parseLogFilter(params: unknown): { filter: LogFilter } | { error: string } {
  if (!isJsonObject(params) || typeof params.workspace !== 'string') return { error: 'params.workspace is required.' };
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
  if (slot !== undefined && (typeof slot !== 'string' || slot === '')) return { error: 'slot must be a slot name.' };
  if (grep !== undefined && (typeof grep !== 'string' || compileGrep(grep).error)) {
    return { error: 'grep must be a valid regular expression.' };
  }
  if (errors !== undefined && typeof errors !== 'boolean') return { error: 'errors must be true or false.' };
  if (tail !== undefined && (!Number.isInteger(tail) || (tail as number) < 1 || (tail as number) > MAX_LOG_TAIL)) {
    return { error: `tail must be an integer from 1 to ${MAX_LOG_TAIL}.` };
  }
  return {
    filter: {
      workspace: params.workspace,
      ...(sources ? { sources: sources as LogSource[] } : {}),
      ...(level ? { level: level as LogLevel } : {}),
      ...(slot ? { slot } : {}),
      ...(grep ? { grep } : {}),
      ...(errors ? { errors } : {}),
      tail: (tail as number | undefined) ?? MAX_LOG_TAIL,
    },
  };
}

/** The `stim logs` arguments Stim Desktop's log viewer builds for the same filters. */
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
}

export interface LogLimits {
  maxBufferedBytes: number;
  maxPendingRecords: number;
}

const BATCH_MS = 100;
const MAX_BATCH = 500;

/**
 * Batches records for one subscriber. While the socket holds more than `maxBufferedBytes` unsent, records
 * wait here; past `maxPendingRecords` waiting, the subscriber is dropped instead of buffering without end.
 */
export class LogBatcher {
  private pending: JsonObject[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

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

  /** Sends what is waiting; `force` ignores the socket's unsent bytes, for the last records before an end. */
  flush(force: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.pending.length) {
      if (!force && this.sink.bufferedBytes() >= this.limits.maxBufferedBytes) break;
      this.sink.send(this.pending.splice(0, MAX_BATCH));
    }
    if (this.pending.length && !this.stopped) this.timer = setTimeout(() => this.flush(false), BATCH_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }
}
