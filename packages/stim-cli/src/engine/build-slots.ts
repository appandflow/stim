import {
  buildSlotsDir,
  tryAcquireBuildSlotClaim,
  requireAutomaticMachine,
  type BuildWaitingFor,
  type StatusBuildSlots,
} from '@stim-cli/core/state';
import { admissionLimits } from '../workspace/config.ts';
import {
  acquireSlot,
  listSlots,
  releaseSlot,
  slotUsage,
  tryAcquireSlot,
  SlotCapacityError,
  type AcquireSlotOptions,
  type SlotClass,
  type SlotHandle,
  type SlotInfo,
  type TryAcquireSlotOptions,
} from './slot-queue.ts';

export type BuildSlotInfo = SlotInfo;
export type BuildSlotHandle = SlotHandle;

export { SlotCapacityError as BuildSlotCapacityError };

interface AcquireBuildSlotOptions extends Omit<AcquireSlotOptions, 'waitingFor'> {
  waitingFor?: (info: BuildWaitingFor | null) => void;
}

const BUILD_SLOTS: SlotClass = {
  resource: 'build',
  noun: 'build',
  doing: 'building',
  setting: 'concurrency.maxBuilds',
  dir: buildSlotsDir,
  readMax: () => admissionLimits().maxBuilds,
  tryAcquire: tryAcquireBuildSlot,
  requireAutomatic: () => requireAutomaticMachine('build', 'local'),
};

export function tryAcquireBuildSlot(options: TryAcquireSlotOptions): BuildSlotHandle | null {
  return tryAcquireSlot(tryAcquireBuildSlotClaim, options);
}

/**
 * Takes one of the `max` build slots in arrival order, `max` being the option when given and else the current
 * `concurrency.maxBuilds`; see `acquireSlot`. Builds queue under `$STIM_HOME/build-waits`.
 */
export function acquireBuildSlot({ waitingFor, ...options }: AcquireBuildSlotOptions): Promise<BuildSlotHandle> {
  return acquireSlot(BUILD_SLOTS, {
    ...options,
    waitingFor: waitingFor && ((info) => waitingFor(info && { kind: 'build-slot', ...info })),
  });
}

export function releaseBuildSlot(handle?: BuildSlotHandle | null, retain = false): boolean {
  return releaseSlot(BUILD_SLOTS, handle, retain);
}

export function listBuildSlots(): BuildSlotInfo[] {
  return listSlots(BUILD_SLOTS);
}

/** The `concurrency.maxBuilds` slots a new build could take, `0` to `max - 1`, and who holds each busy one. */
export function buildSlotUsage(max: number, slots: BuildSlotInfo[] = listBuildSlots()): StatusBuildSlots {
  return slotUsage(max, slots);
}
