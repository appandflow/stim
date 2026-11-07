import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Executor } from '../../exec.ts';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { type NdjsonWriter, createNdjsonWriter } from '../../ndjson.ts';
import { workspaceLogsDir } from '../../workspace/paths.ts';
import { createLineReader } from '../../process-output.ts';
import { parseDeviceConsoleLine } from './ios-device.ts';
import { parseLogStreamLine } from './ios.ts';
import {
  type PidResolution,
  type PidWatcher,
  androidClockOffset,
  parseLogcatLine,
  waitForAppPid,
  watchAppPid,
} from './android.ts';

export interface RunCollectorOptions {
  slot?: string;
  platform: string;
  root: string;
  udid?: string | null;
  appName?: string | null;
  appExecutable?: string | null;
  bundleId?: string | null;
  serial?: string | null;
  packageName?: string | null;
  physical?: boolean;
  payloadUrl?: string | null;
  startStream: (opts: {
    platform: string;
    udid?: string | null;
    appName?: string | null;
    appExecutable?: string | null;
    bundleId?: string | null;
    serial?: string | null;
    physical?: boolean;
    payloadUrl?: string | null;
    pid?: number | null;
  }) => ChildProcess;
  resolvePid?:
    | ((opts: { serial?: string | null; packageName?: string | null; timeoutMs: number }) => Promise<PidResolution>)
    | null;
  pidTimeoutMs?: number;
  pidOf?:
    | ((
        serial: string,
        packageName: string,
        opts: { exec?: Executor | null },
      ) => number | null | Promise<number | null>)
    | null;
  pidWatchMs?: number | null;
  watchPid?: typeof watchAppPid;
  resolveClockOffset?: (
    serial: string,
    opts: { now?: () => number; signal?: AbortSignal; env?: Record<string, string> },
  ) => number | null | Promise<number | null>;
  now?: () => number;
  onExit: (code: number) => void;
  signal?: AbortSignal;
  env?: Record<string, string>;
  stopStream?: (child: ChildProcess | null) => Promise<void>;
  writer?: NdjsonWriter;
  recordLine?: (line: string, clockOffsetMs: number | null, child: ChildProcess) => void;
  beforeFinish?: (signalled: boolean) => void;
  stderr?: (line: string) => void;
}

export interface RunCollectorHandle {
  child: ChildProcess | null;
  writer: NdjsonWriter;
  finish: (code: number, level: string, msg: string, event: string) => void;
  startedAt: string;
  pid: number | null;
}

function startMessage({
  platform,
  physical,
  appName,
  bundleId,
  udid,
  packageName,
  serial,
  appPid,
}: {
  platform: string;
  physical?: boolean;
  appName?: string | null;
  bundleId?: string | null;
  udid?: string | null;
  packageName?: string | null;
  serial?: string | null;
  appPid?: number | null;
}): string {
  if (platform !== 'ios') {
    return `device log stream streaming ${packageName} (pid ${appPid}) on ${serial}`;
  }
  if (!physical) return `device log stream streaming ${appName} on ${udid}`;
  return `device log stream launching ${bundleId} on device ${udid} and streaming its console; subsystem, category and severity are not carried on hardware -- see \`stim guide logs\``;
}

