import { deviceSlotKey } from '../../devices/device-slots.ts';
import chalk from 'chalk';
import { PLATFORM } from './support.ts';
import { verifyCollectorOwnership } from '../../stimd/logs/ownership.ts';
import { pidExists, signalProcessTree } from '../../metro.ts';
import { readCollectors, removeCollectorIfSame } from '../../stimd/logs/state.ts';
import { phaseLine } from '../../command-output.ts';
import type { StimContext } from '@stim-cli/core';
import { startDeviceLogStream, stopDeviceLogStream } from '../../daemon/client.ts';

const COLLECTOR_EXIT_WAIT_MS = 2000;

const COLLECTOR_POLL_MS = 25;

export function killPreviousCollector(
  root: string,
  {
    platform = PLATFORM,
    slot = 'default',
    kill = (pid: number, signal: NodeJS.Signals) => signalProcessTree(pid, signal),
    collectors = null,
    verify = verifyCollectorOwnership,
    isAlive = pidExists,
    note = (_line: string) => {},
  }: {
    platform?: string;
    slot?: string;
    kill?: (pid: number, signal: NodeJS.Signals) => boolean;
    collectors?: Record<string, { pid?: number }> | null;
    verify?: typeof verifyCollectorOwnership;
    isAlive?: (pid: number) => boolean;
    note?: (line: string) => void;
  } = {},
): number | null {
  const record = (collectors ?? readCollectors(root))?.[deviceSlotKey(platform, slot)] as { pid?: number } | undefined;
  const pid = Number(record?.pid);
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
  const ownership = verify({ pid, platform: deviceSlotKey(platform, slot), root, isAlive, expected: record });
  if (ownership.status === 'gone') return null;
  if (ownership.status === 'unverified') {
    note(
      chalk.dim(
        `Previous ${platform} log collector (pid ${pid}): ${ownership.reason}, so it was not signalled -- starting a replacement anyway`,
      ),
    );
    return null;
  }
  try {
    kill(pid, 'SIGTERM');
    return pid;
  } catch {
    return null;
  }
}

export async function stopPreviousDeviceLog(
  root: string,
  {
    slot = 'default',
    kill = (pid, signal) => signalProcessTree(pid, signal),
    alive = pidExists,
    verify = verifyCollectorOwnership,
    waitMs = COLLECTOR_EXIT_WAIT_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    note = (_line: string) => {},
    operation,
    stopStream = stopDeviceLogStream,
  }: {
    slot?: string;
    kill?: (pid: number, signal: NodeJS.Signals) => boolean;
    alive?: (pid: number) => boolean;
    verify?: typeof verifyCollectorOwnership;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    note?: (line: string) => void;
    operation?: StimContext;
    stopStream?: typeof stopDeviceLogStream;
  } = {},
): Promise<{ error?: string }> {
  const key = deviceSlotKey(PLATFORM, slot);
  const record = readCollectors(root)[key] as { pid?: number; kind?: string; streamId?: string } | undefined;
  if (!record) return {};
  if (record.kind === 'stream') {
    if (!record.streamId) return { error: 'the previous log stream has no identity' };
    const result = await stopStream(root, PLATFORM, slot, record.streamId, operation);
    return 'error' in result ? result : {};
  }
  const pid = Number(record.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return { error: 'the previous Android log collector has no valid identity' };
  const ownership = verify({ pid, platform: key, root, isAlive: alive, expected: record });
  if (ownership.status === 'unverified') {
    const error = `The previous Android log collector (pid ${pid}) cannot be verified: ${ownership.reason}. Verify whether pid ${pid} is still running. Once it has stopped, run \`stim stop\` and retry.`;
    note(chalk.yellow(error));
    return { error };
  }
  if (ownership.status === 'ours') {
    killPreviousCollector(root, { slot, kill, isAlive: alive, verify, collectors: { [key]: record }, note });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && alive(pid)) await sleep(COLLECTOR_POLL_MS);
    if (alive(pid)) return { error: 'The previous Android log collector did not stop; run `stim stop` and retry.' };
  }
  if (!removeCollectorIfSame(root, key, record))
    return { error: 'The previous Android log collector changed during cleanup; retry the command.' };
  return {};
}

export async function startCollector({
  root,
  slot = 'default',
  serial,
  packageName,
  kill,
  alive = pidExists,
  verify = verifyCollectorOwnership,
  waitMs = COLLECTOR_EXIT_WAIT_MS,
  sleep,
  out,
  operation,
  startStream = startDeviceLogStream,
  stopStream = stopDeviceLogStream,
}: {
  root: string;
  slot?: string;
  serial?: string;
  packageName: string;
  kill: (pid: number, signal: NodeJS.Signals) => boolean;
  alive?: (pid: number) => boolean;
  verify?: typeof verifyCollectorOwnership;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  out: (line: string) => void;
  operation?: StimContext;
  startStream?: typeof startDeviceLogStream;
  stopStream?: typeof stopDeviceLogStream;
}): Promise<string | null> {
  const existing = readCollectors(root)[deviceSlotKey(PLATFORM, slot)];
  const previous =
    existing && typeof existing === 'object' && 'kind' in existing && existing.kind === 'stream'
      ? {}
      : await stopPreviousDeviceLog(root, {
          slot,
          kill,
          alive,
          verify,
          waitMs,
          sleep,
          note: (line) => out(phaseLine('logs', line)),
          operation,
          stopStream,
        });
  if (previous.error) {
    out(phaseLine('logs', chalk.yellow(`could not stop the previous device log stream: ${previous.error}`)));
    return null;
  }
  if (!serial) {
    out(phaseLine('logs', chalk.yellow('could not start the device log stream: no serial')));
    return null;
  }
  const result = await startStream({ root, platform: PLATFORM, slot, serial, packageName }, operation);
  if ('error' in result) {
    out(phaseLine('logs', chalk.yellow(`could not start the device log stream: ${result.error}`)));
    return null;
  }
  return result.streamId;
}
