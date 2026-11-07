import { buildSlotPath, type BuildWaitingFor } from '@stim-cli/core/state';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimRemoveCommand } from '../ownership-claim.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';
import {
  acquireBuildSlot,
  buildSlotUsage,
  listBuildSlots,
  releaseBuildSlot,
  tryAcquireBuildSlot,
} from '../engine/build-slots.ts';
import { liveWaiters, positionCeilingMs, waitCeiling } from '../engine/wait-queue.ts';
import { buildClaimRoot } from '../engine-store/claims.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-slots-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe('tryAcquireBuildSlot', () => {
  test('reclaims a slot whose builder is GONE, whatever its age', () => {
    for (const i of [0, 1]) plantClaim(buildSlotPath(i), 'exclusive', goneClaimOwner(), { details: { index: i } });
    const got = tryAcquireBuildSlot({ max: 2 });
    assert(got);
    expect(got.acquired).toBe(true);
    expect(got.index).toBe(0);
  });

  test('a slot whose holder cannot be identified is skipped, waits while another is busy, and refuses when neither', () => {
    const planted = plantClaim(
      buildSlotPath(0),
      'exclusive',
      { pid: 4242, processToken: 'nonsense' },
      { details: { index: 0 } },
    );
    const got = tryAcquireBuildSlot({ max: 2 });
    assert(got);
    expect(got.index).toBe(1);

    releaseBuildSlot(got);
    plantClaim(buildSlotPath(1), 'exclusive', liveClaimOwner(), { details: { index: 1 } });
    expect(tryAcquireBuildSlot({ max: 2 })).toBe(null);

    let err: (Error & { code?: string }) | undefined;
    try {
      tryAcquireBuildSlot({ max: 1 });
    } catch (e) {
      err = e as Error & { code?: string };
    }
    expect(err?.code).toBe('STIM_CLAIM_REFUSED');
    expect(err?.message).toContain(claimRemoveCommand(planted));
  });
});

