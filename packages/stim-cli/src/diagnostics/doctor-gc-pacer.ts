import { daemonNdjsonFile, gcLogFile, type DaemonStatus } from '@stim-cli/core/state';
import { diskPacerVolumes } from '../daemon/pacer.ts';
import type { Finding } from './doctor.ts';

const HOUR_MS = 60 * 60_000;

export function diskPacerFindings(status: DaemonStatus, now: number = Date.now()): Finding[] {
  if (status.mode !== 'on' || !status.running || status.unanswered) return [];
  const freshnessMs = 2 * Math.max(status.intervalMs ?? 60_000, 60_000);
  return diskPacerVolumes(status.diskPacer).flatMap((volume) => {
    const episode = volume.predictive;
    if (
      !episode ||
      volume.fillMbPerSecond === null ||
      volume.fillMbPerSecond <= 0 ||
      now - episode.since < HOUR_MS ||
      episode.checkedAt > now ||
      now - episode.checkedAt > freshnessMs ||
      episode.freeMb >= episode.targetFreeMb
    )
      return [];
    return [
      {
        level: 'cost' as const,
        title: `predictive cleanup has not cleared its target on ${volume.volume}`,
        detail: `Admitted cleanup since ${new Date(episode.since).toISOString()} still measured ${(episode.freeMb / 1024).toFixed(1)} GB free below its ${(episode.targetFreeMb / 1024).toFixed(1)} GB target at ${new Date(episode.checkedAt).toISOString()}; the volume was filling at ${((volume.fillMbPerSecond * 60) / 1024).toFixed(2)} GB/min.`,
        fix: `Inspect ${gcLogFile()} and ${daemonNdjsonFile()} for kept or failed cleanup, and release space on that volume.`,
      },
    ];
  });
}
