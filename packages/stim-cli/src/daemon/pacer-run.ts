import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { DiskPacerVolume } from '@stim-cli/core/state';
import { createDiskPacer } from './pacer.ts';
import { diskPressure, diskThresholds } from './pressure.ts';
import type { DiskPassInput, DiskPassResult, HomePasses } from './passes.ts';
import type { IdlePassInput } from './idle.ts';

export async function runDiskPacer({
  pacer,
  passes,
  intervalMs,
  act,
  diskPass,
  log,
}: {
  pacer: ReturnType<typeof createDiskPacer>;
  passes: HomePasses;
  intervalMs: number;
  act: boolean;
  diskPass?: (input: DiskPassInput) => Promise<DiskPassResult>;
  log: IdlePassInput['log'];
}): Promise<{ pressure: HomePasses['pressure']; intervalMs: number; status: DiskPacerVolume[] }> {
  const { config, measured, now, operation } = passes;
  const { thresholds } = diskThresholds(config, operation.env);
  pacer.observe(
    measured.measurement.disk.map((volume) => ({
      ...volume,
      level: diskPressure([volume], thresholds).level,
    })),
    now,
  );
  for (const point of passes.firstFree ?? []) pacer.recordFirstFree(point.device, point.startedAt, point.observedAt);
  let pressure = passes.pressure;
  if (passes.ladder || !act || !config || !diskPass || pressure.level !== 'normal') pacer.endPredictive();
  if (config && diskPass && pressure.level === 'normal') {
    for (const target of pacer.targets(thresholds.highMb, intervalMs)) {
      operation.signal.throwIfAborted();
      try {
        const result = await diskPass({
          act,
          pressure,
          devices: measured.devices,
          sims: measured.sims,
          requested: false,
          target: { device: target.device, freeMb: target.freeMb },
        });
        passes.actions.push(...result.actions);
        for (const point of result.firstFree ?? [])
          pacer.recordFirstFree(point.device, point.startedAt, point.observedAt);
        pressure = result.pressure;
        const attempt = result.predictive;
        if (pressure.level !== 'normal') {
          pacer.endPredictive();
          intervalMs = 0;
          break;
        }
        if (attempt?.admittedAt !== undefined && attempt.freeMb !== null && attempt.freeMb < attempt.targetFreeMb)
          pacer.recordPredictive(
            attempt.device,
            attempt.freeMb,
            attempt.targetFreeMb,
            attempt.admittedAt,
            attempt.checkedAt,
          );
        else pacer.endPredictive(target.device);
      } catch (error) {
        if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
        operation.signal.throwIfAborted();
        pacer.endPredictive(target.device);
        log(
          'warn',
          'pressure_ladder_failed',
          `predictive disk pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
  }
  const status = pacer.status().flatMap((entry) => {
    const volume = measured.measurement.disk.find(({ device }) => device === entry.device);
    return volume ? [{ ...entry, volume: volume.volume }] : [];
  });
  return { pressure, intervalMs, status };
}
