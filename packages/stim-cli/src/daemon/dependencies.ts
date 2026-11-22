import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { StimContext } from '@stim-cli/core';
import {
  listBuildEndMarkers,
  readDiskUsageFailureSignature,
  readDiskUsagePartial,
  readDiskUsagePrivateUnknown,
  type DaemonLadderAction,
  type PressureLevel,
  type BuildEndMarker,
} from '@stim-cli/core/state';
import { getProject } from '../workspace/config.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { listedRoots } from '../commands/gc/worktrees.ts';
import { discoverCheckouts } from '../workspace/discovery.ts';
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
import { freshMeasure, knownPrivateBytes, refreshMeasure, trustedMeasure } from '../disk-usage.ts';
import { treeSignature } from '../private-size.ts';
import { hardLinkSample } from '../link-sample.ts';
import { workspaceKeys } from '../workspace/lightened.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { matchWorktreeEntry, resolveSourceCheckoutAsync } from '../workspace/worktree.ts';
import { answered, hungRead, Unanswered } from '../workspace/bounded-read.ts';
import { buildOutputDirs, dependencyTreeSignature } from '../workspace/discovery-census.ts';
import { ARTIFACT_DIRS } from '../workspace/regenerable-dirs.ts';
import { checkDependencyEdits } from '../workspace/dependency-edits.ts';
import { writeWorkspaceEvent, type IdlePassInput } from './idle.ts';
import { reduceDormantOutputs } from './dormant-outputs.ts';
import { markWriter, refreshCargoHolderMarks } from './marks.ts';
import { dependencyMarkObserver } from './dependency-marks.ts';
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
import { timedStep, type DaemonLog } from './step-timing.ts';
import { forgetGitReads } from '../workspace/git-reads.ts';

/**
 * The private bytes above which deleting a node_modules or Pods tree is worth a `stim worktree warm` or reinstall.
 * A copy-on-write clone from `worktree warm` shares nearly all its blocks; a reinstalled React Native tree holds 1 to 2
 * GB of its own. 256 MB is about 1% of the 20 GB critical free-disk floor (`disk.criticalFreeGb`).
 */
export const REAL_BYTES_THRESHOLD: number = 256 * 1024 ** 2;
const HOUR_MS = 60 * 60_000;
const WALK_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 3000;
const RESTORE = 'stim worktree warm';
export const SOURCE_RESTORE = "the project's own install in it, or stim worktree warm --refresh in a linked worktree";
const NOT_MEASURED = 'its real size is not measured since its last install, so it stays';
const VOLUME_CANNOT_TELL =
  'its volume cannot report which of its blocks other files share, so its real size is unknown and it stays';
const WALK_FAILED =
  'its private-size walk could not count which of its blocks other files share, so its real size is unknown and it stays';
const MEASURE_BUDGET_MS = 2 * 60_000;
const LINK_SAMPLES_MS = 10_000;
const MIN_WALK_MS = 10_000;
const WALK_BUSY =
  'another size walk on this machine was running, so stim gc did not measure it this run and its real size is unknown and it stays';
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
  /** Why `privateBytes` is null. */
  unknown?: string;
  /** Set when `privateBytes` is null and a sample of its files found mostly hard links. */
  links?: { linked: number; sampled: number };
}

type Measured = RankedDependency & { privateBytes: number };

function sharedDetail({ bytes, privateBytes }: Measured): string {
  return `${formatBytes(privateBytes)} of its ${bytes === null ? 'size' : formatBytes(bytes)} is its own and the rest is shared with copy-on-write clones or hard links, under the ${formatBytes(REAL_BYTES_THRESHOLD)} worth deleting`;
}

function linkedDetail({ linked, sampled }: { linked: number; sampled: number }): string {
  return `its real size is unknown, but ${linked} of the ${sampled} files sampled from it are hard links another folder such as a package store also holds, so deleting it would free little and it stays`;
}

