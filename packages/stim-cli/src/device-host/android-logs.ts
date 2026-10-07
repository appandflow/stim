import { createHash } from 'node:crypto';
import { readHostedAppMetadata, readHostedDevice, readHostedNativeLogsCheckpoint } from '@stim-cli/core/state';
import { androidClockOffset, parseLogcatLine, parsePidof } from '../collector/android.ts';
import { androidToolPath } from '../devices/android.ts';
import { getExecutor } from '../exec.ts';
import { assertHostedAndroidSerial } from './android-app.ts';
import { collectHostedNativeLogs } from './native-logs.ts';

/** Captures bounded logcat output from the installed app on this home's exact ledger-owned serial. */
export function collectHostedAndroidLogs(
  home: string,
  session: string,
  attempt: string,
  since: number,
  final = false,
): boolean {
  const deadline = Date.now() + 10_000;
  const device = readHostedDevice(home, 'android');
  assertHostedAndroidSerial(home, device);
  const app = readHostedAppMetadata(session, attempt, home);
  if (app.state !== 'installed') return false;
  const exec = getExecutor();
  const adb = androidToolPath('adb');
  const clockOffsetMs =
    androidClockOffset(device.serial, {
      exec: { ...exec, runFile: (file, args, options) => exec.runFile(file === 'adb' ? adb : file, args, options) },
    }) ?? 0;
  const previous = readHostedNativeLogsCheckpoint(home, 'android');
  let current: number | null = null;
  try {
    current = parsePidof(
      exec.runFile(adb, ['-s', device.serial, 'shell', 'pidof', app.bundleId], {
        timeoutMs: 2000,
        killSignal: 'SIGKILL',
      }),
    );
  } catch {}
  // Android logcat identifies historical records by PID and cannot distinguish reuse after a process exits.
  const prior = previous?.appAttempt === attempt ? previous.pid : undefined;
  const pids = new Set([current, prior].filter((pid): pid is number => typeof pid === 'number'));
  if (!pids.size) return false;
  return collectHostedNativeLogs({
    home,
    platform: 'android',
    since,
    final,
    deadline,
    tailOnly: true,
    identity: { appAttempt: attempt, pid: current ?? prior },
    query: (from, _end, timeoutMs) =>
      [...pids]
        .map((pid) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error('Hosted native log query exceeded its collection budget.');
          return exec.runFile(
            adb,
            [
              '-s',
              device.serial,
              'logcat',
              '-d',
              '-v',
              'epoch',
              '-T',
              ((from - clockOffsetMs) / 1000).toFixed(3),
              '--pid',
              String(pid),
            ],
            { timeoutMs: Math.min(remaining, timeoutMs), killSignal: 'SIGKILL' },
          );
        })
        .join('\n'),
    parse: (line) => {
      const record = parseLogcatLine(line, { clockOffsetMs });
      if (!record || !pids.has(Number(/\((\d+)\)$/.exec(String(record.proc))?.[1]))) return null;
      return { record, digest: createHash('sha256').update(line.trim()).digest('hex') };
    },
  });
}
