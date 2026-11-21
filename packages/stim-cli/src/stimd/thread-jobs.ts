import type { MessagePort } from 'node:worker_threads';
import type { StimContext } from '@stim-cli/core';
import type { DaemonLadderAction } from '@stim-cli/core/state';
import { operationState } from '../engine/operation-state.ts';
import { reportChildOf } from '../engine/workspace-process-error.ts';
import { hungRead } from '../workspace/bounded-read.ts';
import { createCleanupWatch } from './cleanup-watch.ts';

type ToThread<Input, LadderInput, GcInput> =
  | { type: 'run'; input: Input & { cwd: string } }
  | { type: 'abort' }
  | { type: 'settle' }
  | { type: 'ladder'; id: number; input: LadderInput & { cwd: string } }
  | { type: 'gc'; id: number; input: GcInput & { cwd: string } }
  | { type: 'gcLeave'; id: number };

/**
 * One gc request on the thread: `open` makes the operation of a pass the request starts, `emit` sends each action of
 * the pass it runs or joins, `output` streams item output, and `leave` withdraws the request.
 */
type GcRequest<GcInput, GcResult> = (
  input: GcInput & { cwd: string },
  open: (signal: AbortSignal) => StimContext,
  emit: (action: unknown) => void,
  output: StimContext['output'],
) => { result: Promise<GcResult>; leave(): void };

/**
 * Serves one stimd thread's jobs on `port`, one at a time, each with its own operation from `context`, and beside them
 * each `ladder` request, a disk pass with its own operation, which `abort` stops too. A job or disk pass whose
 * cleanup refusal names one child and leaves no other child of its operation running is watched here: the failure
 * crosses with that child's identity, and each `settle` releases what a stopped child alone retained and answers with
 * the children still watched. Every answer also says whether a timed-out read of this thread is still pending
 * (`bounded-read.ts`). `forget` runs after such a failure of a job, for a job that keeps state between runs. Each `gc`
 * request goes to `gc`, answered like a disk pass, with its actions as `gcAction` messages on the way.
 */
export function serveThreadJobs<Input, LadderInput = never, LadderResult = never, GcInput = never, GcResult = never>(
  port: MessagePort,
  context: (cwd: string, signal: AbortSignal) => StimContext,
  run: (input: Input & { cwd: string }, operation: StimContext) => Promise<DaemonLadderAction[]>,
  forget: () => void = () => {},
  ladder?: (input: LadderInput & { cwd: string }, operation: StimContext) => Promise<LadderResult>,
  gc?: GcRequest<GcInput, GcResult>,
): void {
  let controller = new AbortController();
  const ladders = new Set<AbortController>();
  let gcStop = new AbortController();
  const gcLeaves = new Map<number, () => void>();
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
  port.on('message', async (message: ToThread<Input, LadderInput, GcInput>) => {
    if (message.type === 'abort') {
      for (const asked of ladders) asked.abort();
      gcStop.abort();
      gcStop = new AbortController();
      return controller.abort();
    }
    if (message.type === 'gcLeave') return gcLeaves.get(message.id)?.();
    if (message.type === 'gc') {
      if (!gc) return;
      const { id, input } = message;
      const stopped = gcStop.signal;
      let operation: StimContext | undefined;
      const asked = gc(
        input,
        (signal) => (operation = { ...context(input.cwd, AbortSignal.any([signal, stopped])), cwd: input.cwd }),
        (action) => port.postMessage({ type: 'gcAction', id, action }),
        (stream, text) => port.postMessage({ type: 'gcOutput', id, stream, text }),
      );
      gcLeaves.set(id, asked.leave);
      try {
        const result = await asked.result;
        port.postMessage({ type: 'ladderDone', id, result, reading: hungRead() !== null });
      } catch (error) {
        const fields = operation
          ? failure(error, operation, operation.signal).fields
          : { message: error instanceof Error ? error.message : String(error) };
        port.postMessage({ type: 'ladderDone', id, failure: fields, reading: hungRead() !== null });
      } finally {
        gcLeaves.delete(id);
      }
      return;
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
