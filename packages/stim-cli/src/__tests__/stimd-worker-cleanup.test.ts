import { createPassesLane, type ThreadTable } from '../stimd/threads.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';

test('a worker cleanup refusal stays visible after the lane settles', async () => {
  const failure = new WorkspaceProcessCleanupError([], 'worker child is unverified', 'Inspect worker child.');
  const reported = vi.fn<(error: unknown) => boolean>(() => false);
  const threads: ThreadTable = {
    drainTrash: async () => {},
    run: async () => {
      throw failure;
    },
    abort: () => {},
    settle: () => {},
    close: async () => {},
    gc: () => ({ result: new Promise(() => {}), leave: () => {} }),
    headroom: () => ({ result: Promise.resolve({ headroom: true as const }), leave: () => {} }),
    item: () => ({ result: new Promise(() => {}), leave: () => {} }),
  };
  const lane = createPassesLane(threads, () => {}, reported);
  Reflect.apply(lane.start, lane, [{}, false]);
  await expect(lane.settled()).rejects.toBe(failure);
  await expect(lane.settled()).rejects.toBe(failure);
  expect(reported).toHaveBeenCalledWith(failure);
  expect(failure).toMatchObject({
    code: 'STIM_CLAIM_UNAVAILABLE',
    reportCleanup: true,
    remedy: expect.stringContaining('Inspect worker child.'),
  });
});
