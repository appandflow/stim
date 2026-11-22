import type { GcMark, GcMarkHealth, GcStaleMarkEvidence, Config, DaemonMode } from '@stim-cli/core/state';
import type { StimContext } from '@stim-cli/core';
import { markInterval, outputMarkBatch, type CargoMarkScope, type HolderMarkScope } from './marks.ts';
import { dormantAfterMs } from './stages.ts';

export function markHealth(
  marks: readonly GcMark[],
  now: number,
  dormantMs: number,
  complete: boolean,
  mode: DaemonMode = 'on',
): GcMarkHealth {
  const stale: GcStaleMarkEvidence[] = [];
  let staleCount = 0;
  for (const mark of marks) {
    const at = Date.parse(mark.markedAt);
    if (!Number.isFinite(at)) {
      complete = false;
      continue;
    }
    const intervalMs = Math.max(mode === 'on' ? 0 : 3_600_000, markInterval(mark, now, dormantMs));
    if (now <= at + 2 * intervalMs) continue;
    staleCount++;
    if (stale.length < 5) stale.push({ root: mark.root, markedAt: mark.markedAt, intervalMs });
  }
  return {
    at: now,
    state: complete ? 'ready' : marks.length ? 'partial' : 'unavailable',
    ...(complete ? { checkedRoots: marks.length, staleCount } : {}),
    stale,
  };
}

export async function readMarkHealth(
  config: Config,
  operation: StimContext,
  mode: DaemonMode = 'on',
): Promise<{ roots: { root: string; device: number }[] | null; marks: GcMarkHealth; holders: HolderMarkScope[] }> {
  const holders = new Map<string, CargoMarkScope>();
  const batch = await outputMarkBatch(config, operation, holders);
  return {
    roots: batch.listed ? batch.marks.map(({ root, device }) => ({ root, device })) : null,
    marks: markHealth(batch.marks, Date.now(), dormantAfterMs(config, operation.env), batch.complete, mode),
    holders: batch.marks.flatMap(({ root, device, markedAt }) => {
      const scope = holders.get(root);
      return scope ? [{ root, device, markedAt, ...scope }] : [];
    }),
  };
}
