import type { DaemonMeasurement, DaemonPressure, PressureLevel } from '@stim-cli/core/state';
import { machineNumber } from '../machine-number.ts';
import type { Config } from '../workspace/config.ts';

const GIB = 1024 ** 3;
const MEMORY_WARNING_MS = 10 * 60_000;
const LOW_MEMORY_SHARE = 0.1;
const RANK: Record<PressureLevel, number> = { normal: 0, high: 1, critical: 2 };

export interface DiskThresholds {
  /** `disk.minFreeGb` in MiB: below it the disk level is high. */
  highMb: number;
  /** `disk.criticalFreeGb`, or the hard floor when that is higher, in MiB: below it the disk level is critical. */
  criticalMb: number;
  /** `disk.hardFloorGb` in MiB: below it after the ladder ran, start, ios and android refuse. */
  hardFloorMb: number;
}

/** The disk thresholds from the machine settings, or the first invalid one. */
export function diskThresholds(
  config: Config | null,
  env: NodeJS.ProcessEnv = process.env,
): { thresholds: DiskThresholds; error: string | null } {
  const high = machineNumber('disk.minFreeGb', config, env);
  const critical = machineNumber('disk.criticalFreeGb', config, env);
  const floor = machineNumber('disk.hardFloorGb', config, env);
  const hardFloorMb = (floor.value ?? 0) * 1024;
  return {
    thresholds: {
      highMb: (high.value ?? 0) * 1024,
      criticalMb: Math.max((critical.value ?? 0) * 1024, hardFloorMb),
      hardFloorMb,
    },
    error: high.error ?? critical.error ?? floor.error,
  };
}

function higherLevel(a: PressureLevel, b: PressureLevel): PressureLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

/** The disk level: critical under the critical threshold on any volume, high under `disk.minFreeGb`. */
export function diskPressure(
  disk: DaemonMeasurement['disk'],
  thresholds: DiskThresholds,
): { level: PressureLevel; reasons: string[] } {
  const reasons: string[] = [];
  let level: PressureLevel = 'normal';
  for (const volume of disk) {
    if (thresholds.criticalMb > 0 && volume.freeMb < thresholds.criticalMb) {
      level = 'critical';
      reasons.push(
        `${gb(volume.freeMb)} free on ${volume.volume}, under the ${gb(thresholds.criticalMb)} critical floor`,
      );
    } else if (thresholds.highMb > 0 && volume.freeMb < thresholds.highMb) {
      level = higherLevel(level, 'high');
      reasons.push(`${gb(volume.freeMb)} free on ${volume.volume}, under disk.minFreeGb (${gb(thresholds.highMb)})`);
    }
  }
  return { level, reasons };
}

/**
 * The memory level: critical while macOS reports critical pressure; high after 10 minutes of warning or while
 * available memory is under 10% of RAM. `previousWarningSince` carries the warning clock from the last measurement.
 */
export function memoryPressure(
  memory: DaemonMeasurement['memory'],
  previousWarningSince: string | null,
  now: number,
): { level: PressureLevel; reasons: string[]; warningSince: string | null } {
  const reasons: string[] = [];
  const pressured = memory.level === 'warning' || memory.level === 'critical';
  const since = Date.parse(previousWarningSince ?? '');
  const warningSince = pressured ? (Number.isFinite(since) ? since : now) : null;
  let level: PressureLevel = 'normal';
  if (memory.level === 'critical') {
    level = 'critical';
    reasons.push('macOS memory pressure is critical');
  } else if (memory.level === 'warning' && warningSince !== null && now - warningSince >= MEMORY_WARNING_MS) {
    level = 'high';
    reasons.push(`macOS memory pressure has been warning for ${Math.floor((now - warningSince) / 60_000)} minutes`);
  }
  if (
    level === 'normal' &&
    memory.availableBytes !== null &&
    memory.availableBytes < memory.totalBytes * LOW_MEMORY_SHARE
  ) {
    level = 'high';
    reasons.push(
      `${(memory.availableBytes / GIB).toFixed(1)} GB of ${(memory.totalBytes / GIB).toFixed(0)} GB memory available, under 10%`,
    );
  }
  return { level, reasons, warningSince: warningSince === null ? null : new Date(warningSince).toISOString() };
}

/** The machine's level for one measurement: the higher of the disk and memory levels. */
export function classifyPressure({
  disk,
  memory,
  thresholds,
  previousWarningSince,
  now,
}: {
  disk: DaemonMeasurement['disk'];
  memory: DaemonMeasurement['memory'];
  thresholds: DiskThresholds;
  previousWarningSince: string | null;
  now: number;
}): DaemonPressure {
  const onDisk = diskPressure(disk, thresholds);
  const inMemory = memoryPressure(memory, previousWarningSince, now);
  return {
    level: higherLevel(onDisk.level, inMemory.level),
    disk: onDisk.level,
    memory: inMemory.level,
    reasons: [...onDisk.reasons, ...inMemory.reasons],
    memoryWarningSince: inMemory.warningSince,
  };
}
