import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { LOG_ROTATE_BYTES, withDirLock } from '@stim-cli/core';
import { join } from 'node:path';
import {
  assertHostedDeviceLedger,
  hostedAppArea,
  readHostedAppMetadata,
  readHostedDevice,
  hostedNativeLogsDir,
  isJsonObject,
} from '@stim-cli/core/state';
import { parseLogStreamLine } from '../stimd/logs/ios.ts';
import { getExecutor } from '../exec.ts';
import { collectHostedNativeLogs } from './native-logs.ts';
import { readIosCrashReports } from '../diagnostics/native-crash.ts';
import { createNdjsonWriter, readNdjsonGenerations } from '../ndjson.ts';

function logDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', '+0000');
}

/**
 * Captures bounded console and crash logs only for this home's ledger-owned simulator and installed app.
 * Crash incident deduplication covers retained crash-log generations; an evicted incident can reappear if its OS
 * report remains discoverable.
 */
export async function collectHostedIosLogs(
  home: string,
  session: string,
  attempt: string,
  since: number,
  env: NodeJS.ProcessEnv,
  final = false,
): Promise<boolean> {
  const device = readHostedDevice(home);
  assertHostedDeviceLedger(home, device.udid);
  const app = readHostedAppMetadata(session, attempt, home);
  if (app.state !== 'installed') return false;
  const deadline = Date.now() + 10_000;
  await collectHostedIosCrashes(home, device.udid, app.bundleId, since, deadline, env);
  const exec = getExecutor();
  const executable = exec.runFile(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleExecutable', join(hostedAppArea(session, attempt, home), 'App.app', 'Info.plist')],
    { timeoutMs: 2000, killSignal: 'SIGKILL' },
  );
  if (!executable || /["\\/\0\r\n]/.test(executable))
    throw new Error('The app executable cannot form a log predicate.');
  return collectHostedNativeLogs({
    home,
    platform: 'ios',
    deadline,
    since,
    final,
    query: (from, end, timeoutMs) =>
      exec.runFile(
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
        { timeoutMs, killSignal: 'SIGKILL' },
      ),
    parse: (line) => {
      const record = parseLogStreamLine(line);
      if (!record) return null;
      const entry = JSON.parse(line) as Record<string, unknown>;
      const digest = createHash('sha256')
        .update(JSON.stringify(Object.entries(entry).toSorted(([a], [b]) => a.localeCompare(b))))
        .digest('hex');
      return { record, digest };
    },
  });
}

async function collectHostedIosCrashes(
  home: string,
  deviceId: string,
  appId: string,
  since: number,
  deadline: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const records = await readIosCrashReports(
    {
      platform: 'ios',
      deviceId,
      appId,
      since,
    },
    deadline,
    signal,
    env,
  ).catch(() => []);
  if (!records.length) return;
  const hostHome = env.HOME || homedir();
  const text = (value: string, limit: number) =>
    value
      .replaceAll(new RegExp(deviceId, 'gi'), '<hosted-simulator>')
      .replaceAll(hostHome, '<host-home>')
      .slice(0, limit);
  const file = join(hostedNativeLogsDir(home, 'ios'), 'native-crashes.ndjson');
  mkdirSync(hostedNativeLogsDir(home, 'ios'), { recursive: true });
  withDirLock(join(hostedNativeLogsDir(home, 'ios'), 'query.lock'), () => {
    const seen = new Set(
      readNdjsonGenerations(file)
        .filter((record) => record.event === 'native_crash')
        .map((record) => record.incident),
    );
    const writer = createNdjsonWriter(file, { maxBytes: LOG_ROTATE_BYTES });
    try {
      for (const record of records) {
        if (typeof record.incident !== 'string') continue;
        const incident = record.incident.slice(0, 256);
        if (seen.has(incident)) continue;
        if (
          !writer.write({
            ts: record.ts,
            src: 'device',
            platform: 'ios',
            level: 'fatal',
            event: 'native_crash',
            incident,
            appId,
            msg: text(String(record.msg), 8192),
            stack: Array.isArray(record.stack)
              ? record.stack
                  .slice(0, 32)
                  .filter(isJsonObject)
                  .map((frame) => ({
                    file: text(typeof frame.file === 'string' ? frame.file : '<unknown image>', 256),
                    fn: text(typeof frame.fn === 'string' ? frame.fn : '<unknown symbol>', 512),
                    line: typeof frame.line === 'number' ? frame.line : undefined,
                  }))
              : [],
          })
        )
          throw new Error('Could not persist hosted iOS crash summary.');
        seen.add(incident);
      }
    } finally {
      writer.close();
    }
  });
}
