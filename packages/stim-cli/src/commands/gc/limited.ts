export async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items[Symbol.iterator]();
  let failed = false;
  const worker = async (): Promise<void> => {
    for (const item of queue) {
      if (failed) return;
      try {
        await run(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

export const READ_CONCURRENCY = 6;
