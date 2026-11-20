import type { MessagePort } from 'node:worker_threads';
import type { StimContext } from '@stim-cli/core';
import type { DaemonLadderAction } from '@stim-cli/core/state';
import { operationState } from '../engine/operation-state.ts';
import { reportChildOf } from '../engine/workspace-process-error.ts';
import { hungRead } from '../workspace/bounded-read.ts';
import { createCleanupWatch } from './cleanup-watch.ts';

type ToThread<Input, LadderInput> =
  | { type: 'run'; input: Input & { cwd: string } }
  | { type: 'abort' }
  | { type: 'settle' }
  | { type: 'ladder'; id: number; input: LadderInput & { cwd: string } };

/**
 * Serves one stimd thread's jobs on `port`, one at a time, each with its own operation from `context`, and beside them
 * each `ladder` request, a disk pass with its own operation, which `abort` stops too. A job or disk pass whose
 * cleanup refusal names one child and leaves no other child of its operation running is watched here: the failure
 * crosses with that child's identity, and each `settle` releases what a stopped child alone retained and answers with
 * the children still watched. Every answer also says whether a timed-out read of this thread is still pending
 * (`bounded-read.ts`). `forget` runs after such a failure of a job, for a job that keeps state between runs.
 */
export function serveThreadJobs<Input, LadderInput = never, LadderResult = never>(
  port: MessagePort,
  context: (cwd: string, signal: AbortSignal) => StimContext,
  run: (input: Input & { cwd: string }, operation: StimContext) => Promise<DaemonLadderAction[]>,
  forget: () => void = () => {},
  ladder?: (input: LadderInput & { cwd: string }, operation: StimContext) => Promise<LadderResult>,
): void {
  let controller = new AbortController();
  const ladders = new Set<AbortController>();
  // @ref LLP 0007#stimd-stays-up-for-a-child-it-can-watch -- a job's cleanup check stays on its thread
  const watch = createCleanupWatch(() => {});
  const failure = (error: unknown, operation: StimContext, signal: AbortSignal) => {
    const cleanup = error instanceof Error && 'reportCleanup' in error;
    const child = reportChildOf(error);
    const others = [...operationState(operation).running].some((running) => running.pid !== child?.pid);
    const contained = child && !others && watch.contain(error, signal.aborted) ? child : null;
    return {
      contained: contained !== null,
      fields: {
        message: signal.aborted && !cleanup ? 'aborted' : error instanceof Error ? error.message : String(error),
        ...(cleanup
          ? {
              reportCleanup: true,
              ...(error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? { code: error.code }
                : {}),
              ...(error instanceof Error && 'remedy' in error && typeof error.remedy === 'string'
                ? { remedy: error.remedy }
                : {}),
              ...(contained ? { contained } : {}),
            }
          : {}),
      },
    };
  };
  port.on('message', async (message: ToThread<Input, LadderInput>) => {
    if (message.type === 'abort') {
      for (const asked of ladders) asked.abort();
      return controller.abort();
    }
    if (message.type === 'settle') {
      watch.settle();
      return port.postMessage({ type: 'settled', pending: watch.keys(), reading: hungRead() !== null });
    }
    if (message.type === 'ladder') {
      if (!ladder) return;
      const asked = new AbortController();
      ladders.add(asked);
      const operation = context(message.input.cwd, asked.signal);
      try {
        const result = await ladder(message.input, operation);
        port.postMessage({ type: 'ladderDone', id: message.id, result, reading: hungRead() !== null });
      } catch (error) {
        const failed = failure(error, operation, asked.signal);
        port.postMessage({ type: 'ladderDone', id: message.id, failure: failed.fields, reading: hungRead() !== null });
      } finally {
        ladders.delete(asked);
      }
      return;
    }
    controller = new AbortController();
    const { signal } = controller;
    const operation = context(message.input.cwd, signal);
    try {
      const result = await run(message.input, operation);
      port.postMessage({ type: 'done', result, reading: hungRead() !== null });
    } catch (error) {
      const failed = failure(error, operation, signal);
      if (failed.contained) forget();
      port.postMessage({ type: 'failed', reading: hungRead() !== null, ...failed.fields });
    }
  });
}
