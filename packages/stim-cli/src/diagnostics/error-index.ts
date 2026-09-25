import { rotatedLogPath } from '@stim-cli/core';
import { closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { type NdjsonRecord, parseNdjsonLine } from '../ndjson.ts';
import { ERROR_SOURCES, logFiles, queryLogs, recordMatches } from './logs-query.ts';

const INDEX_VERSION = 1;
const HEAD_BYTES = 1024;
const TAIL_BYTES = 256;
const CHUNK_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;
const CANDIDATE_PATTERNS = ['"level":"error"', '"level":"fatal"', '"marker":true'].map((p) => Buffer.from(p));
const ERROR_CRITERIA = { errorsOnly: true, sources: ERROR_SOURCES, includeNativeCrashes: true };

interface FileSummary {
  offset: number;
  head: string;
  tail: string;
  markers: Record<string, NdjsonRecord>;
  errors: NdjsonRecord[];
}

interface ErrorIndex {
  version: number;
  files: Record<string, FileSummary>;
}

/**
 * The number of records `queryLogs({ dir, errorsOnly: true })` returns, without parsing every
 * line on every call. `indexFile` keeps, per log file generation, the markers and error records
 * already read and the byte offset they were read through; a later call reads only what was
 * appended since. The index is a cache: losing it or a concurrent writer only costs a rescan.
 */
export function countErrorsSinceMarker(dir: string, indexFile: string): number {
  const previous = readIndex(indexFile);
  const files: Record<string, FileSummary> = {};
  let changed = false;
  for (const name of logFiles(dir)) {
    const current = join(dir, name);
    for (const path of [rotatedLogPath(current), current]) {
      const result = summarize(path, previous.files);
      if (!result) continue;
      files[result.key] = result.summary;
      if (result.changed) changed = true;
    }
  }
  if (changed || Object.keys(files).length !== Object.keys(previous.files).length) {
    writeIndex(indexFile, { version: INDEX_VERSION, files });
  }
  const records: NdjsonRecord[] = [];
  for (const summary of Object.values(files)) {
    records.push(...Object.values(summary.markers), ...summary.errors);
  }
  return queryLogs({ records, errorsOnly: true }).length;
}

function summarize(
  path: string,
  known: Record<string, FileSummary>,
): { key: string; summary: FileSummary; changed: boolean } | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const { dev, ino, size } = fstatSync(fd);
    const key = `${dev}:${ino}`;
    const cached = known[key];
    const base = cached && stillExtends(fd, cached, size) ? cached : null;
    const start = base ?? { offset: 0, head: '', tail: '', markers: {}, errors: [] };
    if (size <= start.offset) return { key, summary: start, changed: !base };
    const summary = readFrom(fd, start, size);
    return { key, summary, changed: !base || summary.offset !== start.offset };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function stillExtends(fd: number, summary: FileSummary, size: number): boolean {
  if (size < summary.offset) return false;
  const head = Buffer.from(summary.head, 'base64');
  const tail = Buffer.from(summary.tail, 'base64');
  return readAt(fd, 0, head.length).equals(head) && readAt(fd, summary.offset - tail.length, tail.length).equals(tail);
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const read = length > 0 ? readSync(fd, buf, 0, length, position) : 0;
  return buf.subarray(0, read);
}

function readFrom(fd: number, start: FileSummary, size: number): FileSummary {
  const markers = { ...start.markers };
  const errors = [...start.errors];
  let offset = start.offset;
  let chunk = CHUNK_BYTES;
  while (offset < size) {
    const buf = readAt(fd, offset, Math.min(chunk, size - offset));
    if (buf.length === 0) break;
    const end = buf.lastIndexOf(NEWLINE);
    if (end === -1) {
      if (offset + buf.length >= size) break;
      chunk *= 2;
      continue;
    }
    for (const record of candidateRecords(buf.subarray(0, end + 1))) collect(record, markers, errors);
    offset += end + 1;
  }
  if (offset === start.offset) return start;
  return {
    offset,
    head: start.offset >= HEAD_BYTES ? start.head : readAt(fd, 0, Math.min(HEAD_BYTES, offset)).toString('base64'),
    tail: readAt(fd, Math.max(0, offset - TAIL_BYTES), Math.min(TAIL_BYTES, offset)).toString('base64'),
    markers,
    errors,
  };
}

function candidateRecords(region: Buffer): NdjsonRecord[] {
  const lineStarts = new Set<number>();
  for (const pattern of CANDIDATE_PATTERNS) {
    for (let hit = region.indexOf(pattern); hit !== -1; hit = region.indexOf(pattern, hit + pattern.length)) {
      lineStarts.add(region.lastIndexOf(NEWLINE, hit) + 1);
    }
  }
  const records: NdjsonRecord[] = [];
  for (const lineStart of [...lineStarts].toSorted((a, b) => a - b)) {
    const record = parseNdjsonLine(region.toString('utf-8', lineStart, region.indexOf(NEWLINE, lineStart)));
    if (record) records.push(record);
  }
  return records;
}

function collect(record: NdjsonRecord, markers: Record<string, NdjsonRecord>, errors: NdjsonRecord[]): void {
  const ts = typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : null;
  if (record.marker === true && ts !== null) {
    const metro = record.src === 'metro';
    const slot = record.slot ?? 'default';
    const key = metro ? 'metro' : JSON.stringify(['launch', slot]);
    if ((markers[key]?.ts ?? -Infinity) < ts) {
      markers[key] = metro ? { src: 'metro', marker: true, ts } : { marker: true, ts, slot };
    }
  }
  if (recordMatches(record, ERROR_CRITERIA)) {
    errors.push({ src: record.src, level: record.level, event: record.event, ts: ts ?? undefined, slot: record.slot });
  }
}

function readIndex(file: string): ErrorIndex {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ErrorIndex;
    if (parsed?.version === INDEX_VERSION && parsed.files && typeof parsed.files === 'object') return parsed;
  } catch {}
  return { version: INDEX_VERSION, files: {} };
}

function writeIndex(file: string, index: ErrorIndex): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(index));
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
  }
}
