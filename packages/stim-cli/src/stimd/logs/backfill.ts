import type { ChildProcess } from 'node:child_process';
import { getExecutor } from '../../exec.ts';
import { captureProcessToken } from '../../process-identity.ts';
import {
  claimRemoveCommand,
  clearClaimChild,
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  type ClaimHandle,
} from '../../ownership-claim.ts';
import { adbCommand, androidClockOffset, logcatBackfillArgs, waitForAppPid } from './android.ts';
import { androidToolCwd } from '../../devices/android.ts';
import { logShowArgs } from './ios.ts';
import { takeHistoryClaim } from './claim.ts';
import type { LogSink } from './writer.ts';
import type { StreamSpec } from './streams.ts';

function finishHistoryClaim(
  claim: ClaimHandle,
  spawned: { child: ChildProcess | null; pid: number | undefined },
): void {
  const child = spawned.child;
  const running =
    spawned.pid !== undefined &&
    (process.platform === 'win32'
      ? child !== null && child.exitCode === null && child.signalCode === null
      : processGroupAlive(spawned.pid));
  if (running)
    throw new Error(
      `The device log backfill child at ${claim.root} cannot be verified stopped; inspect it before running ${claimRemoveCommand(claim.root)}.`,
    );
  clearClaimChild(claim);
  if (!releaseClaim(claim)) throw new Error('the device log backfill claim changed during cleanup');
}

export async function backfillDeviceLog({
  root,
  streamId,
  spec,
  since,
  env,
  signal,
  warm,
  onBegin = () => {},
  sink,
}: {
  root: string;
  streamId: string;
  spec: StreamSpec;
  since: number;
  env: Record<string, string>;
  signal: AbortSignal;
  warm: (pid: number | null) => boolean;
  onBegin?: () => void;
  sink: LogSink;
}): Promise<void> {
  if (spec.physical) return;
  signal.throwIfAborted();
  let pid: number | null = null;
  let offset: number | null = null;
  let command: string;
  let args: string[];
  if (spec.platform === 'android') {
    if (!spec.serial || !spec.packageName) throw new Error('the Android backfill has no device or app');
    const resolved = await waitForAppPid({
      serial: spec.serial,
      packageName: spec.packageName,
      timeoutMs: 1000,
      signal,
      env,
      cwd: root,
    });
    signal.throwIfAborted();
    if (!resolved.ok || !resolved.pid) throw new Error(resolved.reason ?? 'the Android app PID is unavailable');
    pid = resolved.pid;
    await sink.sync();
    onBegin();
    if (warm(pid)) return;
    offset = await androidClockOffset(spec.serial, { signal, env, cwd: root });
    signal.throwIfAborted();
    if (offset === null) throw new Error('the Android device clock could not be read');
    command = adbCommand(env, root);
    // https://android.googlesource.com/platform/system/logging/+/refs/heads/main/logcat/logcat.cpp: -T keeps streaming without -d.
    args = logcatBackfillArgs(spec.serial, pid, since, offset);
  } else {
    await sink.sync();
    onBegin();
    if (warm(null)) return;
    if (!spec.udid || !spec.appName) throw new Error('the iOS backfill has no device or app');
    command = 'xcrun';
    // macOS log show accepts @unixtime; the worker filters the fractional start second.
    args = logShowArgs(spec.udid, spec.appName, spec.appExecutable, since);
  }
  await sink.beginBackfill(since);
  try {
    onBegin();
    const claim = await takeHistoryClaim(root, streamId);
    const spawned: { child: ChildProcess | null; pid: number | undefined } = { child: null, pid: undefined };
    try {
      signal.throwIfAborted();
      await sink.sync();
      onBegin();
      markClaimChildPending(claim);
      const output = await getExecutor().runFileAsync(command, args, {
        cwd: spec.platform === 'android' ? (androidToolCwd() ?? root) : root,
        env,
        signal,
        timeoutMs: 15_000,
        untrimmed: true,
        onSpawn(childProcess) {
          spawned.child = childProcess;
          spawned.pid = childProcess.pid;
          const processToken = spawned.pid ? captureProcessToken(spawned.pid) : null;
          if (!spawned.pid) throw new Error('could not capture the device log backfill child identity');
          if (processToken) setClaimChild(claim, { pid: spawned.pid, processToken });
        },
      });
      signal.throwIfAborted();
      const lines = output.split('\n');
      for (let index = 0; index < lines.length; index++) {
        signal.throwIfAborted();
        const line = lines[index];
        if (line) sink.backfillLine(line, offset);
        if (index > 0 && index % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      finishHistoryClaim(claim, spawned);
    }
  } finally {
    await sink.endBackfill();
  }
}
