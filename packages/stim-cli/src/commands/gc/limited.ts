import type { StimContext } from '@stim-cli/core';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { operationState } from '../../engine/operation-state.ts';

const isCleanupFailure = (error: unknown) =>
  error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error);

export async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items[Symbol.iterator]();
  let failed = false;
  const worker = async (): Promise<void> => {
    for (const item of queue) {
      if (failed) return;
      try {
        await run(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const errors = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length) throw errors.find(isCleanupFailure) ?? errors[0];
}

export function readConcurrency(operation?: StimContext): number {
  return operationState(operation).declaring.size ? 1 : 6;
}

export function sizeConcurrency(operation?: StimContext): number {
  return operationState(operation).declaring.size ? 1 : 4;
}

export async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const done: [number, R][] = [];
  await eachLimited([...items.entries()], limit, async ([index, item]) => {
    done.push([index, await run(item)]);
  });
  return done.toSorted(([a], [b]) => a - b).map(([, result]) => result);
}
