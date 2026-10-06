import type { MaintenanceAction, MaintenancePressure, MaintenanceSize } from '@stim-cli/core/state';
import type { ReclaimedStep, Budget } from '../budget.ts';
import type { MaintenanceSettings } from './settings.ts';

export interface MaintenancePlan {
  actions: MaintenanceAction[];
  blocked: string[];
  skips: { target: string; reason: string; workspace?: string }[];
}

export function plan({
  pressure,
  sizes,
  settings,
  budget,
  diskSteps = [],
  protectedRoot,
  scoped = false,
  projects = [],
}: {
  pressure: MaintenancePressure | null;
  sizes: readonly MaintenanceSize[];
  settings: MaintenanceSettings;
  budget: Budget;
  diskSteps?: readonly ReclaimedStep[];
  protectedRoot: string;
  scoped?: boolean;
  projects?: readonly string[];
}): MaintenancePlan {
  const actions: MaintenanceAction[] = [];
  const blocked: string[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const add = (action: MaintenanceAction) => {
    if (!actions.some((entry) => entry.kind === action.kind && entry.target === action.target)) actions.push(action);
  };
  const floor = Math.max(budget.minFreeDiskMb, budget.hardFloorDiskMb);
  const low = pressure?.disk.filter((disk) => disk.freeMb < floor) ?? [];
  const reason = low
    .map(
      (disk) =>
        `free disk ${(disk.freeMb / 1024).toFixed(1)}G on ${disk.volume} under the ${(floor / 1024).toFixed(1)}G floor`,
    )
    .join('; ');
  const kinds = {
    'idle-devices': 'would-shutdown-device',
    'idle-dev-servers': 'would-stop-workspace',
    'workspace-outputs': 'would-clear-outputs',
    'stale-cache-entries': 'would-trim-cache',
  } as const;
  if (low.length) {
    for (const step of diskSteps) {
      if (scoped && step.step === 'idle-devices') continue;
      for (const target of step.targets) {
        const workspace =
          projects.find((root) => root === target || target.endsWith(` in ${root}`)) ??
          (step.step === 'idle-dev-servers' || step.step === 'workspace-outputs' ? target : undefined);
        if (workspace === protectedRoot || target === protectedRoot) continue;
        const size =
          workspace && step.step !== 'idle-devices'
            ? sizes.find((entry) => entry.workspace === workspace && entry.category === 'workspace-outputs')
            : undefined;
        add({
          kind: kinds[step.step],
          target,
          bytes: step.step === 'workspace-outputs' ? (size?.bytes ?? 0) : 0,
          reason: `${size?.idleDays == null ? '' : `idle ${size.idleDays} days, `}${reason}`,
          ...(workspace ? { workspace } : {}),
        });
      }
      if (step.failures) blocked.push(`Could not plan ${step.step}: ${step.failures} failures`);
    }
    if (actions.length === 0) blocked.push(`${reason}; no reclaimable disk targets`);
  }
  const caps = [
    ['workspace-outputs', settings.workspaceOutputsMaxGb, 'would-clear-outputs'],
    ['build-cache', settings.buildCacheMaxGb, 'would-trim-cache'],
    ['metro-cache', settings.metroCacheMaxGb, 'would-trim-cache'],
    ['compilation-cache', settings.swiftCompilationCacheMaxGb, 'would-empty-cache'],
  ] as const;
  for (const [category, capGb, kind] of caps) {
    const entries = sizes.filter((size) => size.category === category);
    const total = entries.reduce((sum, size) => sum + size.bytes, 0);
    const cap = capGb * 1024 ** 3;
    if (cap === 0 || total <= cap) continue;
    let remaining = total;
    const targetBytes = (cap * settings.capTargetPercent) / 100;
    const why = `${category} ${(total / 1024 ** 3).toFixed(1)}G over the ${capGb}G cap; target ${(targetBytes / 1024 ** 3).toFixed(1)}G`;
    for (const size of entries.toSorted((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0))) {
      if (remaining <= targetBytes) break;
      const kept = size.workspace === protectedRoot ? 'the triggering workspace is protected' : size.blocked;
      if (kept) {
        skips.push({
          target: size.dir,
          reason: kept,
          ...(size.workspace ? { workspace: size.workspace } : {}),
        });
        continue;
      }
      const bytes = kind === 'would-trim-cache' ? Math.min(size.bytes, remaining - targetBytes) : size.bytes;
      add({
        kind,
        target: size.workspace ?? size.dir,
        bytes,
        reason: `${!size.workspace || size.idleDays == null ? '' : `idle ${size.idleDays} days, `}${why}`,
        ...(size.workspace ? { workspace: size.workspace } : {}),
      });
      remaining -= bytes;
    }
    if (remaining > targetBytes) blocked.push(`${why}; eligible targets cannot reach the target`);
  }
  if (pressure?.memory.pressured)
    skips.push({
      target: 'memory',
      reason: 'memory pressure observed; stopping helpers and idle workspaces is not active in report-only mode',
    });
  return { actions, blocked, skips };
}
