import { join } from 'node:path';
import { configDir, type StimContext } from '@stim-cli/core';
import {
  loadConfig,
  readMaintenanceState,
  type MaintenancePressure,
  type MaintenanceSize,
  type MaintenanceMode,
} from '@stim-cli/core/state';
import { enforceBudget, resolveBudget } from '../budget.ts';
import { findProjectRoot } from '../workspace/project.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { collectWorkspaceOutputs, workspaceDirRemoved } from '../commands/gc/workspaces.ts';
import { cacheBlocked, measurePressure, measurePressureAsync } from './measure.ts';
import { discoverCaches } from '../cache/caches.ts';
import { candidateRootsAsync, type WorktreeSweep } from '../commands/gc/worktrees.ts';
import { listWorktreesAsync } from '../workspace/worktree.ts';
import { plan, type MaintenancePlan } from './plan.ts';
import { maintenancePinned, maintenancePinnedAsync, recentUse } from './protect.ts';
import { planSweep, planWorktrees } from './sweep.ts';
import { planIdleShutdown } from './devices.ts';
import { cachedDeviceActivity, cachedDeviceActivityAsync } from './activity.ts';
import { planIdleStop } from './idle-stop.ts';
import { planPressureLevels } from './levels.ts';
import { diskPressureLevel, lowestFree } from './pressure.ts';
import { resolveMaintenanceSettings, type MaintenanceSettings } from './settings.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';

export function triggeringRoot(operation?: StimContext): string {
  return canonicalPath(
    findProjectRoot(operation?.cwd ?? process.cwd()) ?? join(configDir(), 'maintenance', 'no-project'),
  );
}

export interface PlannedMaintenance extends MaintenancePlan {
  worktreeSweep?: WorktreeSweep;
  pressureSweep?: WorktreeSweep;
}

export async function plannedMaintenance(
  pressure: MaintenancePressure | null,
  recordedSizes: readonly MaintenanceSize[],
  settings: MaintenanceSettings,
  {
    devices = true,
    sweep = false,
    worktrees = false,
    idle = false,
    refresh = true,
    operation,
  }: {
    devices?: boolean;
    sweep?: boolean;
    worktrees?: boolean;
    idle?: boolean;
    refresh?: boolean;
    operation?: StimContext;
  } = {},
): Promise<PlannedMaintenance> {
  const env = operation?.env ?? process.env;
  const resolved = resolveBudget({ env });
  if (resolved.error) throw new Error(resolved.error);
  const budget = {
    ...resolved.budget,
    maxCommittedMemoryMb: 0,
    maxLiveWorkspaces: 0,
  };
  const root = triggeringRoot(operation);
  const floor = Math.max(budget.minFreeDiskMb, budget.hardFloorDiskMb);
  const low = pressure?.disk.some((disk) => disk.freeMb < floor);
  const outcome = low
    ? await enforceBudget(
        { root, note: () => {}, dryRun: true, budget, env, cwd: operation?.cwd, signal: operation?.signal, operation },
        { volumes: () => pressure!.disk },
      )
    : null;
  if (outcome && outcome.status !== 'ok') throw new Error(outcome.refusal.message);
  const outputs = await collectWorkspaceOutputs({
    olderThan: null,
    now: Date.now(),
    measure: false,
    signal: operation?.signal,
    operation,
  });
  const sizes = recordedSizes.filter((size) => size.category !== 'workspace-outputs' || !workspaceDirRemoved(size.dir));
  const currentSizes = sizes.map((size) => {
    if (size.category === 'compilation-cache')
      return { ...size, blocked: cacheBlocked(size, discoverCaches(env, operation?.cwd), env) };
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
  const result = plan({
    pressure,
    sizes: currentSizes,
    settings,
    budget,
    diskSteps:
      outcome?.status === 'ok' ? outcome.reclaimed.filter((step) => devices || step.step !== 'idle-devices') : [],
    protectedRoot: root,
    scoped: Boolean(env.STIM_HOME),
    projects: Object.keys(loadConfig()?.projects ?? {}).map(canonicalPath),
    pinned,
    recentlyUsed: (workspace) => recentUse(workspace, settings),
  }) as PlannedMaintenance;
  const merge = (extra: MaintenancePlan) => {
    for (const action of extra.actions)
      if (
        !result.actions.some(
          (entry) =>
            entry.kind === action.kind &&
            entry.target === action.target &&
            (entry.level === action.level || action.kind === 'would-delete-devices'),
        )
      )
        result.actions.push(action);
    result.blocked.push(...extra.blocked);
    result.skips.push(...extra.skips);
  };
  if (sweep)
    merge(await planSweep({ settings, sizes, protectedRoot: root, pinned, now: Date.now(), devices, operation }));
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
    });
    merge(planned);
    result.worktreeSweep = planned.sweep;
  }
  if (idle && devices) {
    merge(planIdleShutdown({ protectedRoot: root, now: Date.now(), env }));
    const now = Date.now();
    merge(
      await planIdleStop({
        protectedRoot: root,
        now,
        env,
        devices: operation
          ? cachedDeviceActivityAsync(now, env, operation.signal, operation)
          : cachedDeviceActivity(now),
      }),
    );
  }
  if (pressure) {
    const level = diskPressureLevel(lowestFree(pressure.disk), budget, settings);
    const pressured = await planPressureLevels(level, {
      settings,
      sizes: currentSizes,
      protectedRoot: root,
      pinned,
      now: Date.now(),
      refresh,
      operation,
    });
    merge(pressured);
    if (pressured.pressureSweep) result.pressureSweep = pressured.pressureSweep;
  }
  if (low) {
    result.skips.push(
      ...outputs.workspaces
        .filter((entry) => !entry.willClear && entry.keptReason)
        .map((entry) => ({
          target: entry.dir,
          reason: entry.keptReason!,
          workspace: entry.projectRoot ?? undefined,
        })),
    );
  }
  return result;
}

