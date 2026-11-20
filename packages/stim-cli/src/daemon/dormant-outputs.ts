import { rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { StimContext } from '@stim-cli/core';
import type { DaemonLadderAction } from '@stim-cli/core/state';
import { workspaceOutputPaths } from '../commands/gc/workspaces.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from '../engine/workspace-process-lock.ts';
import { formatBytes, measuredDirectorySizeAsync } from '../fs-util.ts';
import { metroStoreRoot } from '../stimd/metro/metro-store.ts';
import {
  deleteCargoTarget,
  recentTargetUse,
  removableEntries,
  type CargoTrimResult,
} from '../workspace/cargo-target.ts';
import type { Config } from '../workspace/config.ts';
import { discoveredReads, type DiscoveredReads } from '../workspace/discovered-reads.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { freshLaunchers, launcherReason, launchingOf, type Launching } from '../workspace/launchers.ts';
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

type Input = Pick<IdlePassInput, 'act' | 'log'> & { operation?: StimContext; force?: boolean };
type Result = Pick<DaemonLadderAction, 'outcome' | 'bytes' | 'detail'>;

interface Plan {
  paths: string[];
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
  const reads = discoveredReads(operation?.signal, operation);
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
        `dormant stage: ${result.outcome} ${candidate.path} (${formatBytes(result.bytes)} freed): ${result.detail}`,
        { workspace: candidate.path, outcome: result.outcome, bytes: result.bytes, ...restore },
      );
  }
  return actions;
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
    !(await cargoTargetDirsAsync(path, { staged: true })).length
  )
    return null;
  const keep = (detail: string): Result | null => (input.force ? { outcome: 'kept', bytes: 0, detail } : null);
  const { checkout } = candidate;
  if (typeof checkout !== 'string') return keep(`its checkout cannot be established: ${checkout.unknown}`);
  const lock = await worktreeLockAsync(path, gitOptions(operation));
  if (lock) return keep(lockReason(lock));
  const verdict = await sourceCheckoutIdle(path, afterMs, SETTING, { operation, reads, reduceOnly: false, checkout });
  if ('kept' in verdict) return keep(verdict.kept);
  const plan = await eligible(
    candidate,
    config,
    afterMs,
    launchingOf(checkout, () => reads.launchers(false), operation, signal),
  );
  if (!plan.paths.length) return plan.keptTarget ? keep(plan.kept.join('; ')) : null;
  const measure = input.act || input.force === true;
  const sizeOf = async (dir: string) =>
    (await measuredDirectorySizeAsync(dir, { timeoutMs: SIZE_TIMEOUT_MS, signal })) ?? 0;
  const sizes = new Map<string, number>();
  if (measure)
    for (const output of plan.paths) {
      if (!plan.targets.has(output)) sizes.set(output, await sizeOf(output));
      else if (!input.act)
        for (const name of (await removableEntries(output)) ?? [])
          sizes.set(join(output, name), await sizeOf(join(output, name)));
    }
  if (!input.act) {
    const bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    const detail = input.force ? 'stim gc would do this' : 'daemon.mode report acts on nothing';
    return { outcome: 'would', bytes, detail: [detail, ...plan.kept].join('; ') };
  }
  const kept = [...plan.kept];
  const removed: string[] = [];
  let bytes = 0;
  const failures: string[] = [];
  const failed = (output: string, error: unknown) => {
    if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
    signal?.throwIfAborted();
    failures.push(`${output}: ${error instanceof Error ? error.message : String(error)}`);
  };
  for (const output of plan.paths) {
    let outcome: string | CargoTrimResult | null;
    try {
      outcome = await removeOutput(path, checkout, output, plan.targets.has(output), afterMs, operation);
    } catch (error) {
      failed(output, error);
      continue;
    }
    if (typeof outcome === 'string') kept.push(`kept ${output}: ${outcome}`);
    else if (outcome === null) {
      removed.push(output);
      bytes += sizes.get(output) ?? 0;
    } else {
      bytes += outcome.bytes;
      if (outcome.removed.length) removed.push(`${output} (${outcome.removed.join(', ')})`);
      if (outcome.kept.length) kept.push(`kept in ${output}: ${outcome.kept.join('; ')}`);
      if (outcome.deleteError) failures.push(`${output}: ${outcome.deleteError}`);
    }
  }
  const rest = kept.length ? `; ${kept.join('; ')}` : '';
  const done = removed.length ? `deleted ${formatBytes(bytes)} of regenerable build outputs; ` : '';
  if (failures.length)
    return { outcome: 'failed', bytes, detail: `${done}could not delete ${failures.join('; ')}${rest}` };
  if (!removed.length) return { outcome: 'kept', bytes: 0, detail: kept.join('; ') || 'nothing was removed' };
  return { outcome: 'done', bytes, detail: `deleted ${formatBytes(bytes)} of regenerable build outputs${rest}` };
}

