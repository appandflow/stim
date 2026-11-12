import { existsSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { loadConfig, type MaintenanceAction, type MaintenanceSize } from '@stim-cli/core/state';
import { measuredDirectorySizeAsync } from '../../fs-util.ts';
import { canonicalPath } from '../../commands/gc/paths.ts';
import { listedRoots } from '../../commands/gc/worktrees.ts';
import { discoverCheckouts } from '../../workspace/discovery.ts';
import { cargoTargetDirsAsync, isBuildDirPath, regenerableDirProblem } from '../../workspace/regenerable-dirs.ts';
import { appRoots, artifactCheckoutsAsync } from './artifacts.ts';
import { cargoProfileDirs, staleCargoTargetPaths, trimCargoTarget } from '../../workspace/cargo-target.ts';
import type { ActionOutcome } from './act.ts';
import type { MaintenancePlan } from './plan.ts';
import { resolveMaintenanceSettings, type MaintenanceSettings } from './settings.ts';

const GIB = 1024 ** 3;
const CARGO_TARGET_SIZE = 'Cargo target';
const SIZE_TIMEOUT_MS = 120_000;
const MAX_DISCOVERED_TARGETS = 6;

export interface CargoTargetCandidate {
  root: string;
  dir: string;
  discovered: boolean;
  /** When a size scan last walked it, or null when none has. */
  measuredAt: number | null;
}

/**
 * The `target/` directories one size scan walks: each directory once (a registered one wins over a discovered one),
 * every registered one, and of the discovered ones the `limit` least recently measured (never measured first), so
 * successive scans rotate through all of them; the rest are returned as `unlisted` so the plan can say so.
 */
export function selectCargoTargets(
  candidates: readonly CargoTargetCandidate[],
  limit: number = MAX_DISCOVERED_TARGETS,
): { measured: CargoTargetCandidate[]; unlisted: CargoTargetCandidate[] } {
  const byDir = new Map<string, CargoTargetCandidate>();
  for (const candidate of candidates) {
    const seen = byDir.get(candidate.dir);
    if (!seen || (seen.discovered && !candidate.discovered)) byDir.set(candidate.dir, candidate);
  }
  const all = [...byDir.values()];
  const discovered = all
    .filter((entry) => entry.discovered)
    .toSorted((a, b) => (a.measuredAt ?? -Infinity) - (b.measuredAt ?? -Infinity) || a.dir.localeCompare(b.dir));
  return {
    measured: [...all.filter((entry) => !entry.discovered), ...discovered.slice(0, limit)],
    unlisted: discovered.slice(limit),
  };
}

interface ScanState {
  unmeasured: Map<string, string>;
  refused: Map<string, { workspace: string; reason: string }>;
  unlisted: string[];
}

/**
 * What the last size scan found besides sizes. A `target/` it could not measure is no size entry: nothing is known of
 * its size, so the plan only trims its stale profiles and reports it as needing a person.
 */
let scan: ScanState = { unmeasured: new Map(), refused: new Map(), unlisted: [] };

/** When each `target/` was last walked, kept for the life of the process and seeded from the recorded sizes. */
const lastMeasured = new Map<string, number>();

const kept = (detail: string): ActionOutcome => ({ status: 'kept', bytes: 0, detail });

async function cargoTargetCandidates(
  registered: readonly string[],
  operation?: StimContext,
): Promise<CargoTargetCandidate[]> {
  const signal = operation?.signal ?? new AbortController().signal;
  const found: CargoTargetCandidate[] = [];
  const add = async (base: string, discovered: boolean) => {
    const root = canonicalPath(base);
    for (const path of await cargoTargetDirsAsync(root)) {
      try {
        await lstat(path);
        found.push({ root, dir: path, discovered, measuredAt: lastMeasured.get(path) ?? null });
      } catch {}
    }
  };
  for (const root of registered) await add(root, false);
  const discovered = new Set(
    (await discoverCheckouts(loadConfig(), listedRoots(), operation)).map(({ path }) => canonicalPath(path)),
  );
  for (const checkout of await artifactCheckoutsAsync(signal, operation))
    for (const base of appRoots(checkout, 'build')) await add(base, discovered.has(canonicalPath(checkout.path)));
  return found;
}

/**
 * One walk of each Cargo `target/` Stim recognises (an Exact app's, or a root `target/` carrying the standard
 * `CACHEDIR.TAG`) in a registered workspace or an in-scope discovered checkout, and only of directories that exist and
 * that git ignores whole; none when the cap is 0. A walk that times out leaves no size and is planned from the scan state.
 */
export async function measureCargoTargets(
  now: number,
  operation?: StimContext,
  recorded: readonly MaintenanceSize[] = [],
): Promise<MaintenanceSize[]> {
  const sizes: MaintenanceSize[] = [];
  for (const size of recorded)
    if (size.name === CARGO_TARGET_SIZE && !lastMeasured.has(size.dir)) lastMeasured.set(size.dir, size.measuredAt);
  scan = { unmeasured: new Map(), refused: new Map(), unlisted: [] };
  if (resolveMaintenanceSettings().cargoTargetMaxGb === 0) return sizes;
  const registered = Object.keys(loadConfig()?.projects ?? {});
  const { measured, unlisted } = selectCargoTargets(await cargoTargetCandidates(registered, operation));
  scan.unlisted = unlisted.map(({ dir }) => dir);
  for (const { root, dir } of measured) {
    lastMeasured.set(dir, now);
    const problem = await regenerableDirProblem(root, dir, operation?.signal, { processes: false });
    if (problem) {
      scan.refused.set(dir, { workspace: root, reason: problem });
      continue;
    }
    const bytes = await measuredDirectorySizeAsync(dir, {
      timeoutMs: SIZE_TIMEOUT_MS,
      ...(operation ? { signal: operation.signal, operation } : {}),
    });
    if (bytes === null) scan.unmeasured.set(dir, root);
    else sizes.push({ name: CARGO_TARGET_SIZE, category: 'other', dir, bytes, measuredAt: now, workspace: root });
  }
  return sizes;
}

async function bytesOf(paths: readonly string[], signal?: AbortSignal): Promise<number> {
  let total = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    total += (await measuredDirectorySizeAsync(path, { timeoutMs: SIZE_TIMEOUT_MS, signal })) ?? 0;
  }
  return total;
}

