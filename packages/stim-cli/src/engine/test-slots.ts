import { testSlotLimit, testSlotsDir, tryAcquireTestSlotClaim, type StatusBuildSlots } from '@stim-cli/core/state';
import {
  acquireSlot,
  listSlots,
  releaseSlot,
  slotUsage,
  tryAcquireSlot,
  type AcquireSlotOptions,
  type SlotClass,
  type SlotHandle,
  type SlotInfo,
  type TryAcquireSlotOptions,
} from './slot-queue.ts';

export type TestSlotHandle = SlotHandle;
export type TestSlotInfo = SlotInfo;

const TEST_SLOTS: SlotClass = {
  resource: 'test',
  noun: 'test',
  doing: 'running a test',
  setting: 'concurrency.maxTests',
  dir: testSlotsDir,
  readMax: () => testSlotLimit().max,
  tryAcquire: tryAcquireTestSlot,
};

export function tryAcquireTestSlot(options: TryAcquireSlotOptions): TestSlotHandle | null {
  return tryAcquireSlot(tryAcquireTestSlotClaim, options);
}

/**
 * Takes one of the `concurrency.maxTests` test slots in arrival order, waiting in `$STIM_HOME/test-waits`; see
 * `acquireSlot`. The claim stays child-aware for the holder's lifetime, so a test command run under the slot is
 * tracked as its child until `releaseTestSlot`.
 */
export function acquireTestSlot(options: AcquireSlotOptions): Promise<TestSlotHandle> {
  return acquireSlot(TEST_SLOTS, options);
}

export function releaseTestSlot(handle?: TestSlotHandle | null): boolean {
  return releaseSlot(TEST_SLOTS, handle);
}

export function listTestSlots(): TestSlotInfo[] {
  return listSlots(TEST_SLOTS);
}

/** The `concurrency.maxTests` slots a new test run could take, `0` to `max - 1`, and who holds each busy one. */
export function testSlotUsage(
  max: number = testSlotLimit().max,
  slots: TestSlotInfo[] = listTestSlots(),
): StatusBuildSlots {
  return slotUsage(max, slots);
}
