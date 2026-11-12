import { join } from 'node:path';
import { configDir, type StimContext } from '@stim-cli/core';
import { loadConfig, type PressureLevel, type MaintenancePlanPart, type MaintenanceSize } from '@stim-cli/core/state';
import { findProjectRoot } from '../../workspace/project.ts';
import { canonicalPath } from '../../commands/gc/paths.ts';
import { collectWorkspaceOutputs, workspaceDirRemoved } from '../../commands/gc/workspaces.ts';
import { cacheBlocked } from './measure.ts';
import { discoverCachesAsync } from '../../cache/caches.ts';
import { candidateRootsAsync, type WorktreeSweep } from '../../commands/gc/worktrees.ts';
import { listWorktreesAsync } from '../../workspace/worktree.ts';
import { planCargoTargets } from './cargo-target.ts';
import { plan, type MaintenancePlan } from './plan.ts';
import { maintenancePinned, maintenancePinnedAsync, maintenancePinnedReader, recentUse } from './protect.ts';
import { planSweep, planWorktrees } from './sweep.ts';
import { cachedDeviceActivity, cachedDeviceActivityAsync } from './activity.ts';
import { planIdleStop } from './idle-stop.ts';
import type { MaintenanceSettings } from './settings.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import type { OwnedDeviceActivity } from '../../commands/gc/idle.ts';

export function triggeringRoot(operation?: StimContext): string {
  return canonicalPath(
    findProjectRoot(operation?.cwd ?? process.cwd()) ?? join(configDir(), 'maintenance', 'no-project'),
  );
}

export interface PlannedMaintenance extends MaintenancePlan {
  worktreeSweep?: WorktreeSweep;
  nextRemoval?: { target: string; at: number };
  /** The blocked reasons and skips of each part this plan covered. */
  byCheck: Partial<Record<MaintenancePlanPart, Pick<MaintenancePlan, 'blocked' | 'skips'>>>;
}

/** The Cargo target trims of the recorded sizes alone, planned at low priority without the rest of the caps preamble. */
async function planCargoOnly(
  recordedSizes: readonly MaintenanceSize[],
  settings: MaintenanceSettings,
  level: PressureLevel | undefined,
  operation: StimContext | undefined,
): Promise<MaintenancePlan> {
  const pins = new Map<string, boolean>();
  for (const size of recordedSizes)
    if (size.name === 'Cargo target' && size.workspace && !pins.has(size.workspace))
      pins.set(size.workspace, await maintenancePinnedReader(operation)(size.workspace));
  return planCargoTargets({
    sizes: recordedSizes,
    settings,
    pinned: (workspace) => pins.get(workspace) ?? true,
    now: Date.now(),
    signal: operation?.signal,
    lowPriority: true,
    ...(level ? { level } : {}),
  });
}

