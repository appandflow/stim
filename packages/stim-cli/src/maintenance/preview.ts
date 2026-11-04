import { join } from 'node:path';
import { configDir, type StimContext } from '@stim-cli/core';
import {
  loadConfig,
  readMaintenanceState,
  type MaintenancePressure,
  type MaintenanceSize,
  type MaintenanceMode,
} from '@stim-cli/core/state';
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
import { cachedDeviceActivity, cachedDeviceActivityAsync } from './activity.ts';
import { planIdleStop } from './idle-stop.ts';
import { resolveMaintenanceSettings, type MaintenanceSettings } from './settings.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import type { OwnedDeviceActivity } from '../commands/gc/idle.ts';

export function triggeringRoot(operation?: StimContext): string {
  return canonicalPath(
    findProjectRoot(operation?.cwd ?? process.cwd()) ?? join(configDir(), 'maintenance', 'no-project'),
  );
}

export interface PlannedMaintenance extends MaintenancePlan {
  worktreeSweep?: WorktreeSweep;
  nextRemoval?: { target: string; at: number };
}

export async function plannedMaintenance(
  recordedSizes: readonly MaintenanceSize[],
  settings: MaintenanceSettings,
  {
    devices = true,
    sweep = false,
    worktrees = false,
    idle = false,
    refresh = true,
    background = false,
    operation,
    deviceActivity,
  }: {
    devices?: boolean;
    sweep?: boolean;
    worktrees?: boolean;
    idle?: boolean;
    refresh?: boolean;
    background?: boolean;
    operation?: StimContext;
    /** Reads owned device activity for an operation, such as from the daemon tick's measurement. */
    deviceActivity?: (withSims: boolean) => Promise<OwnedDeviceActivity[]>;
  } = {},
): Promise<PlannedMaintenance> {
  const env = operation?.env ?? process.env;
  const root = triggeringRoot(operation);
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
    sizes: currentSizes,
    settings,
    protectedRoot: root,
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
            (action.check !== 'idle' || entry.check === 'idle'),
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
      deviceActivity,
    });
    merge(planned);
    result.worktreeSweep = planned.sweep;
    if (planned.nextRemoval) result.nextRemoval = planned.nextRemoval;
  }
  if (idle && devices) {
    const now = Date.now();
    try {
      merge(
        await planIdleStop({
          protectedRoot: background ? '' : root,
          now,
          env,
          operation,
          hostedOnly: true,
          devices: operation
            ? (deviceActivity ?? cachedDeviceActivityAsync(now, env, operation.signal, operation))
            : cachedDeviceActivity(now),
        }),
      );
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
      operation?.signal.throwIfAborted();
      result.blocked.push(`idle stop could not be planned: ${error instanceof Error ? error.message : String(error)}`);
    }
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
        note: 'daemon.mode is off',
      };
    const pressure = operation
      ? await measurePressureAsync(state?.pressure ?? null, Date.now(), operation)
      : measurePressure(state?.pressure ?? null, Date.now());
    const result = await plannedMaintenance(state?.sizes ?? [], settings, {
      devices,
      sweep: true,
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
