import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES, withDirLock } from '@stim-cli/core';
import {
  hostedNativeLogsDir,
  readHostedNativeLogsCheckpoint,
  readNdjsonGenerations,
  type NdjsonRecord,
} from '@stim-cli/core/state';
import { createNdjsonWriter } from '../ndjson.ts';

export function collectHostedNativeLogs({
  home,
  platform,
  since,
  final,
  query,
  parse,
  tailOnly = false,
  deadline = Date.now() + 10_000,
  identity = {},
}: {
  home: string;
  platform: 'ios' | 'android';
  since: number;
  final: boolean;
  query: (from: number, end: number, timeoutMs: number) => string;
  parse: (line: string) => { record: NdjsonRecord; digest: string } | null;
  tailOnly?: boolean;
  deadline?: number;
  identity?: { appAttempt?: string; pid?: number };
}): boolean {
  const directory = hostedNativeLogsDir(home, platform);
  const previous = readHostedNativeLogsCheckpoint(home, platform);
  const beginning = Math.floor(since / 1000) * 1000;
  let newest: number | undefined;
  if (!previous)
    for (const entry of readNdjsonGenerations(join(directory, 'device.ndjson')))
      if (typeof entry.ts === 'number' && (newest === undefined || entry.ts > newest)) newest = entry.ts;
  const checkpoint = previous?.until ?? Math.max(beginning, Math.floor((newest ?? beginning) / 1000) * 1000);
  let from = Math.max(beginning, previous ? checkpoint - 5000 : checkpoint);
  const now = Math.floor(Date.now() / 1000) * 1000;
  if (now < checkpoint) return false;
  const backlogMs = Math.max(1000, now - checkpoint);
  let windowMs = !final && !tailOnly && previous?.windowMs ? Math.min(previous.windowMs * 2, backlogMs) : backlogMs;
  let until = Math.min(now, checkpoint + windowMs);
  let end = until === now ? until + 1000 : until;
  let output: string;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Hosted native log query exceeded its collection budget.');
    try {
      output = query(from, end, Math.min(remaining, 4000));
      break;
    } catch (error) {
      const span = final || tailOnly ? until - from : until - checkpoint;
      if (span <= 1000) throw error;
      windowMs = Math.max(1000, Math.floor(span / 4 / 1000) * 1000);
      if (final || tailOnly) from = Math.max(beginning, now - windowMs);
      else until = Math.min(now, checkpoint + windowMs);
      end = until === now ? until + 1000 : until;
      if (previous) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        withDirLock(join(directory, 'query.lock'), () => {
          const temporary = join(directory, 'checkpoint.json.tmp');
          writeFileSync(temporary, JSON.stringify({ ...previous, until: checkpoint, windowMs }), {
            mode: 0o600,
          });
          renameSync(temporary, join(directory, 'checkpoint.json'));
        });
      }
    }
  }
  const seen = new Map<string, number>();
  for (const digest of previous?.boundary ?? []) seen.set(digest, (seen.get(digest) ?? 0) + 1);
  const boundary: string[] = [];
  const records: NdjsonRecord[] = [];
  if (from > checkpoint)
    records.push({
      ts: from,
      src: 'device',
      platform,
      level: 'warn',
      msg: `Hosted ${platform === 'ios' ? 'iOS' : 'Android'} native log gap: dropped interval [${new Date(checkpoint).toISOString()}, ${new Date(from).toISOString()}) to collect the tail within its budget.`,
    });
  for (const line of output.split('\n')) {
    const event = parse(line);
    if (!event) continue;
    const { record: parsed, digest } = event;
    if (typeof parsed.ts !== 'number' || parsed.ts < from || parsed.ts > end) continue;
    if (parsed.ts >= until - 5000) boundary.push(digest);
    if (newest !== undefined && parsed.ts <= newest) continue;
    const count = seen.get(digest) ?? 0;
    if (count) {
      seen.set(digest, count - 1);
      continue;
    }
    records.push({ ...parsed, platform });
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  withDirLock(join(directory, 'query.lock'), () => {
    const writer = createNdjsonWriter(join(directory, 'device.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
    try {
      for (const entry of records) {
        if (!writer.write(entry)) throw new Error('Could not persist hosted native logs.');
      }
    } finally {
      writer.close();
    }
    const temporary = join(directory, 'checkpoint.json.tmp');
    try {
      writeFileSync(temporary, JSON.stringify({ until, boundary, ...identity, ...(until < now ? { windowMs } : {}) }), {
        mode: 0o600,
      });
      renameSync(temporary, join(directory, 'checkpoint.json'));
    } finally {
      rmSync(temporary, { force: true });
    }
  });
  return until < now;
}
