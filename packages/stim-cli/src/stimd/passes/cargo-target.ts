import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import type { MaintenanceAction, MaintenanceSize } from '@stim-cli/core/state';
import { measuredDirectorySizeAsync } from '../../fs-util.ts';
import { exactTargetDirAsync, isBuildDirPath, regenerableDirProblem } from '../../workspace/regenerable-dirs.ts';
import { cargoProfileDirs, staleCargoTargetPaths, trimCargoTarget } from '../../workspace/cargo-target.ts';
import type { ActionOutcome } from './act.ts';
import type { MaintenancePlan } from './plan.ts';
import { resolveMaintenanceSettings, type MaintenanceSettings } from './settings.ts';

const GIB = 1024 ** 3;
const CARGO_TARGET_SIZE = 'Cargo target';
const SIZE_TIMEOUT_MS = 120_000;

/**
 * The `target/` directories the last size scan could not measure in time, by app root. They are no size entry: nothing
 * is known of their size, so the plan only trims their stale profiles and reports them as needing a person.
 */
let unmeasured = new Map<string, string>();

const kept = (detail: string): ActionOutcome => ({ status: 'kept', bytes: 0, detail });

/** One walk of each Exact app's `target/`; none when the cap is 0. A walk that times out leaves no size and is planned from `unmeasured`. */
export async function measureCargoTargets(
  roots: readonly string[],
  now: number,
  operation?: StimContext,
): Promise<MaintenanceSize[]> {
  const sizes: MaintenanceSize[] = [];
  unmeasured = new Map();
  if (resolveMaintenanceSettings().cargoTargetMaxGb === 0) return sizes;
  for (const root of roots) {
    const dir = await exactTargetDirAsync(root);
    if (!dir) continue;
    const bytes = await measuredDirectorySizeAsync(dir, {
      timeoutMs: SIZE_TIMEOUT_MS,
      ...(operation ? { signal: operation.signal, operation } : {}),
    });
    if (bytes === null) unmeasured.set(root, dir);
    else sizes.push({ name: CARGO_TARGET_SIZE, category: 'other', dir, bytes, measuredAt: now, workspace: root });
  }
  return sizes;
}

async function bytesOf(paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const path of paths) total += (await measuredDirectorySizeAsync(path, { timeoutMs: SIZE_TIMEOUT_MS })) ?? 0;
  return total;
}

/**
 * One trim per Exact app whose `target/` is over `maintenance.cargoTargetMaxGb`: the bytes planned are the overage or
 * what the stale profiles and, past them, the `incremental` directories can free, whichever is less.
 */
export async function planCargoTargets({
  sizes,
  settings,
  pinned,
  now,
}: {
  sizes: readonly MaintenanceSize[];
  settings: MaintenanceSettings;
  pinned: (workspace: string) => boolean;
  now: number;
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
    ...[...unmeasured].map(([workspace, dir]) => ({ dir, workspace, bytes: null })),
  ];
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
    let freeable = await bytesOf(gone);
    const overBytes = bytes === null ? 0 : bytes - cap;
    if (freeable < overBytes) {
      const remaining = (cargoProfileDirs(dir) ?? []).filter(
        (profile) => !gone.some((path) => profile === path || profile.startsWith(`${path}/`)),
      );
      freeable += await bytesOf(remaining.map((profile) => join(profile, 'incremental')).filter(existsSync));
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

export async function trimCargoTargetAction(
  action: MaintenanceAction,
  operation?: StimContext,
): Promise<ActionOutcome> {
  const root = action.workspace;
  if (!root || !isBuildDirPath(action.target)) return kept('it is no longer an Exact app target/');
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