/**
 * Which dependency trees to delete, given in the order their workspaces went idle: those whose private bytes reach
 * REAL_BYTES_THRESHOLD, most private bytes first; trees below it are kept. A tree of unknown size is taken after the
 * measured ones in the given order (`unknown: 'take'`) or kept (`'keep'`); one a sample found mostly hard links is kept.
 */
export function selectDependencies(
  ranked: readonly RankedDependency[],
  unknown: 'take' | 'keep',
): { take: RankedDependency[]; kept: { dependency: RankedDependency; detail: string }[] } {
  const known = ranked.filter((dependency): dependency is Measured => dependency.privateBytes !== null);
  const unmeasured = ranked.filter((dependency) => dependency.privateBytes === null && !dependency.links);
  const take: RankedDependency[] = known
    .filter((dependency) => dependency.privateBytes >= REAL_BYTES_THRESHOLD)
    .toSorted((a, b) => b.privateBytes - a.privateBytes);
  const kept: { dependency: RankedDependency; detail: string }[] = known
    .filter((dependency) => dependency.privateBytes < REAL_BYTES_THRESHOLD)
    .map((dependency) => ({ dependency, detail: sharedDetail(dependency) }));
  const linked = ranked.filter(
    (dependency): dependency is RankedDependency & Required<Pick<RankedDependency, 'links'>> =>
      dependency.privateBytes === null && dependency.links !== undefined,
  );
  if (unknown === 'take') take.push(...unmeasured);
  else kept.push(...unmeasured.map((dependency) => ({ dependency, detail: dependency.unknown ?? NOT_MEASURED })));
  kept.push(...linked.map((dependency) => ({ dependency, detail: linkedDetail(dependency.links) })));
  return { take, kept };
}

// @ref LLP 0001#a-tree-of-hard-links-stays -- only a tree with no measurement is sampled, after any walk
/**
 * Samples the link counts of each tree in `ranked` whose private size is still unknown, for at most LINK_SAMPLES_MS in
 * all; see `hardLinkSample`.
 */
export async function sampleLinks(ranked: readonly RankedDependency[], signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + LINK_SAMPLES_MS;
  for (const dependency of ranked) {
    if (dependency.privateBytes !== null) continue;
    if (Date.now() >= deadline) return;
    const links = await hardLinkSample(dependency.candidate.path, signal, undefined, deadline);
    if (links) dependency.links = links;
  }
}

export function rankedPrivateBytes(path: string): number | null {
  const privateBytes = knownPrivateBytes(path);
  return privateBytes !== null && privateBytes < REAL_BYTES_THRESHOLD && readDiskUsagePartial(path)
    ? null
    : privateBytes;
}

function triedBefore(dependency: RankedDependency): number {
  return readDiskUsageFailureSignature(dependency.candidate.path) === treeSignature(dependency.candidate.path) ? 1 : 0;
}

/**
 * Records why each tree in `ranked` has no private size. With `walk`, as in a `stim gc` pass, it first walks those whose
 * current install no walk tried to count yet, largest first and those whose last walk failed last, one at a time for at most MEASURE_BUDGET_MS in all.
 */
