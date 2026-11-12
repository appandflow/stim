import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES, ensurePrivateDir, rotateLog } from '@stim-cli/core';
import { isJsonObject, type MacosProcess } from '@stim-cli/core/state';
import { macosAppLogName } from '../../macos/state.ts';
import { outputWriters } from '../../macos/output-writers.ts';
import { inspectProcessIdentity } from '../../process-identity.ts';
import { processGroupAlive, releaseClaim, tryAcquireClaim, type ClaimHandle } from '../../ownership-claim.ts';

const TAIL_MS = 250;
const WRITERS_PROBE_MS = 2000;
const CHUNK_BYTES = 64 * 1024;
const LINE_BYTES = 65536;
const TAIL_MARK = 'macos-app.tail.json';
const TAIL_CLAIM = 'macos-app.tail.lock';
export const MACOS_APP_SINK = 'macos-app.ndjson';
const DROPPED = 'macOS app output may have been dropped when its raw log reached the size limit.';

interface TailState {
  out: number;
  err: number;
  outPending: string;
  errPending: string;
  observed: boolean;
  exited: boolean;
  /** Raw output was cut while the sink could not take it; the next append warns. */
  dropped: boolean;
}

interface Mark extends TailState {
  processToken: string;
  /** A sink append in flight: the sink's identity and size before it, and the state once it landed. */
  pending?: { ino: string | null; size: number; next: TailState };
}

const EMPTY: TailState = {
  out: 0,
  err: 0,
  outPending: '',
  errPending: '',
  observed: false,
  exited: false,
  dropped: false,
};

function readMark(dir: string): Record<string, unknown> | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(join(dir, TAIL_MARK), 'utf8'));
    return isJsonObject(saved) ? saved : null;
  } catch {
    return null;
  }
}

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const offset = (field: unknown): number =>
  typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : 0;

function tailState(value: unknown): TailState {
  if (!isJsonObject(value)) return EMPTY;
  return {
    out: offset(value.out),
    err: offset(value.err),
    outPending: typeof value.outPending === 'string' ? value.outPending : '',
    errPending: typeof value.errPending === 'string' ? value.errPending : '',
    observed: value.observed === true,
    exited: value.exited === true,
    dropped: value.dropped === true,
  };
}

/** Whether a tail already copied all of the exited app's output, saw every writer of it gone and wrote its exit. */
export function drained(dir: string, app: MacosProcess): boolean {
  const mark = readMark(dir);
  return mark?.processToken === app.processToken && mark.exited === true && mark.pending === undefined;
}

/** Removes an app's raw output files once its end is recorded; a failure leaves them to workspace removal. */
export function removeRawOutput(dir: string, launchId: string): void {
  for (const stream of ['out', 'err'] as const)
    try {
      rmSync(join(dir, macosAppLogName(launchId, stream)), { force: true });
    } catch {}
}

function sinkIdentity(sink: string): { ino: string; size: number } | null {
  try {
    const stat = statSync(sink, { bigint: true });
    return { ino: stat.ino.toString(), size: Number(stat.size) };
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/**
 * The state a tail resumes from: the committed one, or the one after an append whose landing the sink proves. Only
 * this tail appends to its sink and rotates it, so a grown sink with the recorded identity holds the append.
 */
function resumeState(mark: Record<string, unknown> | null, token: string, sink: string): TailState {
  if (mark?.processToken !== token) return EMPTY;
  const pending = mark.pending;
  if (!isJsonObject(pending)) return tailState(mark);
  const now = sinkIdentity(sink);
  const before = typeof pending.size === 'number' ? pending.size : 0;
  const landed = now !== null && (pending.ino === null ? now.size > 0 : now.ino === pending.ino && now.size > before);
  return landed ? tailState(pending.next) : tailState(mark);
}

/** Complete lines of `pending` + `chunk`, each at most LINE_BYTES, and the rest; `final` also ends the rest. */
function splitLines(pending: Buffer, chunk: Buffer, final: boolean): { lines: string[]; rest: Buffer } {
  let rest = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  const lines: string[] = [];
  for (;;) {
    const newline = rest.indexOf(10);
    if (newline >= 0 && newline <= LINE_BYTES) {
      lines.push(rest.subarray(0, newline).toString('utf8').replace(/\r$/, ''));
      rest = rest.subarray(newline + 1);
    } else if (rest.length > LINE_BYTES) {
      let end = LINE_BYTES;
      while (end > 0 && (rest.readUInt8(end) & 0xc0) === 0x80) end--;
      if (end === 0) end = LINE_BYTES;
      lines.push(rest.subarray(0, end).toString('utf8'));
      rest = rest.subarray(end);
    } else break;
  }
  if (final && rest.length) {
    lines.push(rest.toString('utf8').replace(/\r$/, ''));
    rest = Buffer.alloc(0);
  }
  return { lines, rest: Buffer.from(rest) };
}

/**
 * The tail claim of a directory, for this process. A claim this process already holds was left by a logs worker of
 * this stimd that exited, since stimd starts the next worker only after the previous one exited.
 */
function takeTailClaim(root: string): ClaimHandle | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const taken = tryAcquireClaim({
      root,
      mode: 'exclusive',
      label: 'macOS app output tail',
    });
    if (taken.pending) releaseClaim(taken.pending);
    if (taken.acquired) return taken.acquired;
    const held = taken.held;
    if (!held || held.owner.pid !== process.pid || inspectProcessIdentity(held.owner) !== 'same') return null;
    releaseClaim({ ...held, root, label: 'macOS app output tail' });
  }
  return null;
}

