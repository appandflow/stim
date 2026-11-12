import type { StimContext } from '@stim-cli/core';
import type { MaintenanceAction, MaintenanceSize } from '@stim-cli/core/state';
import { measuredDirectorySizeAsync } from '../../fs-util.ts';
import { exactTargetDirAsync, isBuildDirPath, regenerableDirProblem } from '../../workspace/regenerable-dirs.ts';
import { staleCargoTargetPaths, trimCargoTarget } from '../../workspace/cargo-target.ts';
import type { ActionOutcome } from './act.ts';
import type { MaintenancePlan } from './plan.ts';
import type { MaintenanceSettings } from './settings.ts';

const GIB = 1024 ** 3;
const CARGO_TARGET_SIZE = 'Cargo target';

const kept = (detail: string): ActionOutcome => ({ status: 'kept', bytes: 0, detail });

export async function measureCargoTargets(
  roots: readonly string[],
  now: number,
  failure: (target: string, workspace?: string) => void,
  operation?: StimContext,
): Promise<MaintenanceSize[]> {
  const sizes: MaintenanceSize[] = [];
  for (const root of roots) {
    const dir = await exactTargetDirAsync(root);
    if (!dir) continue;
    const bytes = await measuredDirectorySizeAsync(dir, {
      timeoutMs: 120_000,
      ...(operation ? { signal: operation.signal, operation } : {}),
    });
    if (bytes === null) failure(dir, root);
    else sizes.push({ name: CARGO_TARGET_SIZE, category: 'other', dir, bytes, measuredAt: now, workspace: root });
  }
  return sizes;
}

/** One trim per Exact app whose `target/` is over `maintenance.cargoTargetMaxGb` and holds profiles unused for a day. */
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
  for (const size of sizes) {
    if (size.name !== CARGO_TARGET_SIZE || size.bytes <= cap || !size.workspace) continue;
    const over = `${(size.bytes / GIB).toFixed(1)}G over the ${settings.cargoTargetMaxGb}G cargo target cap`;
    if (pinned(size.workspace)) {
      plan.skips.push({ target: size.dir, reason: 'pinned by maintenance.keep', workspace: size.workspace });
      continue;
    }
    const stale = staleCargoTargetPaths(size.dir, now);
    if ('refusal' in stale) plan.skips.push({ target: size.dir, reason: stale.refusal, workspace: size.workspace });
    else if (!stale.paths.length) plan.blocked.push(`${size.dir} is ${over}; every profile was used in the last day`);
    else
      plan.actions.push({
        kind: 'would-clear-build-dirs',
        target: size.dir,
        workspace: size.workspace,
        bytes: 0,
        reason: `${over}; ${stale.paths.length} profile${stale.paths.length === 1 ? '' : 's'} unused for a day`,
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
  const problem = await regenerableDirProblem(root, action.target, operation?.signal);
  if (problem) return kept(problem);
  const stale = staleCargoTargetPaths(action.target, Date.now());
  if ('refusal' in stale) return kept(stale.refusal);
  if (!stale.paths.length) return kept('every profile was used since it was planned');
  const result = await trimCargoTarget(action.target, stale.paths, operation?.signal);
  if (!result.removed.length) return kept(result.kept.join('; ') || 'nothing was removed');
  return {
    status: 'done',
    bytes: result.bytes,
    detail: `removed ${result.removed.join(', ')}${result.kept.length ? `; kept ${result.kept.join('; ')}` : ''}`,
  };
}
