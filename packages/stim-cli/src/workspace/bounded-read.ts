/** Default timeout for a bounded filesystem read of a checkout layout. */
export const READ_TIMEOUT_MS = 3000;

/**
 * The one filesystem read, of the home scan, a checkout's source scan or a discovery listing, that timed out and has
 * not settled. A timed-out native read cannot be cancelled, so while one is pending no further read of any kind starts: a hung mount holds
 * exactly one libuv thread however many readings and scans are asked for. Module state, so the bound is one outstanding
 * read per JavaScript isolate: the daemon's main thread and its passes thread each have their own.
 */
let hung: { label: string; settled?: Promise<void> } | null = null;

export class Unanswered extends Error {}

/** The folder whose read timed out and is still pending, or null when none is. */
export function hungRead(): string | null {
  return hung?.label ?? null;
}

/** Settles once the pending read has settled and freed the slot, or null when no read is pending. */
export function pendingRead(): Promise<void> | null {
  return hung?.settled ?? null;
}

/**
 * `start()`'s result, or an `Unanswered` rejection when it has not answered in `timeoutMs`; the read keeps running, and
 * is the pending one until it settles. It starts no read at all while one is pending, so the slot is never overwritten.
 * When `signal` aborts first it rejects with the abort reason at once, and the unsettled read is the pending one too.
 */
export async function answered<T>(
  label: string,
  start: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (hung) throw new Unanswered(`a read of ${hung.label} is still pending`);
  signal?.throwIfAborted();
  const read = start();
  let timer: NodeJS.Timeout | undefined;
  let stop: (() => void) | undefined;
  let settled = false;
  const settle = () => {
    settled = true;
  };
  read.then(settle, settle);
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Unanswered('timed out')), timeoutMs);
        if (signal) {
          stop = () => fail(signal.reason);
          signal.addEventListener('abort', stop, { once: true });
        }
      }),
    ]);
  } catch (error) {
    if (error instanceof Unanswered || (signal?.aborted && !settled)) {
      const mine: { label: string; settled?: Promise<void> } = { label };
      hung = mine;
      const release = () => {
        if (hung === mine) hung = null;
      };
      mine.settled = read.then(release, release);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (stop) signal?.removeEventListener('abort', stop);
  }
}
