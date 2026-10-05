import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceName } from '../index.ts';
import { isJsonObject } from './json-file.ts';
import { logFiles } from './logs-query.ts';
import { parseNdjsonText, type NdjsonRecord } from './ndjson.ts';

export type HostedLogsCursor = Record<string, number>;

export interface HostedLogsPage {
  records: NdjsonRecord[];
  cursor: HostedLogsCursor;
  /** True when the budget ended this page before the end of the logs; ask again with `cursor`. */
  more: boolean;
}

export const HOSTED_LOGS_PAGE_BYTES: number = 1024 ** 2;
export const HOSTED_LOGS_FIRST_BYTES: number = 4 * 1024 ** 2;

const LOG_FILE = /^[A-Za-z0-9._-]{1,128}\.ndjson$/;

export function parseHostedLogsCursor(value: unknown): HostedLogsCursor | null {
  if (!isJsonObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 16) return null;
  const cursor: HostedLogsCursor = {};
  for (const [name, offset] of entries) {
    if (!LOG_FILE.test(name) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null;
    cursor[name] = offset;
  }
  return cursor;
}

export function hostedMacosLogsDir(home: string): string | null {
  try {
    return join(home, 'workspaces', workspaceName(realpathSync(join(home, 'macos-app'))), 'logs');
  } catch {
    return null;
  }
}

function readSpan(path: string, from: number, to: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(to - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function readLines(
  path: string,
  from: number,
  size: number,
  limit: number,
  aligned: boolean,
): { records: NdjsonRecord[]; offset: number } {
  const bytes = readSpan(path, from, Math.min(size, from + limit));
  let start = 0;
  if (!aligned) {
    const first = bytes.indexOf(0x0a);
    start = first < 0 ? bytes.length : first + 1;
  }
  const end = bytes.lastIndexOf(0x0a) + 1;
  return {
    records: end > start ? parseNdjsonText(bytes.subarray(start, end).toString('utf8')) : [],
    offset: from + Math.max(start, end),
  };
}

/**
 * The records in `dir` after `cursor`, in file order. A file without a cursor entry starts at most
 * {@link HOSTED_LOGS_FIRST_BYTES} before its end. A file that shrank since the cursor was taken was rotated: the end of
 * its previous generation is read first, and only as much of it as the page budget allows.
 */
export function readLogsSince(dir: string, cursor: HostedLogsCursor): HostedLogsPage {
  const records: NdjsonRecord[] = [];
  const next: HostedLogsCursor = {};
  let budget = HOSTED_LOGS_PAGE_BYTES;
  let more = false;
  for (const name of logFiles(dir)) {
    const path = join(dir, name);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    let offset = cursor[name];
    if (offset !== undefined && offset > size) {
      const previous = `${path}.1`;
      try {
        const previousSize = statSync(previous).size;
        if (previousSize > offset) {
          const from = Math.max(offset, previousSize - budget);
          records.push(...readLines(previous, from, previousSize, budget, from === offset).records);
          budget -= previousSize - from;
        }
      } catch {}
      offset = 0;
    }
    const from = offset ?? Math.max(0, size - HOSTED_LOGS_FIRST_BYTES);
    const reading = Math.min(budget, size - from);
    const page = reading > 0 ? readLines(path, from, size, reading, offset !== undefined || from === 0) : null;
    if (page) records.push(...page.records);
    budget -= reading;
    next[name] = page ? page.offset : from;
    if (from + reading < size) more = true;
  }
  return { records, cursor: next, more };
}