export async function plannedMaintenance(
  recordedSizes: readonly MaintenanceSize[],
  settings: MaintenanceSettings,
  {
    devices = true,
    caps = true,
    cargoOnly = false,
    sweep = false,
    worktrees = false,
    idle = false,
    refresh = true,
    background = false,
    operation,
    deviceActivity,
    cargoLevel,
  }: {
    devices?: boolean;
    /** Plans the cap trims of the recorded sizes. */
    caps?: boolean;
    /** Plans only the Cargo target trims of them. */
    cargoOnly?: boolean;
    sweep?: boolean;
    worktrees?: boolean;
    idle?: boolean;
    refresh?: boolean;
    background?: boolean;
    operation?: StimContext;
    /** An explicit level for the Cargo target trims, applied to every target; without one each target takes its volume's disk level. */
    cargoLevel?: PressureLevel;
    /** Reads owned device activity for an operation, such as from the daemon tick's measurement. */
    deviceActivity?: (withSims: boolean) => Promise<OwnedDeviceActivity[]>;
  } = {},
): Promise<PlannedMaintenance> {
  const env = operation?.env ?? process.env;
  const root = triggeringRoot(operation);
  const idleStops = async (): Promise<MaintenancePlan> => {
    const now = Date.now();
    try {
      return await planIdleStop({
        protectedRoot: background ? '' : root,
        now,
        env,
        operation,
        hostedOnly: true,
        devices: operation
          ? (deviceActivity ?? cachedDeviceActivityAsync(now, env, operation.signal, operation))
          : cachedDeviceActivity(now),
      });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
      operation?.signal.throwIfAborted();
      return {
        actions: [],
        skips: [],
        blocked: [`idle stop could not be planned: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  };
  const result: PlannedMaintenance = { actions: [], blocked: [], skips: [], byCheck: {} };
  const merge = (part: MaintenancePlanPart, extra: MaintenancePlan) => {
    for (const action of extra.actions)
      if (
        !result.actions.some(
          (entry) =>
            entry.kind === action.kind &&
            entry.target === action.target &&
            (action.check !== 'idle' || entry.check === 'idle'),
        )
      )
        result.actions.push(action);
    result.blocked.push(...extra.blocked);
    result.skips.push(...extra.skips);
    result.byCheck[part] = { blocked: extra.blocked, skips: extra.skips };
  };
  if (!caps && !sweep && !worktrees) {
    if (idle && devices) merge('idle', await idleStops());
    return result;
  }
  if (cargoOnly && !sweep && !worktrees && !idle) {
    merge('caps', await planCargoOnly(recordedSizes, settings, cargoLevel, operation));
    return result;
  }
  const outputs = await collectWorkspaceOutputs({
    olderThan: null,
    now: Date.now(),
    measure: false,
    signal: operation?.signal,
    operation,
  });
  const sizes = recordedSizes.filter((size) => size.category !== 'workspace-outputs' || !workspaceDirRemoved(size.dir));
  const caches = sizes.some((size) => size.category === 'compilation-cache')
    ? await discoverCachesAsync(env, operation?.cwd)
    : [];
  const currentSizes = sizes.map((size) => {
    if (size.category === 'compilation-cache') return { ...size, blocked: cacheBlocked(size, caches, env) };
    if (!size.workspace) return size;
    const current = outputs.workspaces.find(
      (entry) => entry.projectRoot && canonicalPath(entry.projectRoot) === size.workspace,
    );
    return Object.assign({}, size, {
      blocked: current?.willClear ? undefined : (current?.keptReason ?? 'workspace outputs cannot be resolved'),
    });
  });
  const pins = new Map<string, boolean>();
  if (operation) {
    const candidates = await candidateRootsAsync(operation);
    const roots = new Set([
      ...Object.keys(loadConfig()?.projects ?? {}),
      ...candidates,
      ...sizes.flatMap((size) => (size.workspace ? [size.workspace] : [])),
      ...outputs.workspaces.flatMap((entry) => (entry.projectRoot ? [entry.projectRoot] : [])),
    ]);
    for (const path of candidates)
      for (const entry of await listWorktreesAsync(path, {
        env: operation.env,
        signal: operation.signal,
        declareFor: operation,
      }))
        roots.add(entry.path);
    for (const path of Array.from(roots, canonicalPath)) roots.add(path);
    for (const path of roots) pins.set(path, await maintenancePinnedAsync(path, operation));
  }
  const pinned = (workspace: string): boolean => {
    let value = pins.get(workspace);
    if (operation) return value ?? true;
    if (value === undefined) pins.set(workspace, (value = maintenancePinned(workspace)));
    return value;
  };
  if (caps) {
    const capped =
      cargoOnly && !sweep && !worktrees
        ? { actions: [], blocked: [], skips: [] }
        : plan({
            sizes: currentSizes,
            settings,
            protectedRoot: root,
            pinned,
            recentlyUsed: (workspace) => recentUse(workspace, settings),
          });
    const cargo = await planCargoTargets({
      sizes: currentSizes,
      settings,
      pinned,
      now: Date.now(),
      signal: operation?.signal,
      ...(cargoLevel ? { level: cargoLevel } : {}),
    });
    merge('caps', {
      actions: [...capped.actions, ...cargo.actions],
      blocked: [...capped.blocked, ...cargo.blocked],
      skips: [...capped.skips, ...cargo.skips],
    });
  }
  if (sweep)
    merge(
      'sweep',
      await planSweep({
        settings,
        sizes,
        protectedRoot: root,
        pinned,
        now: Date.now(),
        devices,
        background,
        operation,
      }),
    );
  if (worktrees) {
    const planned = await planWorktrees({
      protectedRoot: root,
      pinned,
      now: Date.now(),
      sizes: currentSizes,
      protectRecentMs: settings.protectRecentHours * 3_600_000,
      refresh,
      idleDays: sweep && settings.removeIdleWorktrees && settings.olderThanDays > 0 ? settings.olderThanDays : null,
      operation,
      deviceActivity,
    });
    merge('worktree', planned);
    result.worktreeSweep = planned.sweep;
    if (planned.nextRemoval) result.nextRemoval = planned.nextRemoval;
  }
  if (idle && devices) merge('idle', await idleStops());
  return result;
}
