import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { StimContext } from '@stim-cli/core';
import type { DaemonLadderAction } from '@stim-cli/core/state';
import { getProject } from '../workspace/config.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { formatBytes } from '../fs-util.ts';
import {
  artifactWorktreesAsync,
  artifactWorktreesFor,
  clearArtifact,
  collectArtifactsAsync,
  type ArtifactCandidate,
  type ArtifactWorktree,
} from '../stimd/passes/artifacts.ts';
import { maintenancePinnedReader } from '../stimd/passes/protect.ts';
import { knownPrivateBytes, refreshMeasure, trustedMeasure } from '../disk-usage.ts';
import { workspaceKeys } from '../workspace/lightened.ts';
import { ARTIFACT_DIRS, existingDirsOf } from '../workspace/regenerable-dirs.ts';
import { writeWorkspaceEvent, type IdlePassInput } from './idle.ts';
import { dormantAfterMs, idleStageCandidates, stillIdle, type DeviceReading, type StageCandidate } from './stages.ts';

/**
 * The private bytes above which deleting a node_modules or Pods tree is worth a `stim worktree warm` or reinstall.
 * A copy-on-write clone from `worktree warm` shares nearly all its blocks; a reinstalled React Native tree holds 1 to 2
 * GB of its own. 256 MB is about 1% of the 20 GB critical free-disk floor (`disk.criticalFreeGb`).
 */
export const REAL_BYTES_THRESHOLD: number = 256 * 1024 ** 2;
const HOUR_MS = 60 * 60_000;
const WALK_TIMEOUT_MS = 10 * 60_000;
const RESTORE = 'stim worktree warm';
const UNKNOWN_KEPT = 'its real size is not measured yet, or the volume cannot tell, so it stays';
const VERBS: Record<DaemonLadderAction['outcome'], string> = {
  would: 'would delete',
  done: 'deleted',
  kept: 'kept',
  failed: 'failed to delete',
};

export interface RankedDependency {
  candidate: ArtifactCandidate;
  workspace: string;
  bytes: number | null;
  /** What deleting it would free, from a measurement whose install signature still matches; null when unknown. */
  privateBytes: number | null;
}

type Measured = RankedDependency & { privateBytes: number };

function sharedDetail({ bytes, privateBytes }: Measured): string {
  return `${formatBytes(privateBytes)} of its ${bytes === null ? 'size' : formatBytes(bytes)} is its own and the rest is shared with copy-on-write clones or hard links, under the ${formatBytes(REAL_BYTES_THRESHOLD)} worth deleting`;
}

/**
 * Which dependency trees to delete, given in the order their workspaces went idle: those whose private bytes reach
 * REAL_BYTES_THRESHOLD, most private bytes first; trees below it are kept. A tree of unknown size is taken after the
 * measured ones in the given order (`unknown: 'take'`) or kept (`'keep'`).
 */
export function selectDependencies(
  ranked: readonly RankedDependency[],
  unknown: 'take' | 'keep',
): { take: RankedDependency[]; kept: { dependency: RankedDependency; detail: string }[] } {
  const known = ranked.filter((dependency): dependency is Measured => dependency.privateBytes !== null);
  const unmeasured = ranked.filter((dependency) => dependency.privateBytes === null);
  const take: RankedDependency[] = known
    .filter((dependency) => dependency.privateBytes >= REAL_BYTES_THRESHOLD)
    .toSorted((a, b) => b.privateBytes - a.privateBytes);
  const kept: { dependency: RankedDependency; detail: string }[] = known
    .filter((dependency) => dependency.privateBytes < REAL_BYTES_THRESHOLD)
    .map((dependency) => ({ dependency, detail: sharedDetail(dependency) }));
  if (unknown === 'take') take.push(...unmeasured);
  else kept.push(...unmeasured.map((dependency) => ({ dependency, detail: UNKNOWN_KEPT })));
  return { take, kept };
}

function canonicalOrNull(path: string): string | null {
  try {
    return canonicalPath(path);
  } catch {
    return null;
  }
}

/**
 * The node_modules and Pods of linked worktrees whose workspace is among `idle`, in `idle`'s order, with their cached
 * sizes. `protectedRoot` is the command's own workspace, which none is taken from.
 */
export async function rankDependencies(
  idle: readonly StageCandidate[],
  protectedRoot: string,
  operation?: StimContext,
): Promise<RankedDependency[]> {
  const rank = new Map(
    idle.flatMap((candidate, index) => {
      const key = canonicalOrNull(candidate.path);
      return key ? [[key, index] as const] : [];
    }),
  );
  if (!rank.size) return [];
  const found = await collectArtifactsAsync(
    'dependencies',
    { now: Date.now(), windowMs: 0, protectedRoot, pinned: maintenancePinnedReader(operation) },
    operation?.signal ?? new AbortController().signal,
    operation,
  );
  return found.candidates
    .flatMap((candidate) => {
      const workspace =
        workspaceKeys(candidate.keys).find((key) => rank.has(canonicalOrNull(key) ?? '')) ??
        (candidate.keys.every((key) => !getProject(key)) && rank.has(canonicalOrNull(candidate.worktree) ?? '')
          ? candidate.worktree
          : undefined);
      if (!workspace) return [];
      const dependency: RankedDependency = {
        candidate,
        workspace,
        bytes: trustedMeasure(candidate.path)?.bytes ?? null,
        privateBytes: knownPrivateBytes(candidate.path),
      };
      return [{ dependency, order: rank.get(canonicalOrNull(workspace) ?? '') ?? 0 }];
    })
    .toSorted((a, b) => a.order - b.order)
    .map(({ dependency }) => dependency);
}

