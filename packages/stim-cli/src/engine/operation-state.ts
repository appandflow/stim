import type { ChildProcess } from 'node:child_process';
import type { StimContext } from '@stim-cli/core';
import type { ClaimHandle } from '../ownership-claim.ts';

/** What one operation tracks while it runs; kept per context so two operations in one process stay apart. */
export interface OperationState {
  cancelled: string | null;
  runSignal: AbortSignal | undefined;
  declaring: Set<ClaimHandle>;
  running: Set<ChildProcess>;
  refusal: string | null;
  /** An abort listener acted on the cancellation, so an exit code describes it. */
  handled: boolean;
  /** An abort listener is draining owned work; the operation ends after that work has settled. */
  draining: boolean;
  /** Synchronous cleanups to run when the process must exit before the operation unwinds. */
  exitCleanups: Set<() => void>;
  /** The `--remote-build` value this operation placed its build with. */
  buildMachineFlag: string | undefined;
  /** Whether the process running this operation turns SIGINT into its cancellation, so `stop` may signal it. */
  takesSignals: boolean;
  /** Aborts the operation's own context; set by whoever created the context. */
  abortOperation: ((reason: unknown) => void) | undefined;
}

const states = new WeakMap<StimContext, OperationState>();
let detached: OperationState | undefined;

function fresh(): OperationState {
  return {
    cancelled: null,
    runSignal: undefined,
    declaring: new Set(),
    running: new Set(),
    refusal: null,
    handled: false,
    draining: false,
    exitCleanups: new Set(),
    buildMachineFlag: undefined,
    takesSignals: false,
    abortOperation: undefined,
  };
}

/** The state of `context`'s operation; code that is not passed a context yet shares one state per process. */
export function operationState(context: StimContext | undefined): OperationState {
  if (!context) return (detached ??= fresh());
  let state = states.get(context);
  if (!state) {
    state = fresh();
    states.set(context, state);
  }
  return state;
}

/** Whether an abort reason asks the operation to terminate rather than interrupt it. */
export function isTermination(reason: unknown): boolean {
  return reason === 'SIGTERM';
}

/** Keeps asynchronous work unwinding on the CLI's first interrupt until its owned work has settled. */
export async function withDrainingCancellation<T>(
  context: StimContext | undefined,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (!context) return work();
  const abort = () => {
    const state = operationState(context);
    state.handled = true;
    if (!isTermination(context.signal.reason)) state.draining = true;
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await work();
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