/**
 * One trim per Cargo `target/` that is over `maintenance.cargoTargetMaxGb`: the bytes planned are the overage or
 * what the stale profiles and, past them, the `incremental` directories can free, whichever is less.
 */
export async function planCargoTargets({
  sizes,
  settings,
  pinned,
  now,
  signal,
}: {
  sizes: readonly MaintenanceSize[];
  settings: MaintenanceSettings;
  pinned: (workspace: string) => boolean;
  now: number;
  signal?: AbortSignal;
}): Promise<MaintenancePlan> {
  const plan: MaintenancePlan = { actions: [], blocked: [], skips: [] };
  const cap = settings.cargoTargetMaxGb * GIB;
  if (cap === 0) return plan;
  const targets = [
    ...sizes.flatMap((size) =>
      size.name === CARGO_TARGET_SIZE && size.bytes > cap && size.workspace
        ? [{ dir: size.dir, workspace: size.workspace, bytes: size.bytes }]
        : [],
    ),
    ...[...scan.unmeasured].map(([dir, workspace]) => ({ dir, workspace, bytes: null })),
  ];
  for (const [dir, { workspace, reason }] of scan.refused) plan.skips.push({ target: dir, reason, workspace });
  if (scan.unlisted.length)
    plan.blocked.push(
      `${scan.unlisted.length} Cargo target/ of discovered checkouts were not measured this scan (at most ${MAX_DISCOVERED_TARGETS} are per scan, the least recently measured first): ${scan.unlisted.join(', ')}`,
    );
  for (const { dir, workspace, bytes } of targets) {
    const over =
      bytes === null
        ? `${dir} is too large to measure within ${SIZE_TIMEOUT_MS / 1000}s, so only its stale profiles are trimmed`
        : `${dir} is ${(bytes / GIB).toFixed(1)}G, over the ${settings.cargoTargetMaxGb}G cargo target cap`;
    if (pinned(workspace)) {
      plan.skips.push({ target: dir, reason: 'pinned by maintenance.keep', workspace });
      continue;
    }
    if (bytes === null) plan.blocked.push(over);
    const stale = staleCargoTargetPaths(dir, now);
    if ('refusal' in stale) {
      plan.skips.push({ target: dir, reason: stale.refusal, workspace });
      continue;
    }
    const gone = stale.paths.map((path) => join(dir, path));
    let freeable = await bytesOf(gone, signal);
    const overBytes = bytes === null ? 0 : bytes - cap;
    if (freeable < overBytes) {
      const remaining = (cargoProfileDirs(dir) ?? []).filter(
        (profile) => !gone.some((path) => profile === path || profile.startsWith(`${path}/`)),
      );
      freeable += await bytesOf(remaining.map((profile) => join(profile, 'incremental')).filter(existsSync), signal);
    }
    if (freeable === 0 && !existsSync(join(dir, '.stim-trimmed'))) {
      if (bytes !== null)
        plan.blocked.push(`${over}; every profile was used in the last day and none has an incremental cache`);
      continue;
    }
    plan.actions.push({
      kind: 'would-clear-build-dirs',
      target: dir,
      workspace,
      bytes: bytes === null ? freeable : Math.min(overBytes, freeable),
      ...(bytes === null ? { olderThanDays: 1 } : {}),
      reason:
        bytes === null
          ? `${over}; trims the profiles unused for a day`
          : `${over}; trims the profiles unused for a day, then the incremental caches`,
    });
  }
  return plan;
}

async function stillManaged(root: string, operation?: StimContext): Promise<boolean> {
  const canonical = canonicalPath(root);
  if (listedRoots().some((listed) => canonicalPath(listed) === canonical)) return true;
  const signal = operation?.signal ?? new AbortController().signal;
  return (await artifactCheckoutsAsync(signal, operation)).some((checkout) =>
    appRoots(checkout, 'build').some((base) => canonicalPath(base) === canonical),
  );
}

export async function trimCargoTargetAction(
  action: MaintenanceAction,
  operation?: StimContext,
): Promise<ActionOutcome> {
  const root = action.workspace;
  if (!root || !isBuildDirPath(action.target)) return kept('it is no longer a Cargo target/ Stim recognises');
  if (!(await stillManaged(root, operation)))
    return kept('its checkout is no longer in a workspace or discovery scope');
  const problem = await regenerableDirProblem(root, action.target, operation?.signal, { processes: false });
  if (problem) return kept(problem);
  const result = await trimCargoTarget(action.target, {
    needBytes: action.olderThanDays === undefined ? action.bytes : 0,
    signal: operation?.signal,
  });
  const detail = `${result.removed.length ? `removed ${result.removed.join(', ')}` : 'removed nothing'}${result.kept.length ? `; kept ${result.kept.join('; ')}` : ''}`;
  if (result.deleteError)
    return {
      status: 'failed',
      bytes: result.bytes,
      detail: `${(result.bytes / GIB).toFixed(1)}G moved aside; ${result.deleteError}; the next pass deletes it; ${detail}`,
    };
  return result.removed.length ? { status: 'done', bytes: result.bytes, detail } : kept(detail);
}
