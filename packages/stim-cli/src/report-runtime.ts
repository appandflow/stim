import { type StimContext } from '@stim-cli/core';

interface ReportState {
  pending: Map<Promise<void>, Error | undefined>;
  failure?: unknown;
  abort: (reason: unknown) => void;
}

const reports = new WeakMap<StimContext, ReportState>();

export function reportSignal(context: StimContext | undefined): AbortSignal | undefined {
  return context && reports.has(context) ? context.signal : undefined;
}

export function trackReportResource(
  context: StimContext | undefined,
  closed: Promise<void>,
  cancel: () => void | Promise<void>,
  signal: AbortSignal | undefined = context?.signal,
  cleanupFailure?: Error,
): void {
  const state = context && reports.get(context);
  if (!context || !state || !signal) return;
  const { pending } = state;
  const abort = () => {
    const cancelled = Promise.resolve().then(cancel);
    pending.set(cancelled, cleanupFailure);
    void cancelled.then(
      () => pending.delete(cancelled),
      (error) => {
        state.failure ??= error;
        pending.delete(cancelled);
        pending.delete(closed);
        signal.removeEventListener('abort', abort);
        state.abort(error);
      },
    );
  };
  pending.set(closed, cleanupFailure);
  const settled = () => {
    signal.removeEventListener('abort', abort);
    pending.delete(closed);
  };
  void closed.then(settled, (error) => {
    state.failure ??= error;
    settled();
    state.abort(error);
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
}

export async function runReport<T>(
  context: StimContext,
  work: (context: StimContext) => Promise<T>,
  timeoutMs = 60_000,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const operation = {
    ...context,
    signal,
    output: ((stream, text) => {
      if (!signal.aborted) context.output(stream, text);
    }) satisfies StimContext['output'],
  };
  const pending = new Map<Promise<void>, Error | undefined>();
  const state: ReportState = { pending, abort: (reason) => controller.abort(reason) };
  reports.set(operation, state);
  const deadline = performance.now() + timeoutMs;
  const expire = () => {
    controller.abort(
      Object.assign(new Error(`The report exceeded its ${timeoutMs / 1000} second budget.`), {
        code: 'STIM_REPORT_TIMEOUT',
      }),
    );
  };
  const timer = setTimeout(expire, timeoutMs);
  let rejectCancellation: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const abort = () => rejectCancellation(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const outcome: { result: T } | { error: unknown } = await (async () => {
    try {
      signal.throwIfAborted();
      const result = await Promise.race([work(operation), cancelled]);
      if (performance.now() >= deadline) expire();
      signal.throwIfAborted();
      return { result };
    } catch (error) {
      return { error };
    }
  })().finally(async () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
    const cleanupDeadline = performance.now() + 35_000;
    const expireCleanup = () => {
      state.failure ??=
        [...pending.values()].find((failure) => failure !== undefined) ??
        Object.assign(new Error('Report cleanup did not finish within 35 seconds.'), {
          code: 'STIM_CLAIM_UNAVAILABLE',
          reportCleanup: true,
        });
    };
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (pending.size) await Promise.allSettled(pending.keys());
        })(),
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(() => {
            expireCleanup();
            resolve();
          }, 35_000);
        }),
      ]);
      if (performance.now() >= cleanupDeadline) expireCleanup();
    } finally {
      clearTimeout(cleanupTimer);
    }
  });
  if ('failure' in state) throw state.failure;
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}
