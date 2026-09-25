import type { LogFilter, LogLevel, LogRecord, LogSource, StackFrame } from '@/protocol/types';

export const SOURCES: { source: LogSource; label: string }[] = [
  { source: 'metro', label: 'Metro' },
  { source: 'client', label: 'App' },
  { source: 'device', label: 'Native' },
  { source: 'build', label: 'Build' },
];

export const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export const MAX_RECORDS = 5000;

export interface LogFilterState {
  sources: LogSource[];
  level: LogLevel;
  errors: boolean;
  grep: string;
  slot: string | null;
}

export const DEFAULT_FILTER: LogFilterState = {
  sources: SOURCES.map((s) => s.source),
  level: 'debug',
  errors: false,
  grep: '',
  slot: null,
};

/**
 * The same arguments apps/desktop passes to `stim logs`: every source selected sends no
 * `sources`, so "errors only" keeps the CLI's default scope.
 */
export function logFilter(workspace: string, state: LogFilterState, tail = MAX_RECORDS): LogFilter {
  const filter: LogFilter = { workspace, tail };
  if (state.sources.length < SOURCES.length)
    filter.sources = SOURCES.map((s) => s.source).filter((s) => state.sources.includes(s));
  if (state.level !== 'debug') filter.level = state.level;
  if (state.errors) filter.errors = true;
  if (state.grep.trim() !== '') filter.grep = state.grep.trim();
  if (state.slot) filter.slot = state.slot;
  return filter;
}

export function appendRecords(existing: LogRecord[], incoming: LogRecord[], max = MAX_RECORDS): LogRecord[] {
  if (incoming.length === 0) return existing;
  const next = existing.concat(incoming);
  return next.length > max ? next.slice(next.length - max) : next;
}

export function firstLine(message: string): string {
  const i = message.indexOf('\n');
  return i < 0 ? message : message.slice(0, i);
}

/** The same `at fn (file:line:column)` lines `stim logs` prints under a record. */
export function stackLines(stack: unknown): string[] {
  if (!Array.isArray(stack)) return [];
  return (stack as StackFrame[]).flatMap((frame) => {
    if (!frame || typeof frame !== 'object') return [];
    const where = [frame.file, frame.line, frame.column]
      .filter((p) => p !== undefined && p !== null && p !== '')
      .join(':');
    if (frame.fn && where) return [`at ${frame.fn} (${where})`];
    if (frame.fn) return [`at ${frame.fn}`];
    return where ? [`at ${where}`] : [];
  });
}
