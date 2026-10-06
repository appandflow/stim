import { join } from 'node:path';
import { configDir } from '@stim-cli/core';
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
import { collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { cacheBlocked, measurePressure } from './measure.ts';
import { plan, type MaintenancePlan } from './plan.ts';
import { resolveMaintenanceSettings, type MaintenanceSettings } from './settings.ts';

function triggeringRoot(): string {
  return canonicalPath(findProjectRoot(process.cwd()) ?? join(configDir(), 'maintenance', 'no-project'));
}

export async function plannedMaintenance(
  pressure: MaintenancePressure | null,
  sizes: readonly MaintenanceSize[],
  settings: MaintenanceSettings,
  { devices = true }: { devices?: boolean } = {},
): Promise<MaintenancePlan> {
  const resolved = resolveBudget();
  if (resolved.error) throw new Error(resolved.error);
  const budget = {
    ...resolved.budget,
    maxCommittedMemoryMb: 0,
    maxLiveWorkspaces: 0,
  };
  const root = triggeringRoot();
  const floor = Math.max(budget.minFreeDiskMb, budget.hardFloorDiskMb);
  const low = pressure?.disk.some((disk) => disk.freeMb < floor);
  const outcome = low
    ? await enforceBudget({ root, note: () => {}, dryRun: true, budget }, { volumes: () => pressure!.disk })
    : null;
  if (outcome && outcome.status !== 'ok') throw new Error(outcome.refusal.message);
  const outputs = collectWorkspaceOutputs({
    olderThan: null,
    now: Date.now(),
    measure: false,
  });
  const currentSizes = sizes.map((size) => {
    if (size.category === 'compilation-cache') return { ...size, blocked: cacheBlocked(size) };
    if (!size.workspace) return size;
    const current = outputs.workspaces.find(
      (entry) => entry.projectRoot && canonicalPath(entry.projectRoot) === size.workspace,
    );
    return Object.assign({}, size, {
      blocked: current?.willClear ? undefined : (current?.keptReason ?? 'workspace outputs cannot be resolved'),
    });
  });
  const result = plan({
    pressure,
    sizes: currentSizes,
    settings,
    budget,
    diskSteps:
      outcome?.status === 'ok' ? outcome.reclaimed.filter((step) => devices || step.step !== 'idle-devices') : [],
    protectedRoot: root,
    scoped: Boolean(process.env.STIM_HOME),
    projects: Object.keys(loadConfig()?.projects ?? {}).map(canonicalPath),
  });
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

export async function previewMaintenance({ devices = true }: { devices?: boolean } = {}): Promise<MaintenancePreview> {
  let settings: MaintenanceSettings | undefined;
  try {
    settings = resolveMaintenanceSettings();
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
    const pressure = measurePressure(settings, state?.pressure ?? null, Date.now());
    const result = await plannedMaintenance(pressure, state?.sizes ?? [], settings, { devices });
    return {
      ...result,
      mode: settings.mode,
      ...(settings.invalid ? { invalid: settings.invalid } : {}),
      pressure,
      note: settings.invalid ?? (state === null ? 'no pass has run yet; sizes have not been measured' : null),
    };
  } catch (error) {
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
