import { MachineDetailsCache } from '../src/machine-details.ts';
import type { MachineDetails } from '../src/protocol.ts';

function deferred() {
  let resolve!: (value: MachineDetails) => void;
  const promise = new Promise<MachineDetails>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const RESULT: MachineDetails = { gc: {}, stats: {}, measuredAt: '2026-09-28T10:00:00.000Z' };

describe('MachineDetailsCache', () => {
  it('shares a running load, reuses its result for the ttl, then loads again', async () => {
    let now = 0;
    const loads: ReturnType<typeof deferred>[] = [];
    const cache = new MachineDetailsCache(
      () => {
        const load = deferred();
        loads.push(load);
        return load.promise;
      },
      60_000,
      () => now,
    );

    const first = cache.get();
    now = 30_000;
    const joined = cache.get();
    expect(loads).toHaveLength(1);
    loads[0]!.resolve(RESULT);
    expect(await first).toBe(RESULT);
    expect(await joined).toBe(RESULT);

    now = 30_000 + 59_999;
    expect(await cache.get()).toBe(RESULT);
    expect(loads).toHaveLength(1);

    now = 30_000 + 60_000;
    void cache.get();
    expect(loads).toHaveLength(2);
  });
});