describe('acquireBuildSlot', () => {
  describe('while another build is staged', () => {
    const engine = { root: '', build: 'aaaaaaaaaaaa' };
    const write = (name: string, record: Record<string, unknown>) =>
      writeFileSync(join(engine.root, name), JSON.stringify({ format: 1, ...record }));
    beforeEach(() => {
      engine.root = join(tmpHome, 'engine');
      mkdirSync(engine.root);
      write('current.json', { dir: engine.build, version: '1.50.0' });
      write('staged.json', { dir: 'bbbbbbbbbbbb', version: '1.51.0', stagedAt: new Date(0).toISOString() });
    });

    test('a miss holds before its slot and ends with the rerun line once the engine switches', async () => {
      const held = tryAcquireBuildSlot({ max: 2 });
      assert(held);
      const lines: string[] = [];
      let clock = 0;
      const outcome = acquireBuildSlot({
        max: 2,
        engine,
        now: () => clock,
        out: (line) => lines.push(line),
        sleep: async () => {
          clock += 60_000;
          if (clock < 3 * 60_000) return;
          rmSync(join(engine.root, 'staged.json'));
          write('current.json', { dir: 'bbbbbbbbbbbb', version: '1.51.0' });
        },
      });
      await expect(outcome).rejects.toMatchObject({
        code: 'STIM_ENGINE_SWITCHED',
        message: 'Stim updated to 1.51.0; rerun',
      });
      expect(lines).toEqual(['switching Stim to 1.51.0; waiting for 1 running builds']);
      expect(listBuildSlots().map((slot) => slot.path)).toEqual([held.path]);
      releaseBuildSlot(held);
    });

    test('a retained lifetime takes a build slot without waiting for an impossible promotion', async () => {
      plantClaim(buildClaimRoot(engine.root, engine.build), 'shared', liveClaimOwner(), {
        details: { retained: true, drained: false },
      });
      let waited = false;
      const handle = await acquireBuildSlot({
        max: 1,
        engine,
        now: () => 0,
        sleep: async () => {
          waited = true;
        },
      });
      expect(handle.acquired).toBe(true);
      expect(waited).toBe(false);
      releaseBuildSlot(handle);
    });

    test('a retained old build still refuses after the engine switched with unlimited slots', async () => {
      plantClaim(buildClaimRoot(engine.root, engine.build), 'shared', liveClaimOwner(), {
        details: { retained: true, drained: false },
      });
      write('current.json', { dir: 'bbbbbbbbbbbb', version: '1.51.0' });
      await expect(acquireBuildSlot({ max: 0, engine, now: () => 0 })).rejects.toMatchObject({
        code: 'STIM_ENGINE_SWITCHED',
      });
    });

    test('the hold ends 10 minutes after the staging and the miss takes its slot', async () => {
      let clock = 0;
      const handle = await acquireBuildSlot({
        max: 1,
        engine,
        now: () => clock,
        sleep: async () => {
          clock += 60_000;
        },
      });
      expect(clock).toBe(10 * 60_000);
      expect(handle.acquired).toBe(true);
      releaseBuildSlot(handle);
    });
  });

  test('cancelling a queued build clears its wait without acquiring or releasing another builder slot', async () => {
    const held = tryAcquireBuildSlot({ max: 1, root: '/another/build' });
    assert(held);
    const controller = new AbortController();
    const waitingFor = vi.fn<(info: BuildWaitingFor | null) => void>();
    const pending = acquireBuildSlot({ max: 1, signal: controller.signal, waitingFor });
    const outcome = pending.then(
      (handle) => {
        releaseBuildSlot(handle);
        return 'acquired';
      },
      (error: { code?: string }) => error.code,
    );
    try {
      await vi.waitFor(() => expect(waitingFor).toHaveBeenCalledWith(expect.objectContaining({ kind: 'build-slot' })));
      controller.abort();
      expect(
        await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200))]),
      ).toBe('STIM_CANCELLED');
      expect(waitingFor).toHaveBeenLastCalledWith(null);
      expect(listBuildSlots().map((slot) => slot.path)).toEqual([held.path]);
    } finally {
      releaseBuildSlot(held);
      await outcome;
    }
  });

  test('a queued build reports its slot wait and keeps progress pointing to concurrency guidance', async () => {
    const held = tryAcquireBuildSlot({ max: 1 });
    assert(held);
    let clock = 0;
    const lines: string[] = [];
    const waitingFor = vi.fn<(info: BuildWaitingFor | null) => void>();
    const acquired = await acquireBuildSlot({
      max: 1,
      waitingFor,
      now: () => clock,
      out: (line) => lines.push(line),
      sleep: async () => {
        clock += 10000;
        if (clock === 90000) releaseBuildSlot(held);
      },
    });
    expect(acquired.slotWaitMs).toBe(90_000);
    expect(lines).toHaveLength(8);
    expect(lines.every((line) => line.endsWith(' -- stim guide lifecycle concurrency'))).toBe(true);
    expect(lines[0]).toContain('queue position 1 of 1');
    expect(lines[0]).toContain('10s elapsed');
    expect(lines[7]).toContain('1m20s elapsed');
    expect(waitingFor.mock.calls[0]?.[0]).toEqual({
      kind: 'build-slot',
      inUse: 1,
      max: 1,
      since: new Date(0).toISOString(),
      position: 1,
      resource: 'build slots',
    });
    expect(waitingFor).toHaveBeenLastCalledWith(null);
    releaseBuildSlot(acquired);
  });

  test('a free slot reports no wait even when acquiring the claim takes time', async () => {
    let clock = 0;
    const got = await acquireBuildSlot({
      max: 1,
      now: () => clock++,
      sleep: async () => {
        throw new Error('a free slot must not sleep');
      },
    });
    expect(got.slotWaitMs).toBe(0);
    releaseBuildSlot(got);
  });

  test('a freed slot goes to the oldest waiting build, never to a later one', async () => {
    const held = tryAcquireBuildSlot({ max: 1, root: '/w/held' });
    assert(held);
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const slowTick = async () => {
      for (let turn = 0; turn < 5; turn++) await tick();
    };
    const first = acquireBuildSlot({ max: 1, root: '/w/first', sleep: slowTick });
    await vi.waitFor(() => expect(liveWaiters('build')).toHaveLength(1));
    const second = acquireBuildSlot({ max: 1, root: '/w/second', sleep: tick });
    await vi.waitFor(() => expect(liveWaiters('build')).toHaveLength(2));
    releaseBuildSlot(held);
    const firstHandle = await first;
    expect(firstHandle.slot?.projectRoot).toBe('/w/first');
    await vi.waitFor(() => expect(liveWaiters('build').map((holder) => holder.details.root)).toEqual(['/w/second']));
    releaseBuildSlot(firstHandle);
    const secondHandle = await second;
    expect(secondHandle.slot?.projectRoot).toBe('/w/second');
    releaseBuildSlot(secondHandle);
    expect(liveWaiters('build')).toEqual([]);
  });

  test('a slot whose holder cannot be identified refuses at once when no other slot is busy, never a silent wait', async () => {
    const planted = plantClaim(
      buildSlotPath(0),
      'exclusive',
      { pid: 4242, processToken: 'nonsense' },
      {
        details: { index: 0 },
      },
    );
    await expect(
      acquireBuildSlot({
        max: 1,
        sleep: async () => {
          throw new Error('an unresolved slot must not make the build wait');
        },
      }),
    ).rejects.toMatchObject({
      code: 'STIM_CLAIM_REFUSED',
      message: expect.stringContaining(claimRemoveCommand(planted)),
    });
  });

  test('a build behind a live holder keeps waiting until the 90-minute ceiling, then refuses with the queue state', async () => {
    const held = tryAcquireBuildSlot({ max: 1, root: '/w/held' });
    assert(held);
    let clock = 0;
    try {
      await expect(
        acquireBuildSlot({
          max: 1,
          root: '/w/waiting',
          now: () => clock,
          sleep: async () => {
            clock += 60_000;
          },
        }),
      ).rejects.toMatchObject({
        code: 'STIM_AT_CAPACITY',
        message: expect.stringMatching(/at queue position 1 of 1; held: slot 0 \(\/w\/held/),
      });
      expect(clock).toBe(90 * 60_000);
      expect(liveWaiters('build')).toEqual([]);
    } finally {
      releaseBuildSlot(held);
    }
  });
});