export interface MaintenancePreview extends MaintenancePlan {
  mode: MaintenanceMode;
  invalid?: string;
  pressure: MaintenancePressure | null;
  note: string | null;
}

export async function previewMaintenance({
  devices = true,
  refresh = true,
  operation,
}: { devices?: boolean; refresh?: boolean; operation?: StimContext } = {}): Promise<MaintenancePreview> {
  let settings: MaintenanceSettings | undefined;
  try {
    settings = resolveMaintenanceSettings(undefined, operation?.env ?? process.env);
    const state = readMaintenanceState();
    if (settings.invalid && settings.mode === 'off')
      return {
        mode: 'off',
        pressure: null,
        actions: [],
        blocked: [],
        skips: [],
        invalid: settings.invalid,
        note: settings.invalid,
      };
    if (settings.mode === 'off')
      return {
        mode: 'off',
        pressure: null,
        actions: [],
        blocked: [],
        skips: [],
        note: 'maintenance.mode is off',
      };
    const pressure = operation
      ? await measurePressureAsync(settings, state?.pressure ?? null, Date.now(), operation)
      : measurePressure(settings, state?.pressure ?? null, Date.now());
    const result = await plannedMaintenance(pressure, state?.sizes ?? [], settings, {
      devices,
      sweep: true,
      idle: true,
      refresh,
      operation,
    });
    return {
      ...result,
      mode: settings.mode,
      ...(settings.invalid ? { invalid: settings.invalid } : {}),
      pressure,
      note: settings.invalid ?? (state === null ? 'no pass has run yet; sizes have not been measured' : null),
    };
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    return {
      mode: settings?.mode ?? 'off',
      ...(settings?.invalid ? { invalid: settings.invalid } : {}),
      pressure: null,
      actions: [],
      blocked: [String(error)],
      skips: [],
      note: 'maintenance preview failed',
    };
  }
}
