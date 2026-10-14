import type { DiskPressureLevel, MaintenanceAction, MaintenancePressure } from '@stim-cli/core/state';
import type { Budget } from '../budget.ts';
import type { MaintenanceSettings } from './settings.ts';

type LevelSettings = Pick<MaintenanceSettings, 'urgentFreeDiskGb' | 'criticalFreeDiskGb'>;

/**
 * The free-disk floor of each level in MiB. Level 2 has no floor of its own: it runs when level 1 left free disk
 * under the budget floor, and stops once free disk is back above it. Its urgent threshold only sets the reported level.
 */
export function levelFloors(
  budget: Pick<Budget, 'minFreeDiskMb' | 'hardFloorDiskMb'>,
  settings: LevelSettings,
): { 1: number; 2: number; 3: number; urgent: number } {
  const floor = Math.max(budget.minFreeDiskMb, budget.hardFloorDiskMb);
  return {
    1: floor,
    2: floor,
    3: Math.max(settings.criticalFreeDiskGb * 1024, budget.hardFloorDiskMb),
    urgent: settings.urgentFreeDiskGb * 1024,
  };
}

export function diskPressureLevel(
  freeMb: number,
  budget: Pick<Budget, 'minFreeDiskMb' | 'hardFloorDiskMb'>,
  settings: LevelSettings,
): DiskPressureLevel {
  const floors = levelFloors(budget, settings);
  if (freeMb < floors[3]) return 3;
  if (freeMb < floors.urgent) return 2;
  return freeMb < floors[1] ? 1 : 0;
}

export function lowestFree(disk: MaintenancePressure['disk']): number {
  return disk.length ? Math.min(...disk.map((volume) => volume.freeMb)) : Infinity;
}

/** Whether an action planned at a pressure level may still run with this much free disk. */
export function levelStillShort(
  action: Pick<MaintenanceAction, 'level'>,
  freeMb: number,
  budget: Pick<Budget, 'minFreeDiskMb' | 'hardFloorDiskMb'>,
  settings: LevelSettings,
): boolean {
  return action.level === undefined || freeMb < levelFloors(budget, settings)[action.level];
}

/** The protection window in milliseconds: protectRecentHours, or maintenance.pressureProtectMinutes for actions of level 2 and 3. */
export function protectWindowMs(
  action: Pick<MaintenanceAction, 'level'>,
  settings: Pick<MaintenanceSettings, 'protectRecentHours' | 'pressureProtectMinutes'>,
): number {
  return action.level === undefined
    ? settings.protectRecentHours * 3_600_000
    : settings.pressureProtectMinutes * 60_000;
}
