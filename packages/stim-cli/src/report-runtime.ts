import { type StimContext } from '@stim-cli/core';

const reports = new WeakMap<StimContext, { pending: Set<Promise<void>>; failure?: unknown }>();

export function reportSignal(context: StimContext | undefined): AbortSignal | undefined {
  return context && reports.has(context) ? context.signal : undefined;
}

export function trackReportResource(
  context: StimContext | undefined,
  closed: Promise<void>,
  cancel: () => void | Promise<void>,
  signal: AbortSignal | undefined = context?.signal,
): void {
  const state = context && reports.get(context);
  if (!context || !state || !signal) return;
  const { pending } = state;
  const abort = () => {
    const cancelled = Promise.resolve().then(cancel);
    pending.add(cancelled);
    void cancelled.then(
      () => pending.delete(cancelled),
      (error) => {
        state.failure ??= error;
        pending.delete(cancelled);
        pending.delete(closed);
        signal.removeEventListener('abort', abort);
      },
    );
  };
  pending.add(closed);
  const settled = () => {
    signal.removeEventListener('abort', abort);
    pending.delete(closed);
  };
  void closed.then(settled, (error) => {
    state.failure ??= error;
    settled();
  });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
}

export async function runReport<T>(context: StimContext, work: (context: StimContext) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const operation = {
    ...context,
    signal,
    output: ((stream, text) => {
      if (!signal.aborted) context.output(stream, text);
    }) satisfies StimContext['output'],
  };
  const pending = new Set<Promise<void>>();
  const state: { pending: Set<Promise<void>>; failure?: unknown } = { pending };
  reports.set(operation, state);
  const deadline = performance.now() + 60_000;
  const expire = () => {
    controller.abort(
      Object.assign(new Error('The report exceeded its 60 second budget.'), { code: 'STIM_REPORT_TIMEOUT' }),
    );
  };
  const timer = setTimeout(expire, 60_000);
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
    while (pending.size) await Promise.allSettled(pending);
  });
  if ('failure' in state) throw state.failure;
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}
