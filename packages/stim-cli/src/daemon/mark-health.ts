import type { GcMark, GcMarkHealth, GcStaleMarkEvidence, Config } from '@stim-cli/core/state';
import type { StimContext } from '@stim-cli/core';
import { markInterval, outputMarkBatch } from './marks.ts';
import { dormantAfterMs } from './stages.ts';

export function markHealth(marks: readonly GcMark[], now: number, dormantMs: number, complete: boolean): GcMarkHealth {
  const stale: GcStaleMarkEvidence[] = [];
  let staleCount = 0;
  for (const mark of marks) {
    const at = Date.parse(mark.markedAt);
    if (!Number.isFinite(at)) {
      complete = false;
      continue;
    }
    const intervalMs = markInterval(mark, now, dormantMs);
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
): Promise<{ roots: { root: string; device: number }[] | null; marks: GcMarkHealth }> {
  const batch = await outputMarkBatch(config, operation);
  return {
    roots: batch.listed ? batch.marks.map(({ root, device }) => ({ root, device })) : null,
    marks: markHealth(batch.marks, Date.now(), dormantAfterMs(config, operation.env), batch.complete),
  };
}
