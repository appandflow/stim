import { mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export const TRACE_ENV = 'STIM_TRACE';
const OWNER_ENV = 'STIM_TRACE_OWNER';

const PHASE_TID_BASE = 1000;
const MAX_ARGS = 60;
const MAX_ARG_CHARS = 240;
const MAX_LINE_CHARS = 500;
const SECRET_WORDS = 'token|secret|ticket|pass|credential|cookie|api[-_]?key|access[-_]?key|private[-_]?key|auth';
const SECRET_NAME = new RegExp(SECRET_WORDS, 'i');
const SECRET_FLAG = String.raw`--?[A-Za-z0-9_.-]*(?:${SECRET_WORDS})[A-Za-z0-9_.-]*`;
const SECRET_FLAG_VALUE = new RegExp(String.raw`(${SECRET_FLAG})(=|\s+)(?:'[^']*'|"[^"]*"|\S+)`, 'gi');
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`([A-Za-z0-9_]*(?:${SECRET_WORDS})[A-Za-z0-9_]*)=(?:'[^']*'|"[^"]*"|[^\s&]+)`,
  'gi',
);
const URL_USERINFO = /(\/\/)[^/\s@]+@/g;
const SECRET_HEADER = new RegExp(String.raw`(\b[A-Za-z-]*(?:${SECRET_WORDS})[A-Za-z-]*:\s*)\S+`, 'gi');
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKEN_SHAPE = /\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{10,}/g;

function scrubText(text: string, exact: readonly string[]): string {
  return exact
    .filter(Boolean)
    .reduce((acc, value) => acc.split(value).join('***'), text)
    .replace(URL_USERINFO, '$1[redacted]@')
    .replace(SECRET_ASSIGNMENT, '$1=[redacted]')
    .replace(SECRET_HEADER, '$1[redacted]')
    .replace(AUTH_SCHEME, '$1 [redacted]')
    .replace(TOKEN_SHAPE, '[redacted]');
}

/**
 * `args` with the value of any flag or assignment that looks like a secret, credentials in URLs, token shapes and
 * the `exact` values replaced.
 */
export function redactArgv(args: readonly string[], exact: readonly string[] = []): string[] {
  const out: string[] = [];
  let redactNext = false;
  for (const arg of args.slice(0, MAX_ARGS)) {
    const flag = /^(--?[A-Za-z0-9_.-]+)=/.exec(arg)?.[1];
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(arg)?.[1];
    if (redactNext) {
      out.push('[redacted]');
      redactNext = false;
    } else if (flag) {
      out.push(SECRET_NAME.test(flag) ? `${flag}=[redacted]` : clip(scrubText(arg, exact)));
    } else if (arg.startsWith('-') && SECRET_NAME.test(arg)) {
      out.push(arg);
      redactNext = true;
    } else if (assignment && SECRET_NAME.test(assignment)) {
      out.push(`${assignment}=[redacted]`);
    } else if (/\s/.test(arg)) {
      out.push(redactCommandLine(arg, exact));
    } else {
      out.push(clip(scrubText(arg, exact)));
    }
  }
  if (args.length > MAX_ARGS) out.push(`[+${args.length - MAX_ARGS} more]`);
  return out;
}

function clip(text: string, max = MAX_ARG_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** A shell command line with the same redactions as `redactArgv`, clipped to a fixed length. */
export function redactCommandLine(command: string, exact: readonly string[] = []): string {
  return clip(scrubText(command.replace(SECRET_FLAG_VALUE, '$1$2[redacted]'), exact), MAX_LINE_CHARS);
}

export type TraceArgs = Record<string, unknown>;
export type EndSpan = (args?: TraceArgs) => void;
type Args = TraceArgs;

interface OpenSpan {
  name: string;
  cat: string;
  tid: number;
  lane: number | null;
  ts: number;
  args: Args;
}

interface Sink {
  path: string;
  fd: number;
  lanes: boolean[];
  named: Set<number>;
  open: Set<OpenSpan>;
  tracks: Map<string, number>;
}

const microseconds = (): number => Math.round((performance.timeOrigin + performance.now()) * 1000);

let current: Sink | null = null;
let attempted: string | null = null;

function emit(sink: Sink, event: Record<string, unknown>): void {
  try {
    const line = Buffer.from(`${JSON.stringify({ ...event, pid: process.pid })},\n`);
    for (let written = 0; written < line.length;) written += writeSync(sink.fd, line, written);
  } catch {
    sink.fd = -1;
  }
}

function nameThread(sink: Sink, tid: number, name: string): void {
  if (sink.named.has(tid)) return;
  sink.named.add(tid);
  emit(sink, { ph: 'M', name: 'thread_name', tid, args: { name } });
}

function finish(sink: Sink, span: OpenSpan, args: Args | undefined): void {
  if (!sink.open.delete(span)) return;
  if (span.lane !== null) sink.lanes[span.lane] = false;
  if (sink.fd < 0) return;
  const end = microseconds();
  emit(sink, {
    name: span.name,
    cat: span.cat,
    ph: 'X',
    ts: span.ts,
    dur: Math.max(0, end - span.ts),
    tid: span.tid,
    ...(args || Object.keys(span.args).length ? { args: { ...span.args, ...args } } : {}),
  });
}

function claimRoot(): void {
  const path = process.env[TRACE_ENV];
  if (!path) return;
  try {
    const absolute = resolve(path);
    if (process.env[OWNER_ENV] === absolute) return;
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, '[\n');
    process.env[OWNER_ENV] = absolute;
  } catch {}
}

