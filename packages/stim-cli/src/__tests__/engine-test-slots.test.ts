import { testSlotPath } from '@stim-cli/core/state';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimRemoveCommand } from '../ownership-claim.ts';
import { goneClaimOwner, plantClaim } from './_factories.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import {
  acquireTestSlot,
  listTestSlots,
  releaseTestSlot,
  testSlotUsage,
  tryAcquireTestSlot,
} from '../engine/test-slots.ts';
import { listTestWaiting, liveWaiters } from '../engine/wait-queue.ts';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-slots-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('two holders fill a two-slot cap and a third waits in arrival order, then takes the first freed slot', async () => {
  const first = tryAcquireTestSlot({ max: 2, root: '/w/first' });
  const second = tryAcquireTestSlot({ max: 2, root: '/w/second' });
  assert(first && second);
  expect([first.index, second.index]).toEqual([0, 1]);
  expect(tryAcquireTestSlot({ max: 2 })).toBeNull();

  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const third = acquireTestSlot({ max: 2, root: '/w/third', sleep: tick });
  await vi.waitFor(() => expect(liveWaiters('test')).toHaveLength(1));
  const fourth = acquireTestSlot({ max: 2, root: '/w/fourth', sleep: tick });
  await vi.waitFor(() => expect(liveWaiters('test')).toHaveLength(2));
  expect(listTestWaiting().map((waiter) => [waiter.position, waiter.workspace])).toEqual([
    [1, '/w/third'],
    [2, '/w/fourth'],
  ]);
  expect(testSlotUsage(2)).toMatchObject({ max: 2, inUse: 2 });

  releaseTestSlot(second);
  const thirdHandle = await third;
  expect(thirdHandle.slot?.projectRoot).toBe('/w/third');
  expect(thirdHandle.index).toBe(1);
  await vi.waitFor(() => expect(liveWaiters('test').map((holder) => holder.details.root)).toEqual(['/w/fourth']));

  releaseTestSlot(first);
  const fourthHandle = await fourth;
  expect(fourthHandle.slot?.projectRoot).toBe('/w/fourth');
  releaseTestSlot(thirdHandle);
  releaseTestSlot(fourthHandle);
  expect(liveWaiters('test')).toEqual([]);
  expect(listBuildSlots()).toEqual([]);
});

test('a slot whose holder is gone is recovered by the next acquirer', () => {
  plantClaim(testSlotPath(0), 'exclusive', goneClaimOwner(), { details: { index: 0 } });
  const got = tryAcquireTestSlot({ max: 1 });
  assert(got);
  expect(got.index).toBe(0);
  expect(listTestSlots().map((slot) => slot.alive)).toEqual([true]);
  releaseTestSlot(got);
});

test('a slot whose holder cannot be identified refuses with the claim removal command, never a silent wait', async () => {
  const planted = plantClaim(
    testSlotPath(0),
    'exclusive',
    { pid: 4242, processToken: 'nonsense' },
    { details: { index: 0 } },
  );
  await expect(
    acquireTestSlot({
      max: 1,
      sleep: async () => {
        throw new Error('an unresolved slot must not make the run wait');
      },
    }),
  ).rejects.toMatchObject({
    code: 'STIM_CLAIM_REFUSED',
    message: expect.stringContaining(claimRemoveCommand(planted)),
  });
});

test('a waiting test run reads concurrency.maxTests again each round', async () => {
  writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({ concurrency: { maxTests: 1 } }));
  const held = tryAcquireTestSlot({ max: 1 });
  assert(held);
  let slept = 0;
  const got = await acquireTestSlot({
    root: '/w/waiting',
    sleep: async () => {
      if (++slept === 1) writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({ concurrency: { maxTests: 2 } }));
    },
  });
  expect(got.index).toBe(1);
  releaseTestSlot(got);
  releaseTestSlot(held);
});

test('a test run behind a live holder refuses with STIM_AT_CAPACITY naming the test setting', async () => {
  const held = tryAcquireTestSlot({ max: 1, root: '/w/held' });
  assert(held);
  let clock = 0;
  try {
    await expect(
      acquireTestSlot({
        max: 1,
        now: () => clock,
        sleep: async () => {
          clock += 60_000;
        },
      }),
    ).rejects.toMatchObject({
      code: 'STIM_AT_CAPACITY',
      remedy: expect.stringContaining('concurrency.maxTests'),
    });
    expect(liveWaiters('test')).toEqual([]);
  } finally {
    releaseTestSlot(held);
  }
});

test('a staged engine switch ends a queued test run with STIM_ENGINE_SWITCHED', async () => {
  const root = join(tmpHome, 'engine');
  const engine = { root, build: 'aaaaaaaaaaaa' };
  mkdirSync(root);
  const write = (name: string, record: Record<string, unknown>) =>
    writeFileSync(join(root, name), JSON.stringify({ format: 1, ...record }));
  write('current.json', { dir: engine.build, version: '1.50.0' });
  write('staged.json', { dir: 'bbbbbbbbbbbb', version: '1.51.0', stagedAt: new Date(0).toISOString() });
  let clock = 0;
  await expect(
    acquireTestSlot({
      max: 1,
      engine,
      now: () => clock,
      sleep: async () => {
        clock += 60_000;
        if (clock < 3 * 60_000) return;
        rmSync(join(root, 'staged.json'));
        write('current.json', { dir: 'bbbbbbbbbbbb', version: '1.51.0' });
      },
    }),
  ).rejects.toMatchObject({ code: 'STIM_ENGINE_SWITCHED' });
});
