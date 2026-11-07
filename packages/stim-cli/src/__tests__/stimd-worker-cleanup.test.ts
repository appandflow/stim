import { createPassesLane, type ThreadTable } from '../stimd/threads.ts';

test('a worker cleanup refusal stays visible after the lane settles', async () => {
  const failure = Object.assign(new Error('worker child is unverified'), {
    code: 'STIM_CLAIM_UNAVAILABLE',
    remedy: 'Inspect worker child.',
    reportCleanup: true,
  });
  const reported = vi.fn<(error: unknown) => void>();
  const threads: ThreadTable = {
    run: async () => {
      throw failure;
    },
    abort: () => {},
    close: async () => {},
  };
  const lane = createPassesLane(threads, () => {}, reported);
  Reflect.apply(lane.start, lane, [{}, false]);
  await expect(lane.settled()).rejects.toBe(failure);
  await expect(lane.settled()).rejects.toBe(failure);
  expect(reported).toHaveBeenCalledWith(failure);
});
