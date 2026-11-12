import { existsSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { loadConfig, type MaintenanceAction, type MaintenanceSize, type PressureLevel } from '@stim-cli/core/state';
import { getExecutor } from '../../exec.ts';
import { diskPressure, diskThresholds } from '../../daemon/pressure.ts';
import { measuredDirectorySizeAsync } from '../../fs-util.ts';
import { canonicalPath } from '../../commands/gc/paths.ts';
import { listedRoots } from '../../commands/gc/worktrees.ts';
import { discoverCheckouts } from '../../workspace/discovery.ts';
import { cargoTargetDirsAsync, isBuildDirPath, regenerableDirProblem } from '../../workspace/regenerable-dirs.ts';
import { appRoots, artifactCheckoutsAsync } from './artifacts.ts';
import { readVolumeSpaceAsync } from './budget.ts';
import {
  cargoProfileDirs,
  idleCargoUnitPaths,
  staleCargoTargetPaths,
  trimCargoTarget,
} from '../../workspace/cargo-target.ts';
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
  measuredAt: number | null;
}

/** Orders targets that were never measured, such as all of them after a restart, differently each hour, so the same few do not repeat. */
function tieBreak(dir: string, now: number): number {
  let hash = Math.floor(now / 3_600_000);
  for (const char of dir) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return hash;
}

/**
 * The `target/` directories one size scan walks: each directory once (a registered one wins over a discovered one),
 * every registered one, and of the discovered ones the `limit` least recently measured (never measured first), so
 * successive scans rotate through all of them; the rest are returned as `unlisted` so the plan can say so.
 */
export function selectCargoTargets(
  candidates: readonly CargoTargetCandidate[],
  limit: number = MAX_DISCOVERED_TARGETS,
  now: number = Date.now(),
): { measured: CargoTargetCandidate[]; unlisted: CargoTargetCandidate[] } {
  const byDir = new Map<string, CargoTargetCandidate>();
  for (const candidate of candidates) {
    const seen = byDir.get(candidate.dir);
    if (!seen || (seen.discovered && !candidate.discovered)) byDir.set(candidate.dir, candidate);
  }
  const all = [...byDir.values()];
  const discovered = all
    .filter((entry) => entry.discovered)
    .toSorted(
      (a, b) =>
        (a.measuredAt ?? -Infinity) - (b.measuredAt ?? -Infinity) ||
        tieBreak(a.dir, now) - tieBreak(b.dir, now) ||
        a.dir.localeCompare(b.dir),
    );
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
  { lowPriority = false }: { lowPriority?: boolean } = {},
): Promise<MaintenanceSize[]> {
  const sizes: MaintenanceSize[] = [];
  for (const size of recorded)
    if (size.name === CARGO_TARGET_SIZE && !lastMeasured.has(size.dir)) lastMeasured.set(size.dir, size.measuredAt);
  scan = { unmeasured: new Map(), refused: new Map(), unlisted: [] };
  if (resolveMaintenanceSettings().cargoTargetMaxGb === 0) return sizes;
  const registered = Object.keys(loadConfig()?.projects ?? {});
  const { measured, unlisted } = selectCargoTargets(
    await cargoTargetCandidates(registered, operation),
    MAX_DISCOVERED_TARGETS,
    now,
  );
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
      lowPriority,
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

const DU_CHUNK = 400;

/** The bytes of many paths with one `du` per chunk, for the thousands of files and directories of a unit sweep. */
async function bytesOfMany(paths: readonly string[], signal?: AbortSignal): Promise<number> {
  let total = 0;
  for (let at = 0; at < paths.length; at += DU_CHUNK) {
    signal?.throwIfAborted();
    try {
      const out = await getExecutor().runFileAsync('du', ['-sk', ...paths.slice(at, at + DU_CHUNK)], {
        timeoutMs: SIZE_TIMEOUT_MS,
        signal,
      });
      for (const line of out.split('\n')) total += (parseInt(line, 10) || 0) * 1024;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof Error && 'stdout' in error)) continue;
    }
  }
  return total;
}

/**
 * What a trim of a Cargo `target/` removes at a disk level: normal covers the overage with stale profiles, then
 * `incremental` data, then idle units; high removes every stale profile and all `incremental` data whatever the cap,
 * and idle units only while still over it; critical also removes every idle unit.
 */
export function cargoTrimPolicy(level: PressureLevel): {
  incremental: 'toNeed' | 'all';
  units: 'toNeed' | 'all';
} {
  return { incremental: level === 'normal' ? 'toNeed' : 'all', units: level === 'critical' ? 'all' : 'toNeed' };
}

