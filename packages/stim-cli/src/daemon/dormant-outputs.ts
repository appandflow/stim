import { existsSync } from 'node:fs';
import { rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { StimContext } from '@stim-cli/core';
import type { DaemonLadderAction } from '@stim-cli/core/state';
import { workspaceOutputPaths } from '../commands/gc/workspaces.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from '../engine/workspace-process-lock.ts';
import { formatBytes, measuredDirectorySizeAsync } from '../fs-util.ts';
import { metroStoreRoot } from '../stimd/metro/metro-store.ts';
import { strandedReason, staleCargoTargetPaths, trimCargoTarget } from '../workspace/cargo-target.ts';
import type { Config } from '../workspace/config.ts';
import { discoveredReads, type DiscoveredReads } from '../workspace/discovered-reads.ts';
import { forgetGitReads } from '../workspace/git-reads.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { freshLaunchers, launcherReason, launchingOf, type Launching } from '../workspace/launchers.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { cargoTargetDirsAsync, existingBuildDirsAsync, regenerableDirProblem } from '../workspace/regenerable-dirs.ts';
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
  targets: { dir: string; stale: string[] }[];
  kept: string[];
}

/**
 * The dormant reduction's build-output step, for `candidates` read idle `afterMs` in this pass: each workspace with
 * regenerable build outputs, idle `afterMs` by the full evidence (Stim activity, source and git writes, processes and
 * agent sessions in the checkout) and not in a locked worktree, loses the outputs the eligibility check allows. Every
 * other output is measured first and removed under the workspace's native-run and metro-start claims after checking
 * again, one at a time; a Cargo `target/` is trimmed by profile through the Cargo trim. Report mode runs the same
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
  if (!workspaceOutputPaths(workspaceDir(path)).length && !(await existingBuildDirsAsync(path)).length) return null;
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
  if (!plan.paths.length && !plan.targets.length) return null;
  const measure = input.act || input.force === true;
  const lowPriority = input.force !== true;
  const sizes = new Map<string, number>();
  if (measure)
    for (const output of plan.paths)
      sizes.set(
        output,
        (await measuredDirectorySizeAsync(output, { timeoutMs: SIZE_TIMEOUT_MS, signal, lowPriority })) ?? 0,
      );
  if (!input.act) {
    let bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    if (measure)
      for (const { stale } of plan.targets)
        for (const gone of stale)
          bytes += (await measuredDirectorySizeAsync(gone, { timeoutMs: SIZE_TIMEOUT_MS, signal, lowPriority })) ?? 0;
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
    let reason: string | null;
    try {
      reason = await removeOutput(path, checkout, output, afterMs, operation);
    } catch (error) {
      failed(output, error);
      continue;
    }
    if (reason) kept.push(`kept ${output}: ${reason}`);
    else {
      removed.push(output);
      bytes += sizes.get(output) ?? 0;
    }
  }
  for (const { dir } of plan.targets) {
    let trim: Awaited<ReturnType<typeof trimTarget>>;
    try {
      trim = await trimTarget(path, checkout, dir, afterMs, operation, lowPriority);
    } catch (error) {
      failed(dir, error);
      continue;
    }
    if ('refused' in trim) {
      kept.push(`kept ${dir}: ${trim.refused}`);
      continue;
    }
    bytes += trim.bytes;
    if (trim.removed.length) removed.push(`${dir} (${trim.removed.join(', ')})`);
    if (trim.kept.length) kept.push(`kept in ${dir}: ${trim.kept.join('; ')}`);
    if (trim.deleteError) failures.push(`${dir}: moved aside; ${trim.deleteError}; the next pass deletes it`);
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
 * allow, with a Cargo `target/` split out and kept when a stranded trim blocks it or its profiles cannot be dated, and
 * left out when no profile in it went unwritten for `afterMs`.
 */