async function measureUnknown(
  ranked: readonly RankedDependency[],
  walk: boolean,
  operation?: StimContext,
): Promise<void> {
  const reason = (path: string): string | null => {
    const recorded = readDiskUsagePrivateUnknown(path);
    return recorded === 'walk' ? WALK_FAILED : recorded === 'volume' ? VOLUME_CANNOT_TELL : null;
  };
  const due: RankedDependency[] = [];
  for (const dependency of ranked.filter(({ privateBytes }) => privateBytes === null)) {
    const fresh = freshMeasure(dependency.candidate.path);
    const recorded = !fresh
      ? null
      : fresh.privateBytes !== undefined && readDiskUsagePartial(dependency.candidate.path)
        ? WALK_FAILED
        : reason(dependency.candidate.path);
    if (recorded) dependency.unknown = recorded;
    else if (walk) due.push(dependency);
  }
  const order = new Map(due.map((dependency) => [dependency, triedBefore(dependency)]));
  const deadline = Date.now() + MEASURE_BUDGET_MS;
  let busy = false;
  for (const dependency of due.toSorted(
    (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0) || (b.bytes ?? -1) - (a.bytes ?? -1),
  )) {
    if (busy) {
      dependency.unknown = WALK_BUSY;
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs < MIN_WALK_MS) {
      dependency.unknown = `stim gc spent its ${MEASURE_BUDGET_MS / 60_000} minutes of measuring on other trees first, so its real size is unknown and it stays`;
      continue;
    }
    const { outcome, measure, partial } = await refreshMeasure(dependency.candidate.path, {
      timeoutMs: remainingMs,
      operation,
      valid: (cached) => cached.privateBytes !== undefined,
      failures: true,
      claim: true,
    });
    if (outcome === 'busy') {
      busy = true;
      dependency.unknown = WALK_BUSY;
      continue;
    }
    if (measure?.privateBytes !== undefined && !(partial && measure.privateBytes < REAL_BYTES_THRESHOLD)) {
      dependency.bytes = measure.bytes;
      dependency.privateBytes = measure.privateBytes;
    } else
      dependency.unknown =
        measure?.privateBytes !== undefined
          ? WALK_FAILED
          : outcome === 'failed'
            ? `its size walk failed or did not finish within the ${Math.ceil(remainingMs / 1000)} seconds stim gc had left, so its real size is unknown and it stays`
            : outcome === 'fresh' && !measure
              ? 'its last size walk did not finish in time and its install has not changed since, so its real size is unknown and it stays'
              : (reason(dependency.candidate.path) ?? WALK_FAILED);
  }
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
  log?: DaemonLog,
  inventory?: Awaited<ReturnType<typeof collectArtifactsAsync>>,
): Promise<RankedDependency[]> {
  const rank = new Map(
    idle.flatMap((candidate, index) => {
      const key = canonicalOrNull(candidate.path);
      return key ? [[key, index] as const] : [];
    }),
  );
  if (!rank.size) return [];
  const found =
    inventory ??
    (await timedStep(
      log,
      'collect_artifacts',
      () =>
        collectArtifactsAsync(
          'dependencies',
          { now: Date.now(), windowMs: 0, protectedRoot, pinned: maintenancePinnedReader(operation), source },
          operation?.signal ?? new AbortController().signal,
          operation,
        ),
      { signal: operation?.signal, items: (result) => result && result.candidates.length + result.skips.length },
    ));
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
        privateBytes: rankedPrivateBytes(candidate.path),
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
  log?: DaemonLog,
  inventory?: Awaited<ReturnType<typeof collectArtifactsAsync>>,
): Promise<{ ranked: RankedDependency[]; kept: { target: string; workspace?: string; reason: string }[] }> {
  const rank = new Map(
    idle.flatMap((candidate, index) => {
      const key = canonicalOrNull(candidate.path);
      return key ? [[key, index] as const] : [];
    }),
  );
  const found =
    inventory ??
    (await timedStep(
      log,
      'collect_artifacts',
      () =>
        collectArtifactsAsync(
          'dependencies',
          { now: Date.now(), windowMs: 0, protectedRoot, pinned: maintenancePinnedReader(operation), source: true },
          operation?.signal ?? new AbortController().signal,
          operation,
        ),
      { signal: operation?.signal, items: (result) => result && result.candidates.length + result.skips.length },
    ));
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
    const verdict = await sourceCheckoutIdle(candidate.worktree, rule.thresholdMs, rule.setting, { operation });
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
        privateBytes: rankedPrivateBytes(candidate.path),
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
    return first && !(await stillIdle(first, idleMs, { operation, setting })) ? 'it is no longer idle' : null;
  const held = new Set(workspaceKeys(keys));
  for (const key of new Set([...held, worktree]))
    if (!(await stillIdle(key, idleMs, { operation, full: true, locked: held.has(key), setting })))
      return `${key} is no longer idle`;
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

/**
 * Deletes each source checkout's selected trees as one unit, in `trees` order, running `between` before each checkout;
 * the outcome of every tree.
 */
export async function clearSourceCheckouts(
  trees: readonly RankedDependency[],
  idleMs: number,
  protectedRoot: string,
  worktrees: readonly ArtifactWorktree[],
  operation: StimContext | undefined,
  setting: string,
  level: PressureLevel,
  between: () => Promise<void>,
): Promise<Map<RankedDependency, TreeResult>> {
  const groups = new Map<string, RankedDependency[]>();
  for (const tree of trees) groups.set(tree.candidate.worktree, [...(groups.get(tree.candidate.worktree) ?? []), tree]);
  const results = new Map<RankedDependency, TreeResult>();
  for (const group of groups.values()) {
    await between();
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
  forgetGitReads(operation);
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
 * The dormant stage's step, at most hourly with a cadence clock: first the regenerable build outputs of every
 * workspace idle `idle.dormantDays` (`reduceDormantOutputs`), then the node_modules and Pods of linked worktrees
 * idle `idle.dormantDays` whose private bytes reach REAL_BYTES_THRESHOLD or are not measured yet, most first, each
 * recorded so the next Stim command restores it. A tree is taken even when `stim worktree warm` could not put the
 * same versions back, since a reinstall does; copy-on-write clones below the threshold stay. Then, as the last
 * step, those of source checkouts idle `idle.sourceDormantDays`, each recorded in the source checkout's workspace.
 */
export async function runDormantDependencies(
  input: Pick<IdlePassInput, 'config' | 'act' | 'log'> &
    DeviceReading & {
      force?: boolean;
      cadence?: BigInt64Array;
      walkUnknown?: false;
      /** Runs between checkouts, phases and deletions: a unit boundary of the disk owner. */
      between?: () => Promise<void>;
      /** Writes the gc mark of each checkout the linked-worktree walk reads. */
      marks?: true;
    },
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
  return timedStep(
    input.log,
    'dormant_dependencies',
    async () => {
      const actions: DaemonLadderAction[] = [];
      if (afterMs > 0) actions.push(...(await takeIdleDependencies(input, config, afterMs, false)));
      if (sourceMs > 0) actions.push(...(await takeIdleDependencies(input, config, sourceMs, true)));
      return actions;
    },
    { signal: input.operation?.signal, items: (actions) => actions?.length },
  );
}

/**
 * Whether a discovered checkout holds a `node_modules` or `ios/Pods` the source collection could take. It is eligible
 * only as `collectArtifactsAsync` finds it: git lists a non-bare worktree for it, its source checkout resolves, and that
 * worktree is the source checkout; anything else, a linked worktree or a folder git does not list, is answered false
 * before any dependency read. A tree counts only as a real directory, never followed through a link (the collection
 * keeps a linked tree). Each probe is one `lstat` bounded by `answered`; 'unanswered' when its own probe does not
 * answer. While another read holds the pending slot no probe starts and the answer is true, so the checkout goes
 * through the idle checks and the collection as it would on main.
 */
async function sourceTreesOf(path: string, operation?: StimContext): Promise<boolean | 'unanswered'> {
  const { entries, ...source } = await resolveSourceCheckoutAsync(path, {
    env: operation?.env,
    signal: operation?.signal,
    declareFor: operation,
  });
  const entry = 'refusal' in source ? null : matchWorktreeEntry(entries, path);
  if (!entry || entry.bare || 'refusal' in source || entry.path !== source.path) return false;
  try {
    for (const dir of ARTIFACT_DIRS.dependencies) {
      if (hungRead() !== null) return true;
      const target = join(entry.path, dir);
      const found = await answered(
        target,
        () =>
          lstat(target).then(
            (info) => info.isDirectory(),
            () => false,
          ),
        PROBE_TIMEOUT_MS,
        operation?.signal,
      );
      if (found) return true;
    }
    return false;
  } catch (error) {
    if (error instanceof Unanswered) return 'unanswered';
    throw error;
  }
}

async function takeIdleDependencies(
  input: Pick<IdlePassInput, 'act' | 'log'> &
    DeviceReading & { force?: boolean; walkUnknown?: false; between?: () => Promise<void>; marks?: true },
  config: Config,
  afterMs: number,
  source: boolean,
): Promise<DaemonLadderAction[]> {
  const keeps = new Map<string, string>();
  const between = input.between ?? (async () => {});
  const discovered = input.marks ? await discoverCheckouts(config, listedRoots(), input.operation) : undefined;
  const candidates = await idleStageCandidates(
    config,
    input,
    afterMs,
    source
      ? {
          full: true,
          setting: 'idle.sourceDormantDays',
          onKept: (path, reason) => keeps.set(canonicalOrNull(path) ?? path, reason),
          reclaimable: async (path) => {
            const trees = await sourceTreesOf(path, input.operation);
            if (trees === 'unanswered')
              keeps.set(canonicalOrNull(path) ?? path, 'its node_modules or ios/Pods did not answer this pass');
            return trees === true;
          },
          between,
          ...(discovered ? { discovered } : {}),
        }
      : {
          between,
          ...(discovered ? { discovered } : {}),
          ...(input.marks ? { onRead: markWriter(config, input.operation?.signal, true) } : {}),
        },
  );
  await between();
  const { operation } = input;
  if (input.marks && !source) await refreshCargoHolderMarks(config, input, between, true, discovered);
  const actions: DaemonLadderAction[] = source
    ? []
    : await timedStep(input.log, 'dormant_outputs', () => reduceDormantOutputs(candidates, config, afterMs, input), {
        signal: operation?.signal,
        items: (taken) => taken?.length,
      });
  await between();
  const idle = candidates.filter((candidate) => source || candidate.role === 'linked');
  const inventory = input.marks
    ? await timedStep(
        input.log,
        'collect_artifacts',
        () =>
          collectArtifactsAsync(
            'dependencies',
            {
              now: Date.now(),
              windowMs: 0,
              protectedRoot: input.protectedRoot ?? '',
              pinned: maintenancePinnedReader(operation),
              source,
              discovered,
              onInventory: dependencyMarkObserver(config, input, between),
            },
            operation?.signal ?? new AbortController().signal,
            operation,
          ),
        { signal: operation?.signal, items: (found) => found && found.candidates.length + found.skips.length },
      )
    : undefined;
  let take: RankedDependency[];
  if (source) {
    const { ranked, kept } = await timedStep(
      input.log,
      'rank_source_dependencies',
      () =>
        rankSourceDependencies(
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
          input.log,
          inventory,
        ),
      { signal: operation?.signal, items: (found) => (found ? found.ranked.length + found.kept.length : undefined) },
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
    if (!input.act || input.force)
      await measureUnknown(ranked, Boolean(input.force) && input.walkUnknown !== false, operation);
    await sampleLinks(ranked, operation?.signal);
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
    if (!idle.length) return actions;
    const ranked = await timedStep(
      input.log,
      'rank_dependencies',
      () => rankDependencies(idle, input.protectedRoot ?? '', operation, false, input.log, inventory),
      { signal: operation?.signal, items: (found) => found?.length },
    );
    await sampleLinks(ranked, operation?.signal);
    const selected = selectDependencies(ranked, 'take');
    take = selected.take;
    if (!input.act || input.force)
      for (const { dependency, detail } of selected.kept)
        if (dependency.links)
          actions.push({
            rung: 4,
            kind: 'delete-dependencies',
            target: dependency.candidate.path,
            workspace: dependency.workspace,
            outcome: 'kept',
            bytes: 0,
            detail,
          });
  }
  await between();
  const worktrees = take.length ? await artifactWorktreesFor(operation) : [];
  const why = `${source ? 'idle.sourceDormantDays' : 'idle.dormantDays'} is ${afterMs / (24 * HOUR_MS)}`;
  const sourceResults =
    source && input.act
      ? await clearSourceCheckouts(
          take,
          afterMs,
          input.protectedRoot ?? '',
          worktrees,
          operation,
          why,
          'normal',
          between,
        )
      : new Map<RankedDependency, TreeResult>();
  for (const dependency of take) {
    if (!source) await between();
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

function dependencyCandidates(worktrees: readonly { path: string; keys: readonly string[] }[]): string[] {
  const paths = new Set<string>();
  for (const worktree of worktrees)
    for (const base of new Set([worktree.path, ...worktree.keys]))
      for (const dir of ARTIFACT_DIRS.dependencies) paths.add(join(base, dir));
  return [...paths];
}

export async function measureDependencyTrees(operation: StimContext): Promise<void> {
  for (const path of dependencyCandidates(await artifactWorktreesAsync(operation.signal, operation))) {
    const signature = await dependencyTreeSignature(path, operation.signal);
    if (signature === null) {
      if (hungRead() !== null) return;
      continue;
    }
    const { outcome } = await refreshMeasure(path, {
      timeoutMs: WALK_TIMEOUT_MS,
      claim: true,
      operation,
      knownToExist: true,
      signature,
    });
    if (outcome === 'busy') return;
  }
}

const BUILD_END_MARKER_MAX_AGE_MS = HOUR_MS;

function dropMarkers(files: readonly string[]): void {
  for (const file of files)
    try {
      rmSync(file, { force: true });
    } catch {}
}

// @ref LLP 0001#the-folders-a-build-wrote-are-measured-by-the-daemon -- a marker waits for the walk claim, never for load
/**
 * Measures the build output folders and the Cargo `target/` of every registered workspace whose build ended, and its
 * Stim workspace folder, through `refreshMeasure` with the cache bypassed, and returns how many folders it walked. The
 * folders are the ones the gc worktree report measures: inside the workspace, found through the census's bounded
 * reads. A marker is removed once its workspace was visited, and only the marker files listed before the walk, so a
 * build that ended meanwhile stays marked. A marker file that is unreadable, names a root this Stim home does not
 * know, names a root that no longer resolves to itself, or is over an hour old is removed without a read inside that
 * root. A layout that could not be read keeps the marker and measures nothing for that root. A held walk claim, or a
 * read that does not answer, ends the pass and keeps every marker not yet consumed. It never touches a dependency tree.
 */
export async function measureBuildEnds(
  operation: StimContext,
  now: number = Date.now(),
  markers: BuildEndMarker[] = listBuildEndMarkers(),
): Promise<number> {
  const byRoot = new Map<string, string[]>();
  for (const { file, path, markedAt } of markers) {
    if (path === null || markedAt === null || now - markedAt > BUILD_END_MARKER_MAX_AGE_MS) dropMarkers([file]);
    else byRoot.set(path, [...(byRoot.get(path) ?? []), file]);
  }
  let walked = 0;
  for (const [root, files] of byRoot) {
    operation.signal.throwIfAborted();
    if (getProject(root)) {
      const found = await buildOutputDirs(root, operation.signal);
      if (found === null) {
        if (hungRead() !== null) return walked;
        continue;
      }
      const folders = found === 'absent' ? [] : [...found, { dir: workspaceDir(root), private: false }];
      for (const { dir, private: withPrivate } of folders) {
        const { outcome } = await refreshMeasure(dir, {
          timeoutMs: WALK_TIMEOUT_MS,
          maxAgeMs: 0,
          claim: true,
          operation,
          private: withPrivate,
          ...(dir === workspaceDir(root) ? {} : { knownToExist: true as const }),
        });
        if (outcome === 'busy') return walked;
        walked++;
      }
    }
    dropMarkers(files);
  }
  return walked;
}
