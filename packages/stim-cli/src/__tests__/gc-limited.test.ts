import { eachLimited } from '../commands/gc/limited.ts';

test('a cleanup failure wins over an earlier abort, and no item starts after a failure', async () => {
  const started: number[] = [];
  const cleanup = Object.assign(new Error('child cleanup unverified'), { reportCleanup: true });
  const run = eachLimited([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    if (item === 0) throw new DOMException('aborted', 'AbortError');
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw cleanup;
  });
  const failed = run.then(
    () => null,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(10);
  expect(await failed).toBe(cleanup);
  expect(started).toEqual([0, 1]);
});
