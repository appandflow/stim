import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { StimContext } from '@stim-cli/core';
import type { DaemonLadderAction, PressureLevel } from '@stim-cli/core/state';
import { getProject } from '../workspace/config.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { formatBytes } from '../fs-util.ts';
import {
  artifactWorktreesAsync,
  artifactWorktreesFor,
  clearArtifact,
  clearSourceTrees,
  collectArtifactsAsync,
  type ArtifactCandidate,
  type ArtifactWorktree,
} from '../stimd/passes/artifacts.ts';
import { maintenancePinnedReader } from '../stimd/passes/protect.ts';
import { knownPrivateBytes, refreshMeasure, trustedMeasure } from '../disk-usage.ts';
import { workspaceKeys } from '../workspace/lightened.ts';
import { checkDependencyEdits } from '../workspace/dependency-edits.ts';
import { ARTIFACT_DIRS, existingDirsOf } from '../workspace/regenerable-dirs.ts';
import { writeWorkspaceEvent, type IdlePassInput } from './idle.ts';
import {
  dormantAfterMs,
  idleStageCandidates,
  sourceCheckoutIdle,
  sourceDormantAfterMs,
  stillIdle,
  type DeviceReading,
  type StageCandidate,
} from './stages.ts';
import { sourceDependenciesDue } from '../policy/checkout-order.ts';
import { warmedFromAt } from '../workspace/source-dependencies.ts';
import type { Config } from '../workspace/config.ts';

/**
 * The private bytes above which deleting a node_modules or Pods tree is worth a `stim worktree warm` or reinstall.
 * A copy-on-write clone from `worktree warm` shares nearly all its blocks; a reinstalled React Native tree holds 1 to 2
 * GB of its own. 256 MB is about 1% of the 20 GB critical free-disk floor (`disk.criticalFreeGb`).
 */
export const REAL_BYTES_THRESHOLD: number = 256 * 1024 ** 2;
const HOUR_MS = 60 * 60_000;
const WALK_TIMEOUT_MS = 10 * 60_000;
const RESTORE = 'stim worktree warm';
export const SOURCE_RESTORE = "the project's own install in it, or stim worktree warm --refresh in a linked worktree";
const UNKNOWN_KEPT = 'its real size is not measured yet, or the volume cannot tell, so it stays';
const VERBS: Record<DaemonLadderAction['outcome'], string> = {
  would: 'would delete',
  done: 'deleted',
  kept: 'kept',
  failed: 'failed to delete',
};

export interface RankedDependency {
  candidate: ArtifactCandidate;
  /** Whether it is in a source checkout, which no worktree warm restores. */
  source: boolean;
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
 * The node_modules and Pods of linked worktrees, or with `source` of source checkouts, whose workspace is among `idle`,
 * in `idle`'s order, with their cached sizes. `protectedRoot` is the command's own workspace, which none is taken from.
 */
export async function rankDependencies(
  idle: readonly StageCandidate[],
  protectedRoot: string,
  operation?: StimContext,
  source = false,
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
    { now: Date.now(), windowMs: 0, protectedRoot, pinned: maintenancePinnedReader(operation), source },
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
        source,
        workspace,
        bytes: trustedMeasure(candidate.path)?.bytes ?? null,
        privateBytes: knownPrivateBytes(candidate.path),
      };
      return [{ dependency, order: rank.get(canonicalOrNull(workspace) ?? '') ?? 0 }];
    })
    .toSorted((a, b) => a.order - b.order)
    .map(({ dependency }) => dependency);
}

export interface SourceRule {
  level: 'normal' | 'critical';
  /** `idle.sourceDormantDays` in milliseconds; 0 never. */
  dormantMs: number;
  criticalIdleMs: number;
  /** The idle time the workspaces in `idle` were selected by. */
  thresholdMs: number;
  setting: string;
}

/**
 * The node_modules and Pods of source checkouts that are due under `rule`, in `idle`'s order, and each other one with
 * why it stays. Every Stim workspace in the checkout must be in `idle`, and the checkout itself must be idle by the full
 * evidence (Stim activity, source file writes, git writes, the last commit); a worktree warm that copied from it
 * counts as activity.
 */
