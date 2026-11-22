import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { gcMarkFile, readGcMark, type GcDependencyCandidate, type GcMark } from '@stim-cli/core/state';
import { stat } from 'node:fs/promises';
import { realpathAsync } from '../commands/gc/paths.ts';
import { writeCacheFile } from '../cache-file.ts';
import { trustedMeasure } from '../disk-usage.ts';
import { answered, Unanswered } from '../workspace/bounded-read.ts';
import type { Config } from '../workspace/config.ts';
import type { ArtifactInventory } from '../stimd/passes/artifacts.ts';
import { markDue, markWriter } from './marks.ts';
import { PRESSURE_IDLE_MS } from './idle.ts';
import { dormantAfterMs, readCheckout, type DeviceReading } from './stages.ts';

export function dependencyMarkDue(mark: GcMark | null, now: number, dormantMs: number): boolean {
  return markDue(mark?.dependencies ? { ...mark, markedAt: mark.dependencies.markedAt } : null, now, dormantMs);
}

function unknownDependencies(root: string): void {
  const current = readGcMark(root);
  if (!current?.dependencies) return;
  const next = { ...current };
  delete next.dependencies;
  writeCacheFile(gcMarkFile(root), next);
}

/** Publishes complete normal inventory without advancing an existing output generation. */
export function dependencyMarkObserver(
  config: Config,
  reading: DeviceReading,
  between: () => Promise<void>,
): (inventory: ArtifactInventory) => Promise<void> {
  return async (inventory) => {
    await between();
    const deadline = new AbortController();
    const expiresAt = Date.now() + 3_000;
    const timer = setTimeout(() => deadline.abort(new Unanswered('dependency observation deadline')), 3_000);
    const signal = reading.operation ? AbortSignal.any([reading.operation.signal, deadline.signal]) : deadline.signal;
    const scoped = reading.operation ? { ...reading, operation: { ...reading.operation, signal } } : reading;
    let root = inventory.worktree.path;
    try {
      root = await answered(root, () => realpathAsync(inventory.worktree.path), 3_000, signal);
      if (!inventory.complete) {
        unknownDependencies(root);
        return;
      }
      const previous = readGcMark(root);
      if (!dependencyMarkDue(previous, inventory.at, dormantAfterMs(config, reading.operation?.env))) return;
      const device = (await answered(root, () => stat(root), 3_000, signal)).dev;
      if (!previous || previous.device !== device) {
        const current = await readCheckout(root, config.projects[root] ?? {}, scoped, PRESSURE_IDLE_MS);
        await markWriter(config, signal)(current);
      }
      const markedAt = new Date(inventory.at).toISOString();
      const candidates: GcDependencyCandidate[] = [];
      for (const { candidate, keep } of inventory.candidates) {
        const measure = trustedMeasure(candidate.path);
        candidates.push({
          path: candidate.path,
          device: (await answered(candidate.path, () => stat(candidate.path), 3_000, signal)).dev,
          bytes: measure?.bytes ?? null,
          measuredAt: measure?.measuredAt ?? null,
          ...(keep ? { keep: { reason: keep, at: markedAt } } : {}),
        });
      }
      const current = readGcMark(root);
      if (!current || current.device !== device) return;
      const dirtyAt = [previous?.dirtyAt, current.dirtyAt]
        .filter((at): at is string => typeof at === 'string')
        .toSorted((a, b) => Date.parse(b) - Date.parse(a))[0];
      signal.throwIfAborted();
      if (Date.now() >= expiresAt) throw new Unanswered('dependency observation deadline');
      writeCacheFile(gcMarkFile(root), {
        ...current,
        ...(dirtyAt ? { dirtyAt } : {}),
        dependencies: {
          markedAt,
          role: inventory.worktree.linked ? 'linked' : 'source',
          keys: inventory.worktree.keys,
          candidates,
        },
      });
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      reading.operation?.signal.throwIfAborted();
      unknownDependencies(root);
    } finally {
      clearTimeout(timer);
    }
  };
}
