import { isPidAlive } from '../metro.ts';
import { inspectProcessIdentity, sameProcessRecord, type ProcessRecord } from '../process-identity.ts';
import { readCollectors } from './state.ts';

export function collectorProcessTitle(platform: string, root: string): string {
  return `stim-collector-${platform} --root ${root}`;
}

export type CollectorOwnership = { status: 'ours' } | { status: 'gone' } | { status: 'unverified'; reason: string };

export function verifyCollectorOwnership({
  pid,
  platform,
  root,
  isAlive = isPidAlive,
  expected,
}: {
  pid: number;
  platform: string;
  root: string;
  isAlive?: (pid: number) => boolean;
  expected?: ProcessRecord | null;
}): CollectorOwnership {
  const record = readCollectors(root)[platform] as { pid?: unknown; processToken?: unknown } | undefined;
  if (expected !== undefined && !sameProcessRecord(record, expected)) {
    return { status: 'unverified', reason: `the ${platform} collector registration changed during cleanup` };
  }
  if (record?.pid === pid) {
    const identity = inspectProcessIdentity(record);
    if (identity === 'same') return { status: 'ours' };
    if (identity === 'gone' || identity === 'different') return { status: 'gone' };
  }
  return isAlive(pid)
    ? {
        status: 'unverified',
        reason: `pid ${pid} has no verifiable identity recorded for this workspace's ${platform} collector`,
      }
    : { status: 'gone' };
}
