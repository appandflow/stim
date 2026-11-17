import { join } from 'node:path';
import {
  buildSlotsDir,
  buildWorkerRoot,
  tryAcquireBuildSlotClaim,
  requireAutomaticMachine,
  type BuildWaitingFor,
  type StatusBuildSlots,
} from '@stim-cli/core/state';
import {
  claimFilesRemoveCommand,
  claimProblemText,
  claimRemoveCommand,
  readClaimSet,
  type ClaimProblem,
} from '../ownership-claim.ts';
import { readBuildClaims } from '../engine-store/claims.ts';
import { engineRoot } from '../engine-store/store.ts';
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

/**
 * The `concurrency.maxBuilds` slots a new build could take, `0` to `max - 1`, and who holds each busy one, with the
 * claim and removal command of each unresolved one.
 */
export function buildSlotUsage(
  max: number,
  env: NodeJS.ProcessEnv,
  slots: BuildSlotInfo[] = listBuildSlots(),
): StatusBuildSlots {
  const usage = slotUsage(max, slots);
  const claims = new Map(unresolvedBuildSlotClaims(env, slots).map(({ slot, ...claim }) => [slot, claim]));
  for (const holder of usage.holders) {
    const claim = holder.unresolved ? claims.get(holder.slot) : undefined;
    if (claim) holder.claim = claim;
  }
  return usage;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const sameOwner = (a: ClaimProblem, b: ClaimProblem) =>
  Boolean(a.owner && b.owner && a.owner.pid === b.owner.pid && a.owner.processToken === b.owner.processToken);

/**
 * Each unresolved build slot: its claim, owner and the command that removes it. For a slot an offloaded build holds,
 * the command also removes the job's `fingerprint-work/<job>` directory and the job's repository and engine claims
 * that the same owner left unresolved, in the order of the `cleanup-unresolved` refusal.
 * @ref LLP 0007#a-null-child-is-never-recovered -- status, gc and maintenance name the claim, its owner and the command
 */
export function unresolvedBuildSlotClaims(
  env: NodeJS.ProcessEnv,
  slots: BuildSlotInfo[] = listBuildSlots(),
): { slot: number | null; unresolved: string; removeCommand: string }[] {
  return slots.flatMap(({ index, problem }) => {
    if (!problem) return [];
    const { offloaded, client, repo, job } = problem.details ?? {};
    if (
      offloaded !== true ||
      typeof client !== 'string' ||
      typeof repo !== 'string' ||
      typeof job !== 'string' ||
      ![client, repo, job].every((name) => NAME.test(name))
    )
      return [
        { slot: index, unresolved: claimProblemText(problem), removeCommand: claimFilesRemoveCommand(problem.path) },
      ];
    const area = join(buildWorkerRoot(), client, 'repos', repo);
    const repoClaims = readClaimSet(`${area}.claims`).unresolved.filter((other) => sameOwner(other, problem));
    const engineClaims = readBuildClaims(engineRoot(env)).flatMap(({ survey }) =>
      survey.unresolved.filter((other) => sameOwner(other, problem)),
    );
    const others = [
      ...repoClaims.map(({ path }) => `repository claim ${path}`),
      ...engineClaims.map(({ path }) => `engine claim ${path}`),
    ];
    return [
      {
        slot: index,
        unresolved: `the offloaded build ${job} of ${repo} for ${client}: ${claimProblemText(problem)}${
          others.length ? `; the same owner holds the ${others.join(' and the ')}` : ''
        }`,
        removeCommand: [
          claimRemoveCommand(join(area, 'fingerprint-work', job)),
          ...[...repoClaims, problem, ...engineClaims].map(({ path }) => claimFilesRemoveCommand(path)),
        ].join(' && '),
      },
    ];
  });
}