export async function rankSourceDependencies(
  idle: readonly StageCandidate[],
  keeps: ReadonlyMap<string, string>,
  protectedRoot: string,
  rule: SourceRule,
  operation?: StimContext,
): Promise<{ ranked: RankedDependency[]; kept: { target: string; workspace?: string; reason: string }[] }> {
  const rank = new Map(
    idle.flatMap((candidate, index) => {
      const key = canonicalOrNull(candidate.path);
      return key ? [[key, index] as const] : [];
    }),
  );
  const found = await collectArtifactsAsync(
    'dependencies',
    { now: Date.now(), windowMs: 0, protectedRoot, pinned: maintenancePinnedReader(operation), source: true },
    operation?.signal ?? new AbortController().signal,
    operation,
  );
  const kept: { target: string; workspace?: string; reason: string }[] = found.skips.map(({ target, reason }) => ({
    target,
    reason,
  }));
  const ranked: { dependency: RankedDependency; order: number }[] = [];
  for (const candidate of found.candidates) {
    const keys = workspaceKeys(candidate.keys);
    const workspace = keys[0] ?? candidate.worktree;
    const notIdle = [...keys, ...(keys.length ? [] : [candidate.worktree])].find(
      (key) => !rank.has(canonicalOrNull(key) ?? ''),
    );
    if (notIdle !== undefined) {
      kept.push({
        target: candidate.path,
        workspace,
        reason: `${notIdle} is not idle: ${keeps.get(canonicalOrNull(notIdle) ?? '') ?? 'it has recent activity'}`,
      });
      continue;
    }
    const verdict = await sourceCheckoutIdle(candidate.worktree, rule.thresholdMs, rule.setting, operation);
    if ('kept' in verdict) {
      kept.push({ target: candidate.path, workspace, reason: verdict.kept });
      continue;
    }
    const warmed = warmedFromAt(candidate.keys);
    const sinceWarm = Number.isFinite(warmed) ? Date.now() - warmed : Infinity;
    const due = sourceDependenciesDue({
      level: rule.level,
      idleMs: Math.min(verdict.idleMs, sinceWarm),
      dormantMs: rule.dormantMs,
      criticalIdleMs: rule.criticalIdleMs,
    });
    if (!due) {
      kept.push({
        target: candidate.path,
        workspace,
        reason:
          sinceWarm < verdict.idleMs
            ? `a worktree warm copied from it ${Math.floor(sinceWarm / 60_000)} minutes ago`
            : `idle ${Math.floor(verdict.idleMs / 60_000)} minutes, under the threshold`,
      });
      continue;
    }
    ranked.push({
      order: rank.get(canonicalOrNull(workspace) ?? '') ?? 0,
      dependency: {
        candidate,
        source: true,
        workspace,
        bytes: trustedMeasure(candidate.path)?.bytes ?? null,
        privateBytes: knownPrivateBytes(candidate.path),
      },
    });
  }
  return { ranked: ranked.toSorted((a, b) => a.order - b.order).map(({ dependency }) => dependency), kept };
}

/**
 * Why a dependency tree's checkout is no longer idle `idleMs`, asked again under its first workspace's claim, or null.
 * A source checkout needs every one of its workspaces and the checkout itself idle by the full evidence, and no worktree
 * warm having copied from it within `idleMs`.
 */