function openSink(path: string): Sink | null {
  try {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    try {
      writeFileSync(absolute, '[\n', { flag: 'wx' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    process.env[TRACE_ENV] = absolute;
    const sink: Sink = {
      path: absolute,
      fd: openSync(absolute, 'a'),
      lanes: [],
      named: new Set(),
      open: new Set(),
      tracks: new Map(),
    };
    emit(sink, {
      ph: 'M',
      name: 'process_name',
      args: { name: `${basename(process.argv[1] ?? 'node').replace(/\.[cm]?[jt]s$/, '')} ${process.pid}` },
    });
    process.on('exit', (code) => {
      for (const span of sink.open) finish(sink, span, span.cat === 'command' ? { exit: code } : { unfinished: true });
    });
    return sink;
  } catch {
    return null;
  }
}

function active(): Sink | null {
  const path = process.env[TRACE_ENV];
  if (!path) return null;
  if (path === attempted || path === current?.path) return current && current.fd >= 0 ? current : null;
  attempted = path;
  current = openSink(path);
  return current;
}

function begin(name: string, args: Args | undefined, cat = 'span'): EndSpan {
  const sink = active();
  if (!sink) return NO_END;
  let lane = sink.lanes.indexOf(false);
  if (lane < 0) lane = sink.lanes.length;
  sink.lanes[lane] = true;
  const tid = lane + 1;
  nameThread(sink, tid, `spans ${tid}`);
  const span: OpenSpan = { name, cat, tid, lane, ts: microseconds(), args: args ?? {} };
  sink.open.add(span);
  return (endArgs) => finish(sink, span, endArgs);
}

const NO_END: EndSpan = () => {};

export interface TracePhases {
  /** Ends the phase in progress and starts `name`; entering the phase already in progress does nothing. */
  enter(name: string, args?: Args): void;
  end(args?: Args): void;
}

const NO_PHASES: TracePhases = { enter: () => {}, end: () => {} };

function phases(track: string): TracePhases {
  const sink = active();
  if (!sink) return NO_PHASES;
  const tid = sink.tracks.get(track) ?? PHASE_TID_BASE + sink.tracks.size;
  sink.tracks.set(track, tid);
  nameThread(sink, tid, `phases: ${track}`);
  let open: OpenSpan | null = null;
  const close = (args?: Args): void => {
    if (open) finish(sink, open, args);
    open = null;
  };
  return {
    enter(name, args) {
      if (open?.name === name) return;
      close();
      open = { name, cat: 'phase', tid, lane: null, ts: microseconds(), args: args ?? {} };
      sink.open.add(open);
    },
    end: close,
  };
}

export interface Trace {
  enabled(): boolean;
  /** Starts a span; the returned function ends it, with optional extra args. */
  begin(name: string, args?: TraceArgs): EndSpan;
  /** `begin` for the outermost span of a process: it ends at exit with the exit code. */
  command(name: string, args?: TraceArgs): void;
  /** `begin` for a child process: same event with the `exec` category. */
  beginExec(name: string, args?: TraceArgs): EndSpan;
  /** Runs `fn` inside a span and ends it when `fn` returns or throws. */
  span<T>(name: string, fn: () => T, args?: TraceArgs): T;
  /** `span` for an async `fn`: ends when its promise settles. */
  spanAsync<T>(name: string, fn: () => Promise<T>, args?: TraceArgs): Promise<T>;
  mark(name: string, args?: TraceArgs): void;
  /** A strip of consecutive, non-overlapping phases on its own track. */
  phases(track: string): TracePhases;
}

/**
 * Timing spans for one stim process tree, written as Chrome trace events (open the file in Perfetto or
 * chrome://tracing) when `STIM_TRACE=<path>` is set. Unset, every call is one environment check. A stim command
 * (`trace.command`) truncates the file and writes `[`; every other process that inherits the variable appends one
 * event per line, creating the file if it is missing, so the file has no closing bracket. Child process arguments are written through `redactArgv`.
 */
export const trace: Trace = {
  enabled: () => active() !== null,
  begin: (name, args) => begin(name, args),
  command(name, args) {
    claimRoot();
    begin(name, args, 'command');
  },
  beginExec: (name, args) => begin(name, args, 'exec'),
  span<T>(name: string, fn: () => T, args?: Args): T {
    const end = begin(name, args);
    try {
      const result = fn();
      end();
      return result;
    } catch (error) {
      end({ error: true });
      throw error;
    }
  },
  async spanAsync<T>(name: string, fn: () => Promise<T>, args?: Args): Promise<T> {
    const end = begin(name, args);
    try {
      const result = await fn();
      end();
      return result;
    } catch (error) {
      end({ error: true });
      throw error;
    }
  },
  mark(name: string, args?: Args): void {
    const sink = active();
    if (!sink) return;
    nameThread(sink, 1, 'spans 1');
    emit(sink, { name, cat: 'mark', ph: 'i', s: 't', ts: microseconds(), tid: 1, ...(args ? { args } : {}) });
  },
  phases,
};
