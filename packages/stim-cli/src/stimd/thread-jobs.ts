import type { MessagePort } from 'node:worker_threads';
import type { StimContext } from '@stim-cli/core';
import type { DaemonLadderAction } from '@stim-cli/core/state';
import { operationState } from '../engine/operation-state.ts';
import { reportChildOf } from '../engine/workspace-process-error.ts';
import { createCleanupWatch } from './cleanup-watch.ts';

type ToThread<Input> = { type: 'run'; input: Input & { cwd: string } } | { type: 'abort' } | { type: 'settle' };

/**
 * Serves one stimd thread's jobs on `port`, one at a time, each with its own operation from `context`. A job whose
 * cleanup refusal names one child and leaves no other child of its operation running is watched here: the failure
 * crosses with that child's identity, and each `settle` releases what a stopped child alone retained and answers with
 * the children still watched. `forget` runs after such a failure, for a job that keeps state between runs.
 */
export function serveThreadJobs<Input>(
  port: MessagePort,
  context: (cwd: string, signal: AbortSignal) => StimContext,
  run: (input: Input & { cwd: string }, operation: StimContext) => Promise<DaemonLadderAction[]>,
  forget: () => void = () => {},
): void {
  let controller = new AbortController();
  // @ref LLP 0007#stimd-stays-up-for-a-child-it-can-watch -- a job's cleanup check stays on its thread
  const watch = createCleanupWatch(() => {});
  port.on('message', async (message: ToThread<Input>) => {
    if (message.type === 'abort') return controller.abort();
    if (message.type === 'settle') {
      watch.settle();
      return port.postMessage({ type: 'settled', pending: watch.keys() });
    }
    controller = new AbortController();
    const { signal } = controller;
    const operation = context(message.input.cwd, signal);
    try {
      port.postMessage({ type: 'done', result: await run(message.input, operation) });
    } catch (error) {
      const cleanup = error instanceof Error && 'reportCleanup' in error;
      const child = reportChildOf(error);
      const others = [...operationState(operation).running].some((running) => running.pid !== child?.pid);
      const contained = child && !others && watch.contain(error, signal.aborted) ? child : null;
      if (contained) forget();
      port.postMessage({
        type: 'failed',
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
      });
    }
  });
}
