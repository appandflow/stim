export function cancelledError(what: string, cause?: unknown): Error & { code: 'STIM_CANCELLED' } {
  return Object.assign(new Error(`The ${what} was cancelled.`, cause === undefined ? undefined : { cause }), {
    code: 'STIM_CANCELLED' as const,
  });
}

export function throwIfCancelled(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted) throw cancelledError(what);
}

export function cancellableSleep(
  ms: number,
  { signal, what = 'wait', ref = true }: { signal?: AbortSignal; what?: string; ref?: boolean } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError(what));
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError(what));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (!ref) timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