export interface MacosTail {
  token: string;
  ended: Promise<void>;
  /** Ends the tail once every writer of the app's output is gone and all of it is copied; false while not. */
  drain(): Promise<boolean>;
  /** Why the last drain did not end the tail. */
  blocked(): string | null;
  /** Whether the last drain waited only on the app's group or another process holding its output. */
  waiting(): boolean;
  ready(): string | null;
  close(): void;
}

/**
 * Follows the stdout and stderr files of a macOS app `spawnOwned` started into `macos-app.ndjson` in `dir`, as client
 * records at info and warn, and writes the app's exit once its leader and group are gone and no process holds either
 * file open. Each append is recorded before and after it, so a stimd that restarts or hands over resumes without
 * repeating or skipping a line. Null while another live stimd tails the same directory. The exit code is not known:
 * no parent waits on the app.
 *
 * @ref LLP 0016#every-writer-gone -- the run ends only when no process holds the output open
 * @ref LLP 0016#each-line-once -- appends are recorded before and after, and one stimd tails a directory
 */
export function tailMacosApp(
  dir: string,
  app: MacosProcess,
  product: string,
  launchId: string,
  runId?: string,
): MacosTail | null {
  const claim = takeTailClaim(join(dir, TAIL_CLAIM));
  if (!claim) return null;
  const sink = join(dir, MACOS_APP_SINK);
  const markPath = join(dir, TAIL_MARK);
  const files = [
    {
      key: 'out' as const,
      pending: 'outPending' as const,
      level: 'info',
      path: join(dir, macosAppLogName(launchId, 'out')),
    },
    {
      key: 'err' as const,
      pending: 'errPending' as const,
      level: 'warn',
      path: join(dir, macosAppLogName(launchId, 'err')),
    },
  ];
  const record = (level: string, msg: string) =>
    `${JSON.stringify({ src: 'client', platform: 'macos', level, msg, ts: Date.now(), ...(runId ? { runId } : {}) })}\n`;
  const writeMark = (mark: Mark) => {
    const staging = `${markPath}.tmp`;
    writeFileSync(staging, JSON.stringify(mark), { mode: 0o600 });
    renameSync(staging, markPath);
  };
  let state = resumeState(readMark(dir), app.processToken, sink);
  let unsettled = true;
  const settle = () => {
    state = resumeState(readMark(dir), app.processToken, sink);
    writeMark({ processToken: app.processToken, ...state });
    unsettled = false;
  };
  const commit = (lines: string[], next: TailState) => {
    if (lines.length) {
      try {
        rotateLog(sink, LOG_ROTATE_BYTES);
      } catch {}
      const before = sinkIdentity(sink);
      unsettled = true;
      writeMark({
        processToken: app.processToken,
        ...state,
        pending: { ino: before?.ino ?? null, size: before?.size ?? 0, next },
      });
      ensurePrivateDir(dir);
      appendFileSync(sink, lines.join(''), { mode: 0o600 });
    }
    writeMark({ processToken: app.processToken, ...next });
    state = next;
    unsettled = false;
  };
  const buffer = Buffer.alloc(CHUNK_BYTES);
  const follow = (file: (typeof files)[number]): void => {
    if (unsettled) state = { ...resumeState(readMark(dir), app.processToken, sink), dropped: state.dropped };
    let size: number;
    try {
      size = statSync(file.path).size;
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    try {
      if (size < state[file.key]) commit([record('warn', DROPPED)], { ...state, [file.key]: 0, [file.pending]: '' });
      if (state[file.key] < size) {
        const fd = openSync(file.path, 'r');
        try {
          while (state[file.key] < size) {
            const at = state[file.key];
            const n = readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, size - at), at);
            if (n === 0) break;
            const split = splitLines(Buffer.from(state[file.pending], 'base64'), buffer.subarray(0, n), false);
            commit(
              split.lines.map((line) => record(file.level, line)),
              { ...state, [file.key]: at + n, [file.pending]: split.rest.toString('base64') },
            );
          }
        } finally {
          closeSync(fd);
        }
      }
      if (size >= LOG_ROTATE_BYTES && state[file.key] === size) {
        const split = splitLines(Buffer.from(state[file.pending], 'base64'), Buffer.alloc(0), true);
        commit(
          split.lines.map((line) => record(file.level, line)),
          { ...state, [file.pending]: '' },
        );
        truncateSync(file.path);
        commit([record('warn', DROPPED)], { ...state, [file.key]: 0 });
      }
    } catch (error) {
      unsettled = true;
      if (size >= LOG_ROTATE_BYTES) {
        state = resumeState(readMark(dir), app.processToken, sink);
        truncateSync(file.path);
        state = { ...state, [file.key]: 0, [file.pending]: '', dropped: true };
        unsettled = false;
        try {
          writeMark({ processToken: app.processToken, ...state });
        } catch {}
      }
      throw error;
    }
  };
  const pump = (): boolean => {
    let complete = true;
    try {
      if (unsettled) settle();
      if (state.dropped) commit([record('warn', DROPPED)], { ...state, dropped: false });
    } catch {
      unsettled = true;
      complete = false;
    }
    for (const file of files) {
      try {
        follow(file);
      } catch {
        complete = false;
      }
    }
    return complete;
  };
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  let done = false;
  let reason: string | null = null;
  let waiting = false;
  let probedAt = 0;
  let finishing: Promise<boolean> | null = null;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    releaseClaim(claim);
    end();
  };
  const conclude = (): boolean => {
    reason = null;
    stop();
    removeRawOutput(dir, launchId);
    return true;
  };
  const finish = (force: boolean): Promise<boolean> => {
    if (done) return Promise.resolve(state.exited);
    finishing ??= (async () => {
      waiting = false;
      try {
        if (unsettled) settle();
      } catch {
        reason = 'the macOS app output could not be read or recorded';
        return false;
      }
      if (state.exited) return conclude();
      if (!pump()) {
        reason = 'the macOS app output could not be read or recorded';
        return false;
      }
      const identity = inspectProcessIdentity(app);
      if (identity !== 'gone' && identity !== 'different') {
        reason =
          identity === 'unknown' ? 'the macOS app identity cannot be verified' : `the macOS app (pid ${app.pid}) runs`;
        return false;
      }
      if (processGroupAlive(app.pid)) {
        reason = `the macOS app exited but process group ${app.pid} remains`;
        waiting = true;
        return false;
      }
      if (!force && Date.now() - probedAt < WRITERS_PROBE_MS) return false;
      probedAt = Date.now();
      const writers = await outputWriters(files.map((file) => file.path));
      if (done) return state.exited;
      if (writers === null) {
        reason = 'lsof could not establish which processes hold the macOS app output open';
        return false;
      }
      if (writers.length) {
        reason = `the macOS app exited but pid ${writers.join(', ')} still holds its output open`;
        waiting = true;
        return false;
      }
      if (!pump()) {
        reason = 'the macOS app output could not be read or recorded';
        return false;
      }
      try {
        const lines: string[] = [];
        for (const file of files) {
          const split = splitLines(Buffer.from(state[file.pending], 'base64'), Buffer.alloc(0), true);
          lines.push(...split.lines.map((line) => record(file.level, line)));
        }
        lines.push(record('info', `Exited ${product}.`));
        commit(lines, {
          ...state,
          outPending: '',
          errPending: '',
          exited: true,
        });
      } catch {
        unsettled = true;
        reason = 'the macOS app output could not be recorded';
        return false;
      }
      return conclude();
    })().finally(() => {
      finishing = null;
    });
    return finishing;
  };
  try {
    settle();
  } catch {
    unsettled = true;
  }
  const timer = setInterval(() => void finish(false), TAIL_MS);
  timer.unref();
  return {
    token: app.processToken,
    ended,
    drain: () => finish(true),
    blocked: () => reason,
    waiting: () => waiting,
    ready() {
      try {
        for (const file of files) closeSync(openSync(file.path, 'r+'));
        if (!pump()) return 'the macOS output is unavailable or could not be recorded';
        if (!state.observed)
          commit([record('info', `Observing ${product} output.`)], {
            ...state,
            observed: true,
          });
        return null;
      } catch (error) {
        unsettled = true;
        return `the macOS output is unavailable or could not be recorded: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    close: stop,
  };
}
