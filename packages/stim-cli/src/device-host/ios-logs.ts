import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertHostedDeviceLedger, hostedAppArea, readHostedAppMetadata, readHostedDevice } from '@stim-cli/core/state';
import { parseLogStreamLine } from '../collector/ios.ts';
import { getExecutor } from '../exec.ts';
import { collectHostedNativeLogs } from './native-logs.ts';

function logDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', '+0000');
}

/** Captures a bounded unified-log window only from this home's exact ledger-owned simulator. */
export function collectHostedIosLogs(
  home: string,
  session: string,
  attempt: string,
  since: number,
  final = false,
): boolean {
  const device = readHostedDevice(home);
  assertHostedDeviceLedger(home, device.udid);
  if (readHostedAppMetadata(session, attempt, home).state !== 'installed') return false;
  const deadline = Date.now() + 10_000;
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
