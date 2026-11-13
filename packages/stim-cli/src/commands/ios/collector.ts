import { deviceSlotKey } from '../../devices/device-slots.ts';
import chalk from 'chalk';
import { PLATFORM } from './support.ts';
import { verifyCollectorOwnership } from '../../stimd/logs/ownership.ts';
import { readWorkspaceState } from '../../workspace/workspace-state.ts';
import { pidExists, signalProcessTree } from '../../metro.ts';
import { cancellableSleep } from '../../cancellation.ts';
import type { StimContext } from '@stim-cli/core';
import { startDeviceLogStream, stopDeviceLogStream } from '../../daemon/client.ts';
import { appNameFromBundleId } from '../../stimd/logs/ios.ts';
import { removeCollectorIfSame } from '../../stimd/logs/state.ts';

export const COLLECTOR_EXIT_WAIT_MS = 2000;

const COLLECTOR_POLL_MS = 25;

interface ReplaceCollectorArgs {
  root: string;
  slot?: string;
  udid: string;
  bundleId: string;
  appName?: string | null;
  appExecutable?: string | null;
  physical?: boolean;
  payloadUrl?: string | null;
  operation?: StimContext;
  startStream?: typeof startDeviceLogStream;
  stopStream?: typeof stopDeviceLogStream;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  readState?: typeof readWorkspaceState;
  verify?: typeof verifyCollectorOwnership;
  waitMs?: number;
  note?: (line: string) => void;
}

// On hardware the collector holds the devicectl console of a running app, and
// an upgrade install terminates that app -- which ends devicectl non-zero and
// records a failure for a normal action. So a device run stops the previous
// collector before it installs, rather than as part of starting its own.
export async function stopPreviousCollector({
  root,
  slot = 'default',
  kill = (pid, signal) => signalProcessTree(pid, signal),
  alive = pidExists,
  readState = readWorkspaceState,
  verify = verifyCollectorOwnership,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  note = (_line: string) => {},
  operation,
  stopStream = stopDeviceLogStream,
}: {
  root: string;
  slot?: string;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  readState?: typeof readWorkspaceState;
  verify?: typeof verifyCollectorOwnership;
  waitMs?: number;
  note?: (line: string) => void;
  operation?: StimContext;
  stopStream?: typeof stopDeviceLogStream;
}): Promise<{ killed: number | null; error?: string }> {
  const previous =
    (readState(root)?.collectors as Record<string, { pid?: number; kind?: string; streamId?: string }> | undefined)?.[
      deviceSlotKey(PLATFORM, slot)
    ] || null;
  if (previous?.kind === 'stream') {
    if (!previous.streamId) {
      const error = 'the previous log stream has no identity';
      note(chalk.yellow(error));
      return { killed: null, error };
    }
    const result = await stopStream(root, PLATFORM, slot, previous.streamId, operation);
    if ('error' in result) {
      const error = result.remedy ? `${result.error} ${result.remedy}` : result.error;
      note(chalk.yellow(error));
      return { killed: null, error };
    }
    return { killed: null };
  }
  const previousPid = Number(previous?.pid) || null;
  let killed: number | null = null;

  if (previousPid) {
    const ownership = verify({
      pid: previousPid,
      platform: deviceSlotKey(PLATFORM, slot),
      root,
      isAlive: alive,
      expected: previous,
    });
    if (ownership.status === 'unverified') {
      const error = `The previous iOS log collector (pid ${previousPid}) cannot be verified: ${ownership.reason}. Verify whether pid ${previousPid} is still running. Once it has stopped, run \`stim stop\` and retry.`;
      note(chalk.yellow(error));
      return { killed: null, error };
    }
    if (ownership.status === 'ours') {
      try {
        kill(previousPid, 'SIGTERM');
        killed = previousPid;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH')
          return { killed: null, error: `Could not stop the previous iOS log collector: ${String(err)}` };
      }
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && alive(previousPid)) await cancellableSleep(COLLECTOR_POLL_MS);
      if (alive(previousPid))
        return { killed, error: 'The previous iOS log collector did not stop; run `stim stop` and retry.' };
    }
    if (!removeCollectorIfSame(root, deviceSlotKey(PLATFORM, slot), previous))
      return { killed, error: 'The previous iOS log collector changed during cleanup; retry the command.' };
  }

  return { killed };
}

export async function replaceCollector({
  root,
  slot = 'default',
  udid,
  bundleId,
  appName,
  appExecutable,
  physical = false,
  payloadUrl = null,
  operation,
  startStream = startDeviceLogStream,
  stopStream = stopDeviceLogStream,
  kill = (pid, signal) => process.kill(pid, signal),
  alive = pidExists,
  readState = readWorkspaceState,
  verify = verifyCollectorOwnership,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  note = (_line: string) => {},
}: ReplaceCollectorArgs): Promise<{ killed: number | null; streamId: string | null; error?: string }> {
  const existing = readState(root)?.collectors?.[deviceSlotKey(PLATFORM, slot)];
  const previous =
    !physical && existing && typeof existing === 'object' && 'kind' in existing && existing.kind === 'stream'
      ? { killed: null }
      : await stopPreviousCollector({
          root,
          slot,
          kill,
          alive,
          readState,
          verify,
          waitMs,
          note,
          operation,
          stopStream,
        });
  const { killed } = previous;
  if (previous.error) return { killed, streamId: null, error: previous.error };

  const result = await startStream(
    {
      root,
      platform: PLATFORM,
      slot,
      udid,
      bundleId,
      appName: appName ?? appNameFromBundleId(bundleId),
      ...(appExecutable ? { appExecutable } : {}),
      ...(physical ? { physical: true } : {}),
      ...(payloadUrl ? { payloadUrl } : {}),
    },
    operation,
  );
  if ('error' in result) {
    note(chalk.yellow(`Could not start the ${PLATFORM} log stream: ${result.error}`));
    return { killed, streamId: null, error: result.error };
  }
  return { killed, streamId: result.streamId };
}
