import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { gcMarkFile, readGcMark, type GcMark, type GcWorktreeObservation } from '@stim-cli/core/state';
import { stat } from 'node:fs/promises';
import { realpathAsync } from '../commands/gc/paths.ts';
import { writeCacheFile } from '../cache-file.ts';
import { answered, Unanswered } from '../workspace/bounded-read.ts';
import type { Config } from '../workspace/config.ts';
import { markDue, markWriter } from './marks.ts';
import { PRESSURE_IDLE_MS } from './idle.ts';
import { dormantAfterMs, readCheckout, type DeviceReading } from './stages.ts';

export function worktreeMarkDue(
  mark: GcMark | null,
  now: number,
  dormantMs: number,
  observation: GcWorktreeObservation | undefined = mark?.worktree,
): boolean {
  if (!mark?.worktree) return true;
  const activity = [mark.lastActivityAt, observation?.activity?.at, observation?.finished?.at]
    .filter((at): at is string => typeof at === 'string')
    .map((at) => Date.parse(at))
    .filter(Number.isFinite);
  const lastActivityAt = activity.length ? new Date(Math.max(...activity)).toISOString() : null;
  return markDue({ ...mark, markedAt: mark.worktree.markedAt, lastActivityAt }, now, dormantMs);
}

/** Publishes the scheduled worktree inventory without advancing unrelated observations. */
export function worktreeMarkObserver(
  config: Config | null,
  reading: DeviceReading,
): (path: string, observation: GcWorktreeObservation) => Promise<void> {
  return async (path, observation) => {
    if (!config) return;
    const deadline = new AbortController();
    const expiresAt = Date.now() + 3_000;
    const timer = setTimeout(() => deadline.abort(new Unanswered('worktree observation deadline')), 3_000);
    const signal = reading.operation ? AbortSignal.any([reading.operation.signal, deadline.signal]) : deadline.signal;
    const scoped = reading.operation ? { ...reading, operation: { ...reading.operation, signal } } : reading;
    let root = path;
    try {
      root = await answered(path, () => realpathAsync(path), 3_000, signal);
      const previous = readGcMark(root);
      const observedAt = Date.parse(observation.markedAt);
      if (!worktreeMarkDue(previous, observedAt, dormantAfterMs(config, reading.operation?.env), observation)) return;
      const device = (await answered(root, () => stat(root), 3_000, signal)).dev;
      if (!previous || previous.device !== device)
        await markWriter(
          config,
          signal,
        )(await readCheckout(root, config.projects[root] ?? {}, scoped, PRESSURE_IDLE_MS));
      const current = readGcMark(root);
      if (!current || current.device !== device) return;
      signal.throwIfAborted();
      if (Date.now() >= expiresAt) throw new Unanswered('worktree observation deadline');
      writeCacheFile(gcMarkFile(root), { ...current, worktree: observation });
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      reading.operation?.signal.throwIfAborted();
      const current = readGcMark(root);
      if (current?.worktree) {
        delete current.worktree;
        writeCacheFile(gcMarkFile(root), current);
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