const LEVELS = { normal: undefined, high: 2, critical: 3 } as const;

async function measuredDiskLevel(dir: string, signal?: AbortSignal): Promise<PressureLevel> {
  const { thresholds } = diskThresholds(loadConfig());
  return diskPressure(await readVolumeSpaceAsync([dir], signal), thresholds).level;
}

/**
 * One trim per Cargo `target/` that is over `maintenance.cargoTargetMaxGb`, or at high or critical disk level every
 * recognised one. The level is `level` when given (an explicit `stim gc --pressure`, which applies everywhere) and else
 * the disk level of the volume the `target/` is on. Planned bytes are, at normal, the overage or what the steps can
 * free, whichever is less, and at high and critical what they free.
 */
export async function planCargoTargets({
  sizes,
  settings,
  pinned,
  now,
  signal,
  level,
  diskLevel = measuredDiskLevel,
}: {
  sizes: readonly MaintenanceSize[];
  settings: MaintenanceSettings;
  pinned: (workspace: string) => boolean;
  now: number;
  signal?: AbortSignal;
  level?: PressureLevel;
  diskLevel?: (dir: string, signal?: AbortSignal) => Promise<PressureLevel>;
}): Promise<MaintenancePlan> {
  const plan: MaintenancePlan = { actions: [], blocked: [], skips: [] };
  const cap = settings.cargoTargetMaxGb * GIB;
  const targets = [
    ...sizes.flatMap((size) =>
      size.name === CARGO_TARGET_SIZE && size.workspace
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
    signal?.throwIfAborted();
    const tightened = level ?? (await diskLevel(dir, signal));
    const capped = cap > 0 && (bytes === null || bytes > cap);
    if (!capped && tightened === 'normal') continue;
    const policy = cargoTrimPolicy(tightened);
    const overBytes = bytes === null || cap === 0 ? 0 : Math.max(0, bytes - cap);
    const why =
      tightened === 'normal'
        ? bytes === null
          ? `${dir} is too large to measure within ${SIZE_TIMEOUT_MS / 1000}s, so only its stale profiles are trimmed`
          : `${dir} is ${(bytes / GIB).toFixed(1)}G, over the ${settings.cargoTargetMaxGb}G cargo target cap`
        : `disk is at the ${tightened} level for ${dir}${bytes === null ? ', which is too large to measure' : ` (${(bytes / GIB).toFixed(1)}G)`}`;
    if (pinned(workspace)) {
      plan.skips.push({ target: dir, reason: 'pinned by maintenance.keep', workspace });
      continue;
    }
    if (bytes === null) plan.blocked.push(why);
    const stale = staleCargoTargetPaths(dir, now);
    if ('refusal' in stale) {
      plan.skips.push({ target: dir, reason: stale.refusal, workspace });
      continue;
    }
    const gone = stale.paths.map((path) => join(dir, path));
    let freeable = await bytesOf(gone, signal);
    if (policy.incremental === 'all' || freeable < overBytes) {
      const remaining = (cargoProfileDirs(dir) ?? []).filter(
        (profile) => !gone.some((path) => profile === path || profile.startsWith(`${path}/`)),
      );
      freeable += await bytesOf(remaining.map((profile) => join(profile, 'incremental')).filter(existsSync), signal);
    }
    if (policy.units === 'all' || freeable < overBytes)
      freeable += await bytesOfMany(idleCargoUnitPaths(dir, now, gone), signal);
    if (freeable === 0 && !existsSync(join(dir, '.stim-trimmed'))) {
      if (bytes !== null && tightened === 'normal')
        plan.blocked.push(`${why}; every profile was used in the last day and none has anything idle to remove`);
      continue;
    }
    const steps = `trims the profiles unused for a day, then the incremental caches${tightened === 'normal' ? '' : ' (all of them)'}, then the build units unused for a day${tightened === 'critical' ? ' (all of them)' : ' while still over the cap'}`;
    plan.actions.push({
      kind: 'would-clear-build-dirs',
      target: dir,
      workspace,
      bytes: tightened === 'normal' ? Math.min(overBytes, freeable) : freeable,
      overBytes,
      ...(LEVELS[tightened] ? { level: LEVELS[tightened] } : {}),
      ...(bytes === null ? { olderThanDays: 1 } : {}),
      reason: `${why}; ${steps}`,
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
    needBytes: action.olderThanDays === undefined ? (action.overBytes ?? action.bytes) : 0,
    ...cargoTrimPolicy(action.level === 3 ? 'critical' : action.level === 2 ? 'high' : 'normal'),
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