async function stillUnused(
  source: boolean,
  keys: readonly string[],
  worktree: string,
  idleMs: number,
  operation?: StimContext,
  setting?: string,
): Promise<string | null> {
  const [first] = keys;
  if (!source)
    return first && !(await stillIdle(first, idleMs, operation, false, true, setting)) ? 'it is no longer idle' : null;
  const held = new Set(workspaceKeys(keys));
  for (const key of new Set([...held, worktree]))
    if (!(await stillIdle(key, idleMs, operation, true, held.has(key), setting))) return `${key} is no longer idle`;
  return Date.now() - warmedFromAt(keys) < idleMs ? 'a worktree warm copied from it since' : null;
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
  requireRestorable: boolean = true,
  level: PressureLevel = 'normal',
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
        recheck: (keys, worktree) => stillUnused(false, keys, worktree, idleMs, operation),
        level,
        operation,
      },
    );
  } catch (error) {
    if (isClaimUnavailable(error)) throw error;
    operation?.signal.throwIfAborted();
    return { status: 'failed', bytes: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

type TreeResult = { status: 'done' | 'kept' | 'failed'; bytes: number; detail: string };

/** Deletes each source checkout's selected trees as one unit, in `trees` order; the outcome of every tree. */
export async function clearSourceCheckouts(
  trees: readonly RankedDependency[],
  idleMs: number,
  protectedRoot: string,
  worktrees: readonly ArtifactWorktree[],
  operation: StimContext | undefined,
  setting: string,
  level: PressureLevel,
): Promise<Map<RankedDependency, TreeResult>> {
  const groups = new Map<string, RankedDependency[]>();
  for (const tree of trees) groups.set(tree.candidate.worktree, [...(groups.get(tree.candidate.worktree) ?? []), tree]);
  const results = new Map<RankedDependency, TreeResult>();
  for (const group of groups.values()) {
    const outcomes = await clearSourceDependencies(group, idleMs, protectedRoot, worktrees, level, operation, setting);
    group.forEach((tree, index) => {
      const outcome = outcomes[index];
      if (outcome) results.set(tree, outcome);
    });
  }
  return results;
}

/**
 * Deletes the trees of one source checkout as a unit, after one recheck under its claims that the checkout is still
 * unused for `idleMs`; the outcomes follow `dependencies`' order.
 */
export async function clearSourceDependencies(
  dependencies: readonly RankedDependency[],
  idleMs: number,
  protectedRoot: string,
  worktrees: readonly ArtifactWorktree[],
  level: PressureLevel,
  operation?: StimContext,
  setting?: string,
): Promise<TreeResult[]> {
  try {
    const results = await clearSourceTrees(
      dependencies.map(({ candidate }) => candidate.path),
      {
        protectedRoot,
        pinned: maintenancePinnedReader(operation),
        worktrees,
        recheck: (keys, worktree) => stillUnused(true, keys, worktree, idleMs, operation, setting),
        level,
        operation,
      },
    );
    return dependencies.map(
      ({ candidate }) =>
        results.get(candidate.path) ?? { status: 'kept' as const, bytes: 0, detail: 'it was not processed' },
    );
  } catch (error) {
    if (isClaimUnavailable(error)) throw error;
    operation?.signal.throwIfAborted();
    const detail = error instanceof Error ? error.message : String(error);
    return dependencies.map(() => ({ status: 'failed' as const, bytes: 0, detail }));
  }
}

/** A dry run's outcome for one dependency tree at `level`: kept when the edit check keeps it, else `would`. */
export async function wouldDelete(
  dependency: RankedDependency,
  level: PressureLevel,
  detail: string,
  operation?: StimContext,
  bytes: number = dependency.privateBytes ?? 0,
): Promise<{ status: 'would' | 'kept'; bytes: number; detail: string }> {
  const edits = await checkDependencyEdits(dependency.candidate.path, {
    level,
    worktree: dependency.candidate.worktree,
    readOnly: true,
    signal: operation?.signal,
  });
  if ('keep' in edits) return { status: 'kept', bytes: 0, detail: edits.keep };
  return { status: 'would', bytes, detail };
}

/**
 * The dormant stage's dependency step, at most hourly with a cadence clock: the node_modules and Pods of linked worktrees
 * idle `idle.dormantDays` whose private bytes reach REAL_BYTES_THRESHOLD or are not measured yet, most first, each
 * recorded so the next Stim command restores it. A tree is taken even when `stim worktree warm` could not put the
 * same versions back, since a reinstall does; copy-on-write clones below the threshold stay. Then, as the last
 * step, those of source checkouts idle `idle.sourceDormantDays`, each recorded in the source checkout's workspace.
 */
export async function runDormantDependencies(
  input: Pick<IdlePassInput, 'config' | 'act' | 'log'> & DeviceReading & { force?: boolean; cadence?: BigInt64Array },
): Promise<DaemonLadderAction[]> {
  const { config, cadence } = input;
  const afterMs = dormantAfterMs(config);
  const sourceMs = sourceDormantAfterMs(config);
  if (!config || (afterMs <= 0 && sourceMs <= 0)) return [];
  if (cadence) {
    // Zero means no check yet. Record the start before any awaited work so a failed pass still counts.
    const now = BigInt(Date.now()) + 1n;
    const checkedAt = Atomics.load(cadence, 0);
    if (!input.force && checkedAt !== 0n && now - checkedAt < BigInt(HOUR_MS)) return [];
    Atomics.store(cadence, 0, now);
  }
  const actions: DaemonLadderAction[] = [];
  if (afterMs > 0) actions.push(...(await takeIdleDependencies(input, config, afterMs, false)));
  if (sourceMs > 0) actions.push(...(await takeIdleDependencies(input, config, sourceMs, true)));
  return actions;
}

async function takeIdleDependencies(
  input: Pick<IdlePassInput, 'act' | 'log'> & DeviceReading & { force?: boolean },
  config: Config,
  afterMs: number,
  source: boolean,
): Promise<DaemonLadderAction[]> {
  const keeps = new Map<string, string>();
  const idle = (
    await idleStageCandidates(
      config,
      input,
      afterMs,
      source
        ? {
            full: true,
            setting: 'idle.sourceDormantDays',
            onKept: (path, reason) => keeps.set(canonicalOrNull(path) ?? path, reason),
          }
        : {},
    )
  ).filter((candidate) => source || candidate.role === 'linked');
  const { operation } = input;
  const actions: DaemonLadderAction[] = [];
  let take: RankedDependency[];
  if (source) {
    const { ranked, kept } = await rankSourceDependencies(
      idle,
      keeps,
      input.protectedRoot ?? '',
      {
        level: 'normal',
        dormantMs: afterMs,
        criticalIdleMs: Infinity,
        thresholdMs: afterMs,
        setting: 'idle.sourceDormantDays',
      },
      operation,
    );
    if (!input.act || input.force)
      for (const entry of kept)
        actions.push({
          rung: 4,
          kind: 'delete-dependencies',
          target: entry.target,
          ...(entry.workspace ? { workspace: entry.workspace } : {}),
          outcome: 'kept',
          bytes: 0,
          detail: entry.reason,
          setting: 'idle.sourceDormantDays',
        });
    const selected = selectDependencies(ranked, 'keep');
    take = selected.take;
    if (!input.act || input.force)
      for (const { dependency, detail } of selected.kept)
        actions.push({
          rung: 4,
          kind: 'delete-dependencies',
          target: dependency.candidate.path,
          workspace: dependency.workspace,
          outcome: 'kept',
          bytes: 0,
          detail,
          setting: 'idle.sourceDormantDays',
        });
  } else {
    if (!idle.length) return [];
    take = selectDependencies(await rankDependencies(idle, input.protectedRoot ?? '', operation), 'take').take;
  }
  const worktrees = take.length ? await artifactWorktreesFor(operation) : [];
  const why = `${source ? 'idle.sourceDormantDays' : 'idle.dormantDays'} is ${afterMs / (24 * HOUR_MS)}`;
  const sourceResults =
    source && input.act
      ? await clearSourceCheckouts(take, afterMs, input.protectedRoot ?? '', worktrees, operation, why, 'normal')
      : new Map<RankedDependency, TreeResult>();
  for (const dependency of take) {
    const target = dependency.candidate.path;
    const reason =
      dependency.privateBytes === null
        ? `${why}; its real size is unknown`
        : `${why}; ${formatBytes(dependency.privateBytes)} of it is its own`;
    const result: { status: DaemonLadderAction['outcome']; bytes: number; detail: string } = input.act
      ? source
        ? (sourceResults.get(dependency) ?? { status: 'kept', bytes: 0, detail: 'it was not processed' })
        : await clearDependency(dependency, afterMs, input.protectedRoot ?? '', worktrees, reason, operation, false)
      : await wouldDelete(
          dependency,
          'normal',
          input.force ? 'stim gc would do this' : 'daemon.mode report acts on nothing',
          operation,
        );
    const restoreWith = source ? SOURCE_RESTORE : RESTORE;
    const restore = result.status === 'done' ? { restore: restoreWith } : {};
    actions.push({
      rung: 4,
      kind: 'delete-dependencies',
      target,
      workspace: dependency.workspace,
      outcome: result.status,
      bytes: result.bytes,
      detail: result.detail,
      ...(source ? { setting: 'idle.sourceDormantDays' } : {}),
      ...restore,
    });
    const level = result.status === 'failed' ? 'warn' : 'info';
    const msg = `dormant stage: ${VERBS[result.status]} ${target} (${formatBytes(result.bytes)} freed): ${result.detail}; ${reason}${result.status === 'done' ? `; restore with ${restoreWith}` : ''}`;
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