async function eligible(
  candidate: StageCandidate,
  config: Config,
  afterMs: number,
  launching: Launching,
): Promise<Plan> {
  const store = metroStoreRoot(candidate.path);
  const outputs = await idleOutputs(candidate.path, config, launching, (output) => output !== store);
  const plan: Plan = { paths: [], targets: [], kept: outputs.kept.filter((reason) => !reason.includes(store)) };
  for (const output of outputs.paths) {
    if (!outputs.targets.includes(output)) {
      plan.paths.push(output);
      continue;
    }
    const blocked = strandedReason(output);
    if (blocked) {
      plan.kept.push(`kept ${output}: ${blocked}`);
      continue;
    }
    const stale = staleCargoTargetPaths(output, Date.now(), afterMs);
    if ('refusal' in stale) plan.kept.push(`kept ${output}: ${stale.refusal}`);
    else if (stale.paths.length || existsSync(join(output, '.stim-trimmed')))
      plan.targets.push({ dir: output, stale: stale.paths.map((path) => join(output, path)) });
  }
  return plan;
}

/** Why `output` must stay, asked under the workspace's claims right before its removal; null when it may go. */
async function outputProblem(
  path: string,
  output: string,
  launching: Launching,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  if (basename(output) === 'target') return 'a Cargo target/ is only trimmed, never deleted whole';
  if (output === metroStoreRoot(path)) return 'the shared Metro store is not a dormant output';
  if (workspaceOutputPaths(workspaceDir(path)).includes(output)) return null;
  return regenerableDirProblem(path, output, signal, { launching });
}

/**
 * Removes one output under the workspace's native-run and metro-start claims after checking again that the workspace
 * is idle by the full evidence, its worktree is not locked, the output is still eligible and no launcher points into
 * the checkout. Returns why it stays, or null once it is gone.
 */
async function removeOutput(
  path: string,
  checkout: string,
  output: string,
  afterMs: number,
  operation: StimContext | undefined,
): Promise<string | null> {
  const signal = operation?.signal;
  const run = await withIdleWorkspace(
    path,
    async (): Promise<string | null> => {
      try {
        return await withWorkspaceProcessLock(
          workspaceDir(path),
          'metro-start',
          async (): Promise<string | null> => {
            if (!(await stillIdle(path, afterMs, { operation, full: true, setting: SETTING, checkout })))
              return 'it is no longer idle';
            const lock = await worktreeLockAsync(path, gitOptions(operation));
            if (lock) return lockReason(lock);
            const launching = launchingOf(checkout, freshLaunchers(operation, signal), operation, signal);
            const problem = await outputProblem(path, output, launching, signal);
            if (problem) return problem;
            const launcher = launcherReason(checkout, await launching.launchers());
            if (launcher) return launcher;
            await removeUnseen(output);
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
 * Removes `output` and puts its parent directory's modification time back, so the source-write scan that decides
 * idleness does not count Stim's own removal as activity of the checkout.
 */
async function removeUnseen(output: string): Promise<void> {
  const parent = dirname(output);
  const before = await stat(parent).catch(() => null);
  try {
    await rm(output, { recursive: true, force: true });
  } finally {
    if (before) await utimes(parent, before.atime, before.mtime).catch(() => {});
  }
}

/**
 * Trims a Cargo `target/` through the Cargo trim (its claim, its profile lock checks and its recovery data) after
 * checking again that the workspace is idle and its worktree not locked: every profile no build wrote for `afterMs`.
 */
async function trimTarget(
  path: string,
  checkout: string,
  target: string,
  afterMs: number,
  operation: StimContext | undefined,
  lowPriority: boolean,
): Promise<{ refused: string } | Awaited<ReturnType<typeof trimCargoTarget>>> {
  const signal = operation?.signal;
  forgetGitReads(operation);
  if (!(await stillIdle(path, afterMs, { operation, full: true, locked: false, setting: SETTING, checkout })))
    return { refused: 'it is no longer idle' };
  const lock = await worktreeLockAsync(path, gitOptions(operation));
  if (lock) return { refused: lockReason(lock) };
  if (!(await cargoTargetDirsAsync(path)).includes(target))
    return { refused: 'it is no longer a Cargo target/ Stim recognises' };
  const launching = launchingOf(checkout, freshLaunchers(operation, signal), operation, signal);
  const problem = await regenerableDirProblem(path, target, signal, { processes: false, launching });
  if (problem) return { refused: problem };
  return trimCargoTarget(target, { needBytes: 0, profileIdleMs: afterMs, signal, launching, lowPriority });
}