describe('a waiting build re-reads concurrency.maxBuilds each round', () => {
  const writeConcurrency = (concurrency: Record<string, number>) =>
    writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({ concurrency }));
  const waitThen = (change: () => void, extra: { max?: number } = {}) => {
    let clock = 0;
    let slept = 0;
    return acquireBuildSlot({
      ...extra,
      root: '/w/waiting',
      now: () => clock,
      sleep: async () => {
        clock += 1000;
        if (++slept === 1) change();
      },
    });
  };

  test.each([
    ['a raised concurrency.maxBuilds in config', () => writeConcurrency({ maxBuilds: 2 })],
    ['a raised STIM_MAX_BUILDS', () => vi.stubEnv('STIM_MAX_BUILDS', '2')],
  ])('%s admits the build that was already waiting', async (_name, raise) => {
    writeConcurrency({ maxBuilds: 1 });
    const held = tryAcquireBuildSlot({ max: 1, root: '/w/held' });
    assert(held);
    try {
      const got = await waitThen(raise);
      expect(got.index).toBe(1);
      releaseBuildSlot(got);
    } finally {
      vi.unstubAllEnvs();
      releaseBuildSlot(held);
    }
  });

  test('a cap that stays low keeps the build waiting until the ceiling', async () => {
    writeConcurrency({ maxBuilds: 1 });
    const held = tryAcquireBuildSlot({ max: 1, root: '/w/held' });
    assert(held);
    try {
      await expect(waitThen(() => writeConcurrency({ maxBuilds: 1 }))).rejects.toMatchObject({
        code: 'STIM_AT_CAPACITY',
      });
    } finally {
      releaseBuildSlot(held);
    }
  });

  test('an explicit max still wins over a raised config', async () => {
    writeConcurrency({ maxBuilds: 1 });
    const held = tryAcquireBuildSlot({ max: 1, root: '/w/held' });
    assert(held);
    try {
      await expect(waitThen(() => writeConcurrency({ maxBuilds: 2 }), { max: 1 })).rejects.toMatchObject({
        code: 'STIM_AT_CAPACITY',
      });
    } finally {
      releaseBuildSlot(held);
    }
  });
});

test('a build behind a slot whose holder cannot be verified refuses after the position ceiling', async () => {
  plantClaim(buildSlotPath(0), 'exclusive', { pid: 4242, processToken: 'nonsense' }, { details: { index: 0 } });
  const held = tryAcquireBuildSlot({ max: 2, root: '/w/held' });
  assert(held);
  let clock = 0;
  try {
    await expect(
      acquireBuildSlot({
        max: 2,
        root: '/w/waiting',
        now: () => clock,
        sleep: async () => {
          clock += 60_000;
        },
      }),
    ).rejects.toMatchObject({
      code: 'STIM_AT_CAPACITY',
      message: expect.stringContaining('cannot be verified for 10m00s'),
    });
    expect(clock).toBe(10 * 60_000);
  } finally {
    releaseBuildSlot(held);
  }
});

