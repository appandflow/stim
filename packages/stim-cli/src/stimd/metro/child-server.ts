import type { ChildProcess } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NdjsonRecord, NdjsonWriter } from '../../ndjson.ts';
import { createLineReader } from '../../process-output.ts';
import { cancellableSleep } from '../../cancellation.ts';
import { captureProcessToken, inspectProcessIdentity } from '../../process-identity.ts';

interface ChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface ChildServerHandle {
  mode: string;
  serverPid: number | null;
  processToken: string | null;
  observesRequests?: boolean;
  child: ChildProcess;
  /** The follower of the child's output files, when it writes files instead of pipes. */
  tail?: OutputTail | null;
  onExit(cb: (info: ChildExitInfo | null) => void): void;
  close(): Promise<void>;
}

/** Where a child that outlives its parent writes: one file per stream in its workspace's logs directory. */
export interface ChildOutput {
  stdout: string;
  stderr: string;
}

const TAIL_MS = 200;
const STREAMS: ('stdout' | 'stderr')[] = ['stdout', 'stderr'];

function size(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Opens `metro.<stream>.log` in `logsDir`, emptied, for a new child's stdio, so they hold one child's output. The caller
 * closes the descriptors once spawned.
 */
export function openChildOutput(logsDir: string): { files: ChildOutput; fds: [number, number] } {
  const files = { stdout: join(logsDir, 'metro.stdout.log'), stderr: join(logsDir, 'metro.stderr.log') };
  return { files, fds: [openSync(files.stdout, 'w', 0o600), openSync(files.stderr, 'w', 0o600)] };
}

export interface OutputTail {
  stop(): void;
  /** How far each file has been read, for a successor to go on from. */
  offsets(): Record<'stdout' | 'stderr', number>;
}

/** Feeds what the child appends to its output files after `from` (by default their current ends) to `onChunk`. */
export function tailChildOutput(
  files: ChildOutput,
  onChunk: (chunk: string, stream: 'stdout' | 'stderr') => void,
  from: Record<'stdout' | 'stderr', number> = { stdout: size(files.stdout), stderr: size(files.stderr) },
): OutputTail {
  const offsets = { ...from };
  const read = () => {
    for (const stream of STREAMS) {
      const end = size(files[stream]);
      if (end < offsets[stream]) offsets[stream] = 0;
      if (end === offsets[stream]) continue;
      const buffer = Buffer.alloc(end - offsets[stream]);
      const fd = openSync(files[stream], 'r');
      try {
        readSync(fd, buffer, 0, buffer.length, offsets[stream]);
      } finally {
        closeSync(fd);
      }
      offsets[stream] = end;
      onChunk(buffer.toString('utf8'), stream);
    }
  };
  const timer = setInterval(() => {
    try {
      read();
    } catch {}
  }, TAIL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      try {
        read();
      } catch {}
    },
    offsets: () => ({ ...offsets }),
  };
}

/** Turns a child's output into `metro.ndjson` records, dropping a repeat of the same line within a second. */
export function childRecords({
  log,
  toRecord,
  onRecord = null,
}: {
  log: NdjsonWriter;
  toRecord: (chunk: unknown, stream: 'stdout' | 'stderr') => NdjsonRecord | null;
  onRecord?: ((record: NdjsonRecord) => void) | null;
}): { push(chunk: unknown, stream: 'stdout' | 'stderr'): void; flush(): void } {
  let lastMsg: string | null = null;
  let lastAt = 0;
  const emit = (stream: 'stdout' | 'stderr') => (chunk: unknown) => {
    const record = toRecord(chunk, stream);
    if (!record) return;
    if (typeof record.requestId !== 'string') {
      const now = Date.now();
      if (record.msg === lastMsg && now - lastAt < 1000) return;
      lastMsg = typeof record.msg === 'string' ? record.msg : null;
      lastAt = now;
    }
    log.write(record);
    onRecord?.(record);
  };
  const readers = { stdout: createLineReader(emit('stdout')), stderr: createLineReader(emit('stderr')) };
  return {
    push: (chunk, stream) => readers[stream].push(chunk),
    flush: () => {
      readers.stdout.flush();
      readers.stderr.flush();
    },
  };
}

export function superviseChildServer({
  mode,
  child,
  log,
  toRecord,
  signal,
  alive = null,
  killTimeoutMs,
  onRecord = null,
  output = null,
}: {
  mode: string;
  child: ChildProcess;
  log: NdjsonWriter;
  toRecord: (chunk: unknown, stream: 'stdout' | 'stderr') => NdjsonRecord | null;
  signal: (sig: NodeJS.Signals) => boolean;
  alive?: (() => boolean) | null;
  killTimeoutMs: number;
  onRecord?: ((record: NdjsonRecord) => void) | null;
  /** The files, emptied by `openChildOutput`, the child writes instead of pipes, which are followed instead. */
  output?: ChildOutput | null;
}): ChildServerHandle {
  const records = childRecords({ log, toRecord, onRecord });
  const processToken = child.pid ? captureProcessToken(child.pid) : null;
  child.stdout?.setEncoding?.('utf-8');
  child.stderr?.setEncoding?.('utf-8');
  child.stdout?.on('data', (chunk) => records.push(chunk, 'stdout'));
  child.stderr?.on('data', (chunk) => records.push(chunk, 'stderr'));
  const tail = output ? tailChildOutput(output, records.push, { stdout: 0, stderr: 0 }) : null;

  let exited = false;
  let exitInfo: ChildExitInfo | null = null;
  const listeners: ((info: ChildExitInfo | null) => void)[] = [];
  child.on('exit', (code, sig) => {
    exited = true;
    exitInfo = { code, signal: sig };
    tail?.stop();
    records.flush();
    for (const cb of listeners) cb(exitInfo);
  });
  child.on('error', (err) => {
    if (exited) return;
    exited = true;
    exitInfo = { code: null, signal: null, error: err };
    for (const cb of listeners) cb(exitInfo);
  });

  return {
    mode,
    serverPid: child.pid ?? null,
    processToken,
    child,
    tail,
    onExit(cb) {
      if (exited) {
        cb(exitInfo);
        return;
      }
      listeners.push(cb);
    },
    async close() {
      const running = () => (alive ? alive() : !exited && Boolean(child.pid));
      const gone = async () => {
        const deadline = Date.now() + killTimeoutMs;
        while (running() && Date.now() < deadline) await cancellableSleep(25, { ref: false });
        return !running();
      };
      if (!running()) return;
      const verify = () => {
        if (
          alive &&
          (!child.pid || !processToken || inspectProcessIdentity({ pid: child.pid, processToken }) !== 'same')
        )
          throw new Error(`Could not verify the dev-server process group for pid ${child.pid ?? 'unknown'}.`);
      };
      verify();
      signal('SIGTERM');
      if (!(await gone())) {
        verify();
        signal('SIGKILL');
        if (!(await gone())) throw new Error(`Could not confirm shutdown of dev-server pid ${child.pid ?? 'unknown'}.`);
      }
    },
  };
}