function gitOptions(operation: StimContext | undefined) {
  return { env: operation?.env, signal: operation?.signal, declareFor: operation };
}

/**
 * The read-only eligibility check that report and acting mode share: each output the regenerable-directory checks
 * allow, among them every recognised Cargo `target/`, which stays while it shows use within `afterMs`
 * (`recentTargetUse`).
 */
async function eligible(
  candidate: StageCandidate,
  config: Config,
  afterMs: number,
  launching: Launching,
): Promise<Plan> {
  const store = metroStoreRoot(candidate.path);
  const outputs = await idleOutputs(candidate.path, config, launching, (output) => output !== store);
  const kept = outputs.kept.filter((reason) => !reason.includes(store));
  const plan: Plan = { paths: [], targets: new Set(), kept, keptTarget: false };
  const targets = [...outputs.targets];
  // @ref LLP 0005#the-dormant-reduction-deletes-an-idle-target-whole -- untagged too, never build output
  for (const dir of await cargoTargetDirsAsync(candidate.path, { staged: true })) {
    if (isBuildDirPath(dir)) continue;
    const problem = await regenerableDirProblem(candidate.path, dir, undefined, { launching });
    if (problem) {
      plan.kept.push(`kept ${dir}: ${problem}`);
      plan.keptTarget = true;
    } else targets.push(dir);
  }
  plan.keptTarget ||= kept.some((reason) => reason.startsWith(`kept ${join(candidate.path, 'target')}:`));
  for (const output of [...outputs.paths, ...targets.filter((dir) => !outputs.paths.includes(dir))]) {
    const target = targets.includes(output);
    const recent = target
      ? (recentTargetUse(output, Date.now(), afterMs) ??
        ((await removableEntries(output))?.length ? null : 'it holds nothing the dormant delete removes'))
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

/** Why `output` must stay, asked under the workspace's claims right before its removal; null when it may go. */
async function outputProblem(
  path: string,
  output: string,
  cargo: boolean,
  launching: Launching,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  if (output === metroStoreRoot(path)) return 'the shared Metro store is not a dormant output';
  if (cargo && !(await cargoTargetDirsAsync(path, { staged: true })).includes(output))
    return 'it is no longer a Cargo target/ Stim recognises';
  if (!cargo && basename(output) === 'target') return 'a Cargo target/ goes only through the Cargo delete';
  if (workspaceOutputPaths(workspaceDir(path)).includes(output)) return null;
  return regenerableDirProblem(path, output, signal, { launching });
}

/**
 * Removes one output under the workspace's native-run and metro-start claims after checking again that the workspace
 * is idle by the full evidence, its worktree is not locked, the output is still eligible and no launcher points into
 * the checkout; a Cargo `target/` (`cargo`, from the plan) goes through `deleteCargoTarget`. Returns why it stays, the
 * Cargo delete's result, or null once it is gone.
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
            const launching = launchingOf(checkout, freshLaunchers(operation, signal), operation, signal);
            const problem = await outputProblem(path, output, cargo, launching, signal);
            if (problem) return problem;
            const launcher = launcherReason(checkout, await launching.launchers());
            if (launcher) return launcher;
            if (cargo) return unseen(output, () => deleteCargoTarget(output, { idleMs: afterMs, launching, signal }));
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