test.each([
  { position: 1, minutes: 10 },
  { position: 2, minutes: 10 },
  { position: 3, minutes: 15 },
  { position: 6, minutes: 30 },
])('position $position waits $minutes minutes on an unverifiable holder', ({ position, minutes }) => {
  expect(positionCeilingMs(position)).toBe(minutes * 60_000);
});

describe('waitCeiling', () => {
  test('never refuses while every holder is provably alive, until 90 minutes in all', () => {
    let clock = 0;
    const ceiling = waitCeiling(() => clock);
    ceiling.update(1, null);
    clock = 89 * 60_000;
    expect(ceiling.overdue()).toBeNull();
    clock = 90 * 60_000;
    expect(ceiling.overdue()).toEqual({ kind: 'absolute', waitedMs: 90 * 60_000 });
  });

  test('refuses once a holder stays unverifiable for the position ceiling, restarted by progress or a live holder', () => {
    let clock = 0;
    const ceiling = waitCeiling(() => clock);
    ceiling.update(3, 'slot 0 cannot be verified');
    clock = 14 * 60_000;
    expect(ceiling.overdue()).toBeNull();
    ceiling.update(2, 'slot 0 cannot be verified');
    clock = 23 * 60_000;
    expect(ceiling.overdue()).toBeNull();
    ceiling.update(2, null);
    ceiling.update(2, 'slot 0 cannot be verified');
    clock = 32 * 60_000;
    expect(ceiling.overdue()).toBeNull();
    clock = 33 * 60_000;
    expect(ceiling.overdue()).toEqual({
      kind: 'unverified',
      position: 2,
      waitedMs: 10 * 60_000,
      reason: 'slot 0 cannot be verified',
    });
  });
});

test('status slot usage counts the live and unresolved slots a build could take, with each holder', () => {
  plantClaim(buildSlotPath(0), 'exclusive', liveClaimOwner(), { details: { index: 0, projectRoot: '/w/a' } });
  plantClaim(buildSlotPath(1), 'exclusive', goneClaimOwner(), { details: { index: 1, projectRoot: '/w/gone' } });
  plantClaim(buildSlotPath(2), 'exclusive', liveClaimOwner(), {
    details: { index: 2, offloaded: true, client: 'dev-1', repo: 'r', job: 'j' },
  });
  plantClaim(buildSlotPath(3), 'exclusive', { pid: 4242, processToken: 'nonsense' }, { details: { index: 3 } });
  plantClaim(buildSlotPath(4), 'exclusive', liveClaimOwner(), { details: { index: 4, projectRoot: '/w/over' } });
  const usage = buildSlotUsage(4);
  expect(usage).toMatchObject({
    max: 4,
    inUse: 3,
    holders: [
      { slot: 0, workspace: '/w/a', client: null },
      { slot: 2, workspace: null, client: 'dev-1' },
      { slot: 3, workspace: null, client: null, since: null, unresolved: true },
    ],
  });
  expect(usage.holders[0]?.since).toEqual(expect.any(String));
});

test('automatic build admission rechecks membership after waiting without releasing another build', async () => {
  const held = tryAcquireBuildSlot({ max: 1 });
  assert(held);
  const sleeping = vi.fn<() => Promise<void>>(async () => {
    writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({ remote: { buildPoolDisabled: ['local'] } }));
  });
  try {
    await expect(acquireBuildSlot({ max: 1, automatic: true, sleep: sleeping })).rejects.toMatchObject({
      code: 'STIM_OFFLOAD_REFUSED',
    });
    expect(sleeping).toHaveBeenCalledOnce();
    expect(listBuildSlots().filter((slot) => slot.alive)).toHaveLength(1);
    await expect(acquireBuildSlot({ max: 0, automatic: true })).rejects.toMatchObject({ code: 'STIM_OFFLOAD_REFUSED' });
    await expect(acquireBuildSlot({ max: 0 })).resolves.toMatchObject({ unlimited: true });
  } finally {
    releaseBuildSlot(held);
  }
});
