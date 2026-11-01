import { buildSlotPath, type BuildWaitingFor } from '@stim-cli/core/state';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.endsWith(' -- stim guide lifecycle concurrency'))).toBe(true);
    expect(lines[0]).toContain('30s elapsed');
    expect(lines[1]).toContain('1m00s elapsed');
    expect(waitingFor.mock.calls[0]?.[0]).toEqual({
      kind: 'build-slot',
      inUse: 1,
      max: 1,
      since: new Date(0).toISOString(),
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
