import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES, withDirLock } from '@stim-cli/core';
import {
  assertHostedDeviceLedger,
  hostedAppArea,
  hostedIosLogsDir,
  readHostedAppMetadata,
  readHostedDevice,
  readHostedIosLogsCheckpoint,
  type NdjsonRecord,
} from '@stim-cli/core/state';
import { parseLogStreamLine } from '../collector/ios.ts';
import { getExecutor } from '../exec.ts';
import { createNdjsonWriter } from '../ndjson.ts';

function logDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', '+0000');
}

/** Captures a bounded unified-log window only from this home's exact ledger-owned simulator. */
export function collectHostedIosLogs(home: string, session: string, attempt: string, since: number): boolean {
  const device = readHostedDevice(home);
  assertHostedDeviceLedger(home, device.udid);
  const record = readHostedAppMetadata(session, attempt, home);
  if (record.state !== 'installed') return false;
  const directory = hostedIosLogsDir(home);
  const previous = readHostedIosLogsCheckpoint(home);
  const from = previous?.until ?? Math.floor(since / 1000) * 1000;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const until = Math.min(now, from + 60_000);
  if (until < from) return false;
  const end = until === now ? until + 1000 : until;
  const exec = getExecutor();
  const executable = exec.runFile(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleExecutable', join(hostedAppArea(session, attempt, home), 'App.app', 'Info.plist')],
    { timeoutMs: 10_000, killSignal: 'SIGKILL' },
  );
  if (!executable || /["\\/\0\r\n]/.test(executable))
    throw new Error('The app executable cannot form a log predicate.');
  const output = exec.runFile(
    'xcrun',
    [
      'simctl',
      'spawn',
      device.udid,
      'log',
      'show',
      '--style',
      'ndjson',
      '--predicate',
      `processImagePath ENDSWITH "/App.app/${executable}"`,
      '--info',
      '--start',
      logDate(from),
      '--end',
      logDate(end),
    ],
    { timeoutMs: 10_000, killSignal: 'SIGKILL' },
  );
  const seen = new Map<string, number>();
  for (const digest of previous?.boundary ?? []) seen.set(digest, (seen.get(digest) ?? 0) + 1);
  const boundary: string[] = [];
  const records: NdjsonRecord[] = [];
  for (const line of output.split('\n')) {
    const parsed = parseLogStreamLine(line);
    if (!parsed || typeof parsed.ts !== 'number' || parsed.ts < from || parsed.ts > end) continue;
    const digest = createHash('sha256').update(line.trim()).digest('hex');
    if (parsed.ts >= until) boundary.push(digest);
    const count = parsed.ts < from + 1000 ? (seen.get(digest) ?? 0) : 0;
    if (count) {
      seen.set(digest, count - 1);
      continue;
    }
    records.push({ ...parsed, platform: 'ios' });
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  withDirLock(join(directory, 'query.lock'), () => {
    const writer = createNdjsonWriter(join(directory, 'device.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
    try {
      for (const entry of records) {
        if (!writer.write(entry)) throw new Error('Could not persist hosted iOS native logs.');
      }
    } finally {
      writer.close();
    }
    const temporary = join(directory, 'checkpoint.json.tmp');
    try {
      writeFileSync(temporary, JSON.stringify({ until, boundary }), { mode: 0o600 });
      renameSync(temporary, join(directory, 'checkpoint.json'));
    } finally {
      rmSync(temporary, { force: true });
    }
  });
  return until < now;
}
