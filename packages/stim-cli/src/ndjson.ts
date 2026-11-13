import { ensurePrivateDir, rotateLog } from '@stim-cli/core';
import { runId, type NdjsonRecord } from '@stim-cli/core/state';
import { closeSync, openSync, writeSync } from 'fs';
import { dirname } from 'path';
import { StringDecoder } from 'node:string_decoder';

export {
  createNdjsonTail,
  LEVELS,
  levelRank,
  parseNdjsonLine,
  parseNdjsonText,
  readNdjsonGenerations,
  SOURCES,
  type NdjsonRecord,
} from '@stim-cli/core/state';

export interface NdjsonWriter {
  readonly file: string;
  write(record: unknown): boolean;
  close(): { file: string; written: number; dropped: number; lastError: Error | null };
  readonly written: number;
  readonly dropped: number;
  readonly lastError: Error | null;
}

const ROTATE_CHECK_MS = 1000;

function formatNdjsonLine(record: unknown): string | null {
  try {
    return `${JSON.stringify(record)}\n`;
  } catch {
    return null;
  }
}

export function createNdjsonWriter(
  file: string,
  {
    truncate = false,
    fields = {},
    maxBytes,
    now = Date.now,
    reportFailures = false,
  }: {
    truncate?: boolean;
    fields?: Record<string, unknown>;
    maxBytes?: number;
    now?: () => number;
    /** Print the first failure of a streak to stderr, and log the dropped count and last error when writes recover. */
    reportFailures?: boolean;
  } = {},
): NdjsonWriter {
  let fd: number | null = null;
  let freshFile = truncate;
  let uncheckedBytes = 0;
  let checkedAt = 0;
  let written = 0;
  let dropped = 0;
  let lastError: Error | null = null;
  let closed = false;
  let failing = false;
  let droppedAtFailure = 0;

  function open(): void {
    ensurePrivateDir(dirname(file));
    fd = openSync(file, freshFile ? 'w' : 'a', 0o600);
    freshFile = false;
  }

  function rotateIfDue(limit: number): void {
    if (fd !== null && uncheckedBytes < limit / 8 && now() - checkedAt < ROTATE_CHECK_MS) return;
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
      fd = null;
    }
    uncheckedBytes = 0;
    checkedAt = now();
    try {
      rotateLog(file, limit);
    } catch {}
  }

  function write(record: unknown): boolean {
    if (closed) {
      dropped += 1;
      return false;
    }
    const line = formatNdjsonLine({ ...stamp(record), ...fields });
    if (line === null) {
      dropped += 1;
      lastError = new TypeError('record could not be serialized to JSON');
      return false;
    }
    try {
      if (maxBytes !== undefined) rotateIfDue(maxBytes);
      if (fd === null) open();
      writeSync(fd as number, line);
      uncheckedBytes += Buffer.byteLength(line);
      written += 1;
      if (failing) {
        failing = false;
        const lost = dropped - droppedAtFailure;
        write({
          src: 'stimd',
          level: 'warn',
          event: 'log_writer_dropped',
          msg: `the log writer dropped ${lost} records: ${lastError?.message}`,
          dropped: lost,
          lastError: lastError?.message,
        });
      }
      return true;
    } catch (err) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
        fd = null;
      }
      dropped += 1;
      lastError = err as Error;
      if (reportFailures && !failing) {
        failing = true;
        droppedAtFailure = dropped - 1;
        try {
          writeSync(2, `stimd: cannot write ${file}: ${lastError.message}\n`);
        } catch {}
      }
      return false;
    }
  }

  function close(): { file: string; written: number; dropped: number; lastError: Error | null } {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
      fd = null;
    }
    closed = true;
    return { file, written, dropped, lastError };
  }

  return {
    file,
    write,
    close,
    get written() {
      return written;
    },
    get dropped() {
      return dropped;
    },
    get lastError() {
      return lastError;
    },
  };
}

function stamp(record: unknown): NdjsonRecord {
  const base: NdjsonRecord =
    record && typeof record === 'object' && !Array.isArray(record) ? (record as NdjsonRecord) : { msg: String(record) };
  const withRun = typeof base.runId === 'string' ? base : { ...base, runId: runId() };
  if (typeof base.ts === 'number' && Number.isFinite(base.ts)) return withRun;
  return { ...withRun, ts: Date.now() };
}

export function logLines(stream: NodeJS.ReadableStream, write: (line: string) => void): void {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  stream.on('data', (chunk: Buffer) => {
    pending += decoder.write(chunk);
    while (pending.length > 65536 && !pending.includes('\n')) {
      write(pending.slice(0, 65536));
      pending = pending.slice(65536);
    }
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) write(line.replace(/\r$/, ''));
  });
  stream.on('end', () => {
    pending += decoder.end();
    if (pending) write(pending);
  });
}
