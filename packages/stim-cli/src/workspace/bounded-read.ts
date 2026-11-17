/**
 * The one filesystem read, of the launcher directories or the home scan, that timed out and has not settled. A timed-out
 * native read cannot be cancelled, so while one is pending no further read of either kind starts: a hung mount holds
 * exactly one libuv thread however many readings and scans are asked for. Module state, so the bound is one outstanding
 * read per JavaScript isolate: the daemon's main thread and its passes thread each have their own.
 */
let hung: { label: string } | null = null;

export class Unanswered extends Error {}

/** The folder whose read timed out and is still pending, or null when none is. */
export function hungRead(): string | null {
  return hung?.label ?? null;
}

/**
 * `start()`'s result, or an `Unanswered` rejection when it has not answered in `timeoutMs`; the read keeps running, and
 * is the pending one until it settles. It starts no read at all while one is pending, so the slot is never overwritten.
 */
export async function answered<T>(label: string, start: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (hung) throw new Unanswered(`a read of ${hung.label} is still pending`);
  const read = start();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Unanswered('timed out')), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof Unanswered) {
      const mine = { label };
      hung = mine;
      const settled = () => {
        if (hung === mine) hung = null;
      };
      read.then(settled, settled);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
