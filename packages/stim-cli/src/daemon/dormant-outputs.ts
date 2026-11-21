import { existsSync } from 'node:fs';
import { rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { StimContext } from '@stim-cli/core';
import type { DaemonLadderAction } from '@stim-cli/core/state';
import { workspaceOutputPaths } from '../commands/gc/workspaces.ts';
import { RESERVE_RELEASED, releaseReserveWhenFull } from '../disk-reserve.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from '../engine/workspace-process-lock.ts';
import { addSize, formatSize, measureDirectoryAsync, type DirectorySize } from '../fs-util.ts';
import { metroStoreRoot } from '../stimd/metro/metro-store.ts';
import {
  deleteCargoTarget,
  leftoverReason,
  recentTargetUse,
  removablePaths,
  type CargoTrimResult,
} from '../workspace/cargo-target.ts';
import type { Config } from '../workspace/config.ts';
import { discoveredReads, type DiscoveredReads } from '../workspace/discovered-reads.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { workspaceDir } from '../workspace/paths.ts';
import {
  cargoTargetDirsAsync,
  existingBuildDirsAsync,
  isBuildDirPath,
  regenerableDirProblem,
} from '../workspace/regenerable-dirs.ts';
import { lockReason, worktreeLockAsync } from '../workspace/worktree.ts';
import { idleOutputs, type IdlePassInput } from './idle.ts';
import { sourceCheckoutIdle, stillIdle, type StageCandidate } from './stages.ts';

const SETTING = 'idle.dormantDays';
const PURPOSE = 'dormant reduction';
const SIZE_TIMEOUT_MS = 120_000;
const IN_USE_CHECKS = { devServer: false, hosted: false, hostedMacos: false };
const RESTORE = 'the next stim ios or stim android, from the build cache when nothing changed';

type Input = Pick<IdlePassInput, 'act' | 'log'> & {
  operation?: StimContext;
  force?: boolean;
  /** Runs before each size walk and each removal, outside the workspace's claims: a unit boundary of the disk owner. */
  between?: () => Promise<void>;
};
type Result = Pick<DaemonLadderAction, 'outcome' | 'bytes' | 'partial' | 'detail'>;

interface Plan {
  paths: string[];
  /** What the dormant delete would remove from each planned Cargo `target/`, for report mode's sizes. */
  removable: Map<string, string[]>;
  /** The planned paths that are Cargo `target/` directories, which go only through the Cargo delete. */
  targets: Set<string>;
  kept: string[];
  /** Whether a Cargo `target/` is among the outputs kept. */
  keptTarget: boolean;
}

/**
 * The dormant reduction's build-output step, for `candidates` read idle `afterMs` in this pass: each workspace with
 * regenerable build outputs, idle `afterMs` by the full evidence (Stim activity, source and git writes, processes and
 * agent sessions in the checkout) and not in a locked worktree, loses the outputs the eligibility check allows, each
 * measured first and removed under the workspace's native-run and metro-start claims after checking again, one at a
 * time; a recognised Cargo `target/` goes whole under its trim claim and the Cargo checks. Report mode runs the same
 * checks and acts on nothing. A workspace that fails is reported failed and the next one still runs.
 */
export async function reduceDormantOutputs(
  candidates: readonly StageCandidate[],
  config: Config,
  afterMs: number,
  input: Input,
): Promise<DaemonLadderAction[]> {
  const { operation } = input;
  const reads = discoveredReads(operation?.signal);
  const actions: DaemonLadderAction[] = [];
  for (const candidate of candidates) {
    let result: Result | null;
    try {
      result = await reduceWorkspace(candidate, config, afterMs, input, reads);
    } catch (error) {
      if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
      operation?.signal.throwIfAborted();
      result = { outcome: 'failed', bytes: 0, detail: error instanceof Error ? error.message : String(error) };
    }
    if (!result) continue;
    const restore = result.outcome === 'done' ? { restore: RESTORE } : {};
    actions.push({
      rung: 4,
      kind: 'delete-build-outputs',
      target: candidate.path,
      workspace: candidate.path,
      ...result,
      ...restore,
    });
    if (input.act)
      input.log(
        result.outcome === 'failed' ? 'warn' : 'info',
        'dormant_outputs',
        `dormant stage: ${result.outcome} ${candidate.path} (${formatSize(result)} freed): ${result.detail}`,
        {
          workspace: candidate.path,
          outcome: result.outcome,
          bytes: result.bytes,
          ...(result.partial ? { partial: true } : {}),
          ...restore,
        },
      );
  }
  return actions;
}

/** `path`, or its nearest ancestor that exists, whose volume is the one a write at `path` lands on. */
function nearestExisting(path: string): string {
  for (let at = path; ; at = dirname(at)) if (existsSync(at) || dirname(at) === at) return at;
}

async function reduceWorkspace(
  candidate: StageCandidate,
  config: Config,
  afterMs: number,
  input: Input,
  reads: DiscoveredReads,
): Promise<Result | null> {
  const { path } = candidate;
  const { operation } = input;
  const signal = operation?.signal;
  if (
    !workspaceOutputPaths(workspaceDir(path)).length &&
    !(await existingBuildDirsAsync(path)).length &&
    !(await cargoTargetDirsAsync(path)).length
  )
    return null;
  const keep = (detail: string): Result | null => (input.force ? { outcome: 'kept', bytes: 0, detail } : null);
  const { checkout } = candidate;
  if (typeof checkout !== 'string') return keep(`its checkout cannot be established: ${checkout.unknown}`);
  const lock = await worktreeLockAsync(path, gitOptions(operation));
  if (lock) return keep(lockReason(lock));
  const verdict = await sourceCheckoutIdle(path, afterMs, SETTING, { operation, reads, checkout });
  if ('kept' in verdict) return keep(verdict.kept);
  const plan = await eligible(candidate, config, afterMs);
  if (!plan.paths.length) return plan.keptTarget ? keep(plan.kept.join('; ')) : null;
  const measure = input.act || input.force === true;
  const sizeOf = async (dir: string) => {
    await input.between?.();
    return (await measureDirectoryAsync(dir, { timeoutMs: SIZE_TIMEOUT_MS, signal })) ?? { bytes: 0 };
  };
  const sizes = new Map<string, DirectorySize>();
  const freed: DirectorySize = { bytes: 0 };
  if (measure)
    for (const output of plan.paths) {
      if (!plan.targets.has(output)) sizes.set(output, await sizeOf(output));
      else if (!input.act)
        for (const removable of plan.removable.get(output) ?? []) sizes.set(removable, await sizeOf(removable));
    }
  if (!input.act) {
    for (const size of sizes.values()) addSize(freed, size);
    const detail = input.force ? 'stim gc would do this' : 'daemon.mode report acts on nothing';
    return { outcome: 'would', ...freed, detail: [detail, ...plan.kept].join('; ') };
  }
  const kept = [...plan.kept];
  const removed: string[] = [];
  const failures: string[] = [];
  const failed = (output: string, error: unknown) => {
    if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
    signal?.throwIfAborted();
    failures.push(`${output}: ${error instanceof Error ? error.message : String(error)}`);
  };
  // @ref LLP 0005#a-full-disk-releases-the-reserve -- the workspace claims are writes too
  let released = await releaseReserveWhenFull(nearestExisting(workspaceDir(path)));
  for (const output of plan.paths) {
    let outcome: string | CargoTrimResult | null;
    await input.between?.();
    try {
      outcome = await removeOutput(path, checkout, output, plan.targets.has(output), afterMs, operation);
    } catch (error) {
      failed(output, error);
      continue;
    }
    if (typeof outcome === 'string') kept.push(`kept ${output}: ${outcome}`);
    else if (outcome === null) {
      removed.push(output);
      addSize(freed, sizes.get(output));
    } else {
      addSize(freed, outcome);
      if (outcome.removed.length) removed.push(`${output} (${outcome.removed.join(', ')})`);
      if (outcome.kept.length) kept.push(`kept in ${output}: ${outcome.kept.join('; ')}`);
      released ||= outcome.reserveReleased === true;
    }
  }
  if (released) kept.push(RESERVE_RELEASED);
  const rest = kept.length ? `; ${kept.join('; ')}` : '';
  const done = removed.length ? `deleted ${formatSize(freed)} of regenerable build outputs; ` : '';
  if (failures.length)
    return { outcome: 'failed', ...freed, detail: `${done}could not delete ${failures.join('; ')}${rest}` };
  if (!removed.length) return { outcome: 'kept', bytes: 0, detail: kept.join('; ') || 'nothing was removed' };
  return { outcome: 'done', ...freed, detail: `deleted ${formatSize(freed)} of regenerable build outputs${rest}` };
}

function gitOptions(operation: StimContext | undefined) {
  return { env: operation?.env, signal: operation?.signal, declareFor: operation };
}

/**
 * The read-only eligibility check that report and acting mode share: each output the regenerable-directory checks
 * allow, among them every recognised Cargo `target/`, which stays while it shows use within `afterMs`
 * (`recentTargetUse`).
 */
async function eligible(candidate: StageCandidate, config: Config, afterMs: number): Promise<Plan> {
  const store = metroStoreRoot(candidate.path);
  const outputs = await idleOutputs(candidate.path, config, (output) => output !== store);
  const kept = outputs.kept.filter((reason) => !reason.includes(store));
  const plan: Plan = { paths: [], removable: new Map(), targets: new Set(), kept, keptTarget: false };
  const targets = [...outputs.targets];
  // @ref LLP 0005#the-dormant-reduction-deletes-an-idle-target-whole -- untagged too, never build output
  for (const dir of await cargoTargetDirsAsync(candidate.path)) {
    if (isBuildDirPath(dir)) continue;
    const problem = await regenerableDirProblem(candidate.path, dir, undefined);
    if (problem) {
      plan.kept.push(`kept ${dir}: ${problem}`);
      plan.keptTarget = true;
    } else targets.push(dir);
  }
  plan.keptTarget ||= kept.some((reason) => reason.startsWith(`kept ${join(candidate.path, 'target')}:`));
  for (const output of [...outputs.paths, ...targets.filter((dir) => !outputs.paths.includes(dir))]) {
    const target = targets.includes(output);
    const recent = target
      ? (leftoverReason(output) ??
        recentTargetUse(output, Date.now(), afterMs) ??
        (await nothingRemovable(output, plan)))
      : null;
    if (recent) {
      plan.kept.push(`kept ${output}: ${recent}`);
      plan.keptTarget = true;
    } else {
      plan.paths.push(output);
      if (target) plan.targets.add(output);
    }
  }
  return plan;
}

/** Why the dormant delete would remove nothing from the target `output`; null when it would, noting what in `plan`. */
async function nothingRemovable(output: string, plan: Plan): Promise<string | null> {
  const removable = await removablePaths(output);
  if ('kept' in removable) return removable.kept;
  if (!removable.paths.length) return 'it holds nothing the dormant delete removes';
  plan.removable.set(output, removable.paths);
  return null;
}

/** Why `output` must stay, asked under the workspace's claims right before its removal; null when it may go. */
async function outputProblem(
  path: string,
  output: string,
  cargo: boolean,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  if (output === metroStoreRoot(path)) return 'the shared Metro store is not a dormant output';
  if (cargo && !(await cargoTargetDirsAsync(path)).includes(output))
    return 'it is no longer a Cargo target/ Stim recognises';
  if (!cargo && basename(output) === 'target') return 'a Cargo target/ goes only through the Cargo delete';
  if (workspaceOutputPaths(workspaceDir(path)).includes(output)) return null;
  return regenerableDirProblem(path, output, signal);
}

/**
 * Removes one output under the workspace's native-run and metro-start claims after checking again that the workspace
 * is idle by the full evidence, its worktree is not locked and the output is still eligible; a Cargo `target/`
 * (`cargo`, from the plan) goes through `deleteCargoTarget`. Returns why it stays, the Cargo delete's result, or null
 * once it is gone.
 */
async function removeOutput(
  path: string,
  checkout: string,
  output: string,
  cargo: boolean,
  afterMs: number,
  operation: StimContext | undefined,
): Promise<string | CargoTrimResult | null> {
  const signal = operation?.signal;
  const run = await withIdleWorkspace(
    path,
    async (): Promise<string | CargoTrimResult | null> => {
      try {
        return await withWorkspaceProcessLock(
          workspaceDir(path),
          'metro-start',
          async (): Promise<string | CargoTrimResult | null> => {
            if (!(await stillIdle(path, afterMs, { operation, full: true, setting: SETTING, checkout })))
              return 'it is no longer idle';
            const lock = await worktreeLockAsync(path, gitOptions(operation));
            if (lock) return lockReason(lock);
            const problem = await outputProblem(path, output, cargo, signal);
            if (problem) return problem;
            if (cargo) return unseen(output, () => deleteCargoTarget(output, { idleMs: afterMs, signal }));
            await unseen(output, () => rm(output, { recursive: true, force: true }));
            return null;
          },
          { external: true, waitMs: 0, ownerPurpose: PURPOSE, signal, declareSpawnsFor: operation },
        );
      } catch (error) {
        if (workspaceProcessLockError(error)) return 'a stim start holds its metro-start lock';
        throw error;
      }
    },
    { purpose: PURPOSE, ...IN_USE_CHECKS, operation },
  );
  return run.ran ? run.value : `in use: ${run.reasons.join('; ')}`;
}

/**
 * Runs `remove` on `output` and puts its parent directory's modification time back, so the source-write scan that
 * decides idleness does not count Stim's own removal as activity of the checkout.
 */
async function unseen<T>(output: string, remove: () => Promise<T>): Promise<T> {
  const parent = dirname(output);
  const before = await stat(parent).catch(() => null);
  try {
    return await remove();
  } finally {
    if (before) await utimes(parent, before.atime, before.mtime).catch(() => {});
  }
}