/**
 * Deletes one dependency tree under its workspace's claim once the workspace is still idle `idleMs`, recording the
 * restore. `requireRestorable` keeps a tree `stim worktree warm` could not put back with the same versions.
 */
export async function clearDependency(
  dependency: RankedDependency,
  idleMs: number,
  protectedRoot: string,
  worktrees: readonly ArtifactWorktree[],
  reason: string,
  operation?: StimContext,
  requireRestorable = true,
): Promise<{ status: 'done' | 'kept' | 'failed'; bytes: number; detail: string }> {
  try {
    return await clearArtifact(
      {
        kind: 'would-delete-dependencies',
        target: dependency.candidate.path,
        bytes: dependency.privateBytes ?? 0,
        reason,
        workspace: dependency.workspace,
      },
      'dependencies',
      {
        windowMs: 0,
        protectedRoot,
        pinned: maintenancePinnedReader(operation),
        worktrees,
        requireRestorable,
        recheck: async (key) => ((await stillIdle(key, idleMs, operation)) ? null : 'it is no longer idle'),
        operation,
      },
    );
  } catch (error) {
    if (isClaimUnavailable(error)) throw error;
    operation?.signal.throwIfAborted();
    return { status: 'failed', bytes: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

let dormantCheckedAt = -Infinity;

/**
 * The dormant stage's dependency step, at most hourly unless `force`: the node_modules and Pods of linked worktrees
 * idle `idle.dormantDays` whose private bytes reach REAL_BYTES_THRESHOLD or are not measured yet, most first, each
 * recorded so the next Stim command restores it. A tree is taken even when `stim worktree warm` could not put the
 * same versions back, since a reinstall does; copy-on-write clones below the threshold stay.
 */
export async function runDormantDependencies(
  input: Pick<IdlePassInput, 'config' | 'act' | 'log'> & DeviceReading & { force?: boolean },
): Promise<DaemonLadderAction[]> {
  const { config } = input;
  const afterMs = dormantAfterMs(config);
  if (!config || afterMs <= 0 || (!input.force && Date.now() - dormantCheckedAt < HOUR_MS)) return [];
  dormantCheckedAt = Date.now();
  const idle = await idleStageCandidates(config, input, afterMs);
  if (!idle.length) return [];
  const { operation } = input;
  const { take } = selectDependencies(await rankDependencies(idle, input.protectedRoot ?? '', operation), 'take');
  const worktrees = take.length ? await artifactWorktreesFor(operation) : [];
  const why = `idle.dormantDays is ${afterMs / (24 * HOUR_MS)}`;
  const actions: DaemonLadderAction[] = [];
  for (const dependency of take) {
    const target = dependency.candidate.path;
    const reason =
      dependency.privateBytes === null
        ? `${why}; its real size is unknown`
        : `${why}; ${formatBytes(dependency.privateBytes)} of it is its own`;
    const result: { status: DaemonLadderAction['outcome']; bytes: number; detail: string } = input.act
      ? await clearDependency(dependency, afterMs, input.protectedRoot ?? '', worktrees, reason, operation, false)
      : {
          status: 'would',
          bytes: dependency.privateBytes ?? 0,
          detail: input.force ? 'stim gc would do this' : 'daemon.mode report acts on nothing',
        };
    const restore = result.status === 'done' ? { restore: RESTORE } : {};
    actions.push({
      rung: 4,
      kind: 'delete-dependencies',
      target,
      workspace: dependency.workspace,
      outcome: result.status,
      bytes: result.bytes,
      detail: result.detail,
      ...restore,
    });
    const level = result.status === 'failed' ? 'warn' : 'info';
    const msg = `dormant stage: ${VERBS[result.status]} ${target} (${formatBytes(result.bytes)} freed): ${result.detail}; ${reason}${result.status === 'done' ? `; restore with ${RESTORE}` : ''}`;
    const fields = { target, outcome: result.status, bytes: result.bytes, reason, ...restore };
    input.log(level, 'dormant_dependencies', msg, { ...fields, workspace: dependency.workspace });
    if (result.status === 'done' || result.status === 'failed')
      try {
        writeWorkspaceEvent(dependency.workspace, level, 'dormant_dependencies', msg, fields);
      } catch {}
  }
  return actions;
}

async function dependencyTrees(operation: StimContext): Promise<string[]> {
  const trees = new Set<string>();
  for (const worktree of await artifactWorktreesAsync(operation.signal, operation)) {
    if (!worktree.linked) continue;
    for (const base of new Set([worktree.path, ...worktree.keys]))
      for (const path of existingDirsOf(base, ARTIFACT_DIRS.dependencies)) trees.add(path);
  }
  return [...trees];
}

export async function measureDependencyTrees(operation: StimContext): Promise<void> {
  for (const path of await dependencyTrees(operation)) {
    const { outcome } = await refreshMeasure(path, { timeoutMs: WALK_TIMEOUT_MS, claim: true, operation });
    if (outcome === 'busy') return;
  }
}
