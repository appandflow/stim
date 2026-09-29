import { BuildMachinesCache, loadMachineDetails, MachineDetailsCache } from '../src/machine-details.ts';
import type { MachineDetails } from '../src/protocol.ts';

type GcStats = Omit<MachineDetails, 'buildMachines'>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets a background `.then()` chain settle before the next assertion reads the cache. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const RESULT: GcStats = { gc: {}, stats: {}, measuredAt: '2026-09-28T10:00:00.000Z' };

describe('MachineDetailsCache', () => {
  it('shares a running load, reuses its result for the ttl, then loads again', async () => {
    let now = 0;
    const loads: ReturnType<typeof deferred<GcStats>>[] = [];
    const cache = new MachineDetailsCache(
      () => {
        const load = deferred<GcStats>();
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

describe('loadMachineDetails', () => {
  it('runs gc and stats only, without a buildMachines part', async () => {
    const calls: string[] = [];
    const run = (args: string[]) => {
      calls.push(args[0]!);
      return Promise.resolve({ ok: true as const, stdout: JSON.stringify({ args }) });
    };
    expect(await loadMachineDetails(run)).toMatchObject({
      gc: { args: ['gc', '--json'] },
      stats: { args: ['stats', '--json'] },
    });
    expect(calls.toSorted()).toEqual(['gc', 'stats']);
  });
});

describe('BuildMachinesCache', () => {
  const run = (args: string[]) => Promise.resolve({ ok: true as const, stdout: JSON.stringify({ args }) });

  it('runs no doctor when offload.machines names none, and says why when no workspace can run it', () => {
    const calls: string[] = [];
    const counted = (args: string[]) => {
      calls.push(args[0]!);
      return run(args);
    };
    const cache = new BuildMachinesCache();
    expect(cache.snapshot(counted, null)).toEqual({ buildMachines: [] });
    expect(cache.snapshot(counted, { cwd: null })).toEqual({
      buildMachines: null,
      buildMachinesError: 'no Stim workspace is registered to check them from',
    });
    expect(cache.snapshot(counted, { error: 'config.json is not JSON' })).toEqual({
      buildMachines: null,
      buildMachinesError: 'config.json is not JSON',
    });
    expect(calls).not.toContain('doctor');
  });

  it('says to update a stim whose doctor reports no build machines, once settled', async () => {
    const cache = new BuildMachinesCache();
    expect(cache.snapshot(run, { cwd: '/app' })).toEqual({ buildMachines: null, buildMachinesPending: true });
    await flush();
    expect(cache.snapshot(run, { cwd: '/app' })).toMatchObject({
      buildMachines: null,
      buildMachinesError: 'This stim does not report build machines; update it.',
    });
  });

  it('answers immediately while doctor runs in the background, starting exactly one run', async () => {
    let now = 1000;
    const load = deferred<{ ok: true; stdout: string }>();
    const calls: string[] = [];
    const runOnce = (args: string[]) => {
      calls.push(args[0]!);
      return load.promise;
    };
    const cache = new BuildMachinesCache(60_000, () => now);

    const first = cache.snapshot(runOnce, { cwd: '/app' });
    expect(first).toEqual({ buildMachines: null, buildMachinesPending: true });

    const second = cache.snapshot(runOnce, { cwd: '/app' });
    expect(second).toEqual(first);
    expect(calls).toEqual(['doctor']);

    load.resolve({ ok: true, stdout: JSON.stringify({ buildMachines: [{ machine: 'mini', state: 'approved' }] }) });
    await flush();

    expect(cache.snapshot(runOnce, { cwd: '/app' })).toEqual({
      buildMachines: [{ machine: 'mini', state: 'approved' }],
      buildMachinesAt: new Date(now).toISOString(),
    });
    expect(calls).toEqual(['doctor']);
  });

  it('serves the stale result with pending while refreshing once the ttl expires', async () => {
    let now = 0;
    const calls: string[] = [];
    const cache = new BuildMachinesCache(60_000, () => now);
    const runOnce = (args: string[]) => {
      calls.push(args[0]!);
      return Promise.resolve({ ok: true as const, stdout: JSON.stringify({ buildMachines: [] }) });
    };

    cache.snapshot(runOnce, { cwd: '/app' });
    await flush();
    expect(cache.snapshot(runOnce, { cwd: '/app' })).toEqual({
      buildMachines: [],
      buildMachinesAt: new Date(0).toISOString(),
    });
    expect(calls).toEqual(['doctor']);

    now = 59_999;
    expect(cache.snapshot(runOnce, { cwd: '/app' })).toEqual({
      buildMachines: [],
      buildMachinesAt: new Date(0).toISOString(),
    });
    expect(calls).toEqual(['doctor']);

    now = 60_000;
    expect(cache.snapshot(runOnce, { cwd: '/app' })).toEqual({
      buildMachines: [],
      buildMachinesAt: new Date(0).toISOString(),
      buildMachinesPending: true,
    });
    expect(calls).toEqual(['doctor', 'doctor']);
    await flush();
    expect(cache.snapshot(runOnce, { cwd: '/app' })).toEqual({
      buildMachines: [],
      buildMachinesAt: new Date(60_000).toISOString(),
    });
  });
});
