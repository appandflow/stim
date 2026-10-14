import { type StimContext } from '@stim-cli/core';

const reports = new WeakMap<StimContext, Set<Promise<void>>>();

export function reportSignal(context: StimContext | undefined): AbortSignal | undefined {
  return context && reports.has(context) ? context.signal : undefined;
}

export function trackReportResource(
  context: StimContext | undefined,
  closed: Promise<void>,
  cancel: () => void | Promise<void>,
  signal: AbortSignal | undefined = context?.signal,
): void {
  const pending = context && reports.get(context);
  if (!context || !pending || !signal) return;
  const abort = () => {
    const cancelled = Promise.resolve().then(cancel);
    pending.add(cancelled);
    void cancelled.then(
      () => pending.delete(cancelled),
      () => pending.delete(cancelled),
    );
  };
  pending.add(closed);
  void closed.then(() => {
    signal.removeEventListener('abort', abort);
    return pending.delete(closed);
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
  reports.set(operation, pending);
  const deadline = performance.now() + 60_000;
  const expire = () => {
    controller.abort(
      Object.assign(new Error('The report exceeded its 60 second budget.'), { code: 'STIM_REPORT_TIMEOUT' }),
    );
  };
  const timer = setTimeout(expire, 60_000);
  try {
    return await (async () => {
      signal.throwIfAborted();
      const result = await work(operation);
      if (performance.now() >= deadline) expire();
      signal.throwIfAborted();
      return result;
    })();
  } finally {
    clearTimeout(timer);
    controller.abort();
    while (pending.size) await Promise.allSettled(pending);
  }
}