export async function runCollector({
  slot = 'default',
  platform,
  root,
  udid = null,
  appName = null,
  appExecutable = null,
  bundleId = null,
  serial = null,
  packageName = null,
  physical = false,
  payloadUrl = null,
  startStream,
  resolvePid = null,
  pidTimeoutMs = 30000,
  pidOf = null,
  pidWatchMs = null,
  watchPid = watchAppPid,
  resolveClockOffset = androidClockOffset,
  now = Date.now,
  onExit,
  signal: operationSignal,
  env,
  stopStream,
  writer: suppliedWriter,
  recordLine,
  beforeFinish,
  stderr = (line: string) => console.error(line),
}: RunCollectorOptions): Promise<RunCollectorHandle | null> {
  const attribution = slot === 'default' ? {} : { slot, deviceId: udid ?? serial };
  const writer =
    suppliedWriter ?? createNdjsonWriter(join(workspaceLogsDir(root), 'device.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  const startedAt = new Date(now()).toISOString();
  let finished = false;
  const shutdown = new AbortController();
  let captured = 0;
  let watcher: PidWatcher | null = null;
  const finish = (code: number, level: string, msg: string, event: string, { signalled = false } = {}) => {
    if (finished) return;
    finished = true;
    shutdown.abort();
    watcher?.stop();
    if (beforeFinish) beforeFinish(signalled);
    else if (physical && captured === 0 && !signalled) {
      writer.write({
        ...attribution,
        src: 'device',
        platform,
        level: 'warn',
        event: 'collector_empty',
        msg: `the device console produced no output for ${bundleId}; devicectl only connects the app's streams when it starts the app, and os_log below the info level never reaches them`,
      });
    }
    writer.write({ ...attribution, src: 'device', platform, level, event, msg });
    operationSignal?.removeEventListener('abort', stop);
    const closed = writer.close();
    if (closed.dropped > 0) {
      stderr(`Stim collector: dropped ${closed.dropped} record(s); last error: ${describe(closed.lastError)}`);
    }
    onExit(code);
  };

  let child: ChildProcess | null = null;
  const stop = () => {
    killChild(child);
    finish(0, 'info', 'device log stream stopped', 'collector_stopped', { signalled: true });
  };
  if (operationSignal?.aborted) stop();
  else operationSignal?.addEventListener('abort', stop, { once: true });
  if (finished) return null;
  let pid: number | null = null;
  if (platform === 'android') {
    const resolved = resolvePid
      ? await resolvePid({ serial, packageName, timeoutMs: pidTimeoutMs })
      : await waitForAppPid({
          serial: serial as string,
          packageName: packageName as string,
          timeoutMs: pidTimeoutMs,
          signal: shutdown.signal,
          env,
        });
    if (!resolved.ok) {
      finish(1, 'error', `device log collector could not attach: ${resolved.reason}`, 'collector_failed');
      return null;
    }
    pid = resolved.pid ?? null;
  }

  writer.write({
    ...attribution,
    src: 'device',
    platform,
    level: 'info',
    event: 'collector_started',
    msg: startMessage({
      platform,
      physical,
      appName,
      bundleId,
      udid,
      packageName,
      serial,
      appPid: pid,
    }),
  });

  const parse = platform === 'ios' ? (physical ? parseDeviceConsoleLine : parseLogStreamLine) : parseLogcatLine;
  const readClockOffset = async (): Promise<number | null> =>
    platform === 'android' ? await resolveClockOffset(serial as string, { now, signal: shutdown.signal, env }) : null;
  const attach = (streamPid: number | null, clockOffsetMs: number | null): ChildProcess => {
    if (platform === 'android') {
      writer.write({
        ...attribution,
        src: 'device',
        platform,
        level: clockOffsetMs === null ? 'warn' : 'debug',
        event: 'collector_clock',
        clockOffsetMs,
        msg:
          clockOffsetMs === null
            ? 'Could not align Android device time; log timestamps retain device time and may miss launch filters.'
            : `Android log timestamps aligned to host time (offset ${clockOffsetMs}ms).`,
      });
    }
    const onLine = (line: string) => {
      if (recordLine) return recordLine(line, clockOffsetMs, spawned);
      const record = parse(line, { now, clockOffsetMs });
      if (!record) return;
      captured++;
      writer.write({ ...attribution, ...record, platform });
    };
    const spawned = startStream({
      platform,
      udid,
      appName,
      appExecutable,
      bundleId,
      serial,
      physical,
      payloadUrl,
      pid: streamPid,
    });
    const outReader = createLineReader(onLine);
    // devicectl --console connects the app's stderr to its own, and the os_log
    // mirror and every crash report arrive there rather than on stdout.
    const errReader = createLineReader(
      physical
        ? onLine
        : (line: string) => {
            const text = String(line).trimEnd();
            if (text.trim()) {
              writer.write({
                ...attribution,
                src: 'device',
                platform,
                level: 'debug',
                raw: true,
                event: 'collector_stderr',
                msg: text,
              });
            }
          },
    );
    spawned.once('close', () => {
      outReader.flush();
      errReader.flush();
    });
    spawned.stdout?.setEncoding?.('utf-8');
    spawned.stderr?.setEncoding?.('utf-8');
    spawned.stdout?.on('data', (chunk) => outReader.push(chunk));
    spawned.stderr?.on('data', (chunk) => errReader.push(chunk));

    spawned.on('close', (code, signal) => {
      if (spawned !== child) return;
      const settle = (next: number | null) => {
        if (spawned !== child) return;
        if (next && next !== pid) {
          void reattach(next, 'the log stream ended');
          return;
        }
        const how = signal ? `signal ${signal}` : `exit code ${code}`;
        if (physical && code) {
          finish(1, 'error', `the devicectl console ended with ${how}; treat the run as failed`, 'collector_failed');
          return;
        }
        finish(0, 'info', `device log stream ended (${how}); the app or device is gone`, 'collector_stopped');
      };
      if (platform === 'android' && watcher) void watcher.probe().then(settle);
      else settle(null);
    });
    spawned.on('error', (err) => {
      if (spawned !== child) return;
      finish(1, 'error', `device log stream failed: ${describe(err)}`, 'collector_failed');
    });
    return spawned;
  };

  const reattach = async (nextPid: number, why = 'the app restarted') => {
    if (finished || nextPid === pid) return;
    const previous = pid;
    try {
      if (stopStream) {
        const previousChild = child;
        child = null;
        await stopStream(previousChild);
      } else killChild(child);
    } catch (err) {
      finish(
        1,
        'error',
        `device log collector could not stop the previous stream: ${describe(err)}`,
        'collector_failed',
      );
      return;
    }
    if (finished) return;
    child = null;
    pid = nextPid;
    writer.write({
      ...attribution,
      src: 'device',
      platform,
      level: 'info',
      event: 'collector_reattached',
      msg: `${why}: ${packageName} is now pid ${nextPid} on ${serial} (was ${previous}); reattaching the log stream`,
    });
    const clockOffsetMs = await readClockOffset();
    if (finished || pid !== nextPid) return;
    try {
      child = attach(nextPid, clockOffsetMs);
    } catch (err) {
      finish(
        1,
        'error',
        `device log collector could not reattach to pid ${nextPid}: ${describe(err)}`,
        'collector_failed',
      );
    }
  };

  const initialClockOffsetMs = await readClockOffset();
  if (finished) return null;
  try {
    child = attach(pid, initialClockOffsetMs);
  } catch (err) {
    finish(1, 'error', `device log collector could not start: ${describe(err)}`, 'collector_failed');
    return null;
  }

  if (platform === 'android' && !finished) {
    watcher = watchPid({
      serial: serial as string,
      packageName: packageName as string,
      pid,
      intervalMs: pidWatchMs,
      signal: shutdown.signal,
      env,
      resolve: pidOf || undefined,
      onChange: (nextPid) => reattach(nextPid),
    });
  }

  return {
    get child() {
      return child;
    },
    writer,
    finish,
    startedAt,
    pid,
  };
}

// ChildProcess.kill signals through the handle, so it can only reach a process
// this collector spawned. process.kill(child.pid) would signal whatever holds
// that number, including a pid the OS recycled after the child exited.
function killChild(child: ChildProcess | null): void {
  try {
    child?.kill?.('SIGTERM');
  } catch {}
}

function describe(err: unknown): string {
  if (!err) return 'unknown error';
  return (err as Error).message || String(err);
}
