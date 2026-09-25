import { rotateLog } from '@stim-cli/core';
import type { NdjsonRecord } from '@stim-cli/core/state';
import { closeSync, mkdirSync, openSync, writeSync } from 'fs';
import { dirname } from 'path';

export {
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

export function formatNdjsonLine(record: unknown): string | null {
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
  }: { truncate?: boolean; fields?: Record<string, unknown>; maxBytes?: number; now?: () => number } = {},
): NdjsonWriter {
  let fd: number | null = null;
  let freshFile = truncate;
  let uncheckedBytes = 0;
  let checkedAt = 0;
  let written = 0;
  let dropped = 0;
  let lastError: Error | null = null;
  let closed = false;

  function open(): void {
    mkdirSync(dirname(file), { recursive: true });
    fd = openSync(file, freshFile ? 'w' : 'a');
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
  if (typeof base.ts === 'number' && Number.isFinite(base.ts)) return base;
  return { ...base, ts: Date.now() };
}
