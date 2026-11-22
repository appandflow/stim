import { isJsonObject, type DiskPacerVolume, type PressureLevel } from '@stim-cli/core/state';

const MINUTE_MS = 60_000;
export const PREDICTION_WINDOW_MS: number = 5 * MINUTE_MS;

type Sample = { at: number; freeMb: number };
interface Volume {
  samples: Sample[];
  level: PressureLevel;
  firstFreeMs?: number;
  predictive?: { since: number; targetFreeMb: number; lastAttemptAt: number; checkedAt: number; freeMb: number };
}
export interface FirstFreeObserver {
  pending(device: number): boolean;
  observed(device: number, at: number): void;
}

interface PacerTarget {
  device: number;
  fillMbPerMs: number;
  leadTimeMs: number;
  freeMb: number;
}

function fillRate(samples: readonly Sample[]): number | null {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.at <= first.at) return null;
  const at = Math.max(first.at, last.at - PREDICTION_WINDOW_MS);
  const next = samples[1];
  const freeMb =
    next && at > first.at
      ? first.freeMb + ((next.freeMb - first.freeMb) * (at - first.at)) / (next.at - first.at)
      : first.freeMb;
  return Math.max(0, (freeMb - last.freeMb) / (last.at - at));
}

export interface DiskPacer {
  observe(
    readings: readonly { device?: number; freeMb: number; level: PressureLevel }[],
    at: number,
  ): { device: number; fillMbPerMs: number | null }[];
  recordFirstFree(device: number, startedAt: number, observedAt: number): void;
  recordPredictive(device: number, freeMb: number, targetFreeMb: number, admittedAt: number, checkedAt?: number): void;
  endPredictive(device?: number): void;
  status(): Omit<DiskPacerVolume, 'volume'>[];
  targets(minFreeMb: number, tickMs: number): PacerTarget[];
}

export function createDiskPacer(): DiskPacer {
  const volumes = new Map<number, Volume>();
  return {
    observe(readings: readonly { device?: number; freeMb: number; level: PressureLevel }[], at: number) {
      const present = new Set(readings.flatMap(({ device }) => (device === undefined ? [] : [device])));
      for (const device of volumes.keys()) if (!present.has(device)) volumes.delete(device);
      return readings.flatMap(({ device, freeMb, level }) => {
        if (device === undefined) return [];
        let volume = volumes.get(device);
        if (!volume) volumes.set(device, (volume = { samples: [], level }));
        volume.level = level;
        while (volume.samples[1] && volume.samples[1].at <= at - PREDICTION_WINDOW_MS) volume.samples.shift();
        const last = volume.samples.at(-1);
        const sample = { at, freeMb };
        if (last && Math.floor(last.at / MINUTE_MS) === Math.floor(at / MINUTE_MS))
          volume.samples[volume.samples.length - 1] = sample;
        else volume.samples.push(sample);
        const rate = fillRate(volume.samples);
        if (
          level !== 'normal' ||
          rate === null ||
          rate <= 0 ||
          (volume.predictive && freeMb >= volume.predictive.targetFreeMb)
        )
          delete volume.predictive;
        if (volume.predictive) {
          volume.predictive.checkedAt = at;
          volume.predictive.freeMb = freeMb;
        }
        return [{ device, fillMbPerMs: fillRate(volume.samples) }];
      });
    },
    /** Records the first immediate positive same-device measurement after completed cleanup, once per sweep. */
    recordFirstFree(device: number, startedAt: number, observedAt: number): void {
      const volume = volumes.get(device);
      if (volume) volume.firstFreeMs = observedAt - startedAt;
    },
    recordPredictive(
      device: number,
      freeMb: number,
      targetFreeMb: number,
      admittedAt: number,
      checkedAt: number = admittedAt,
    ): void {
      const volume = volumes.get(device);
      if (!volume || volume.level !== 'normal' || freeMb >= targetFreeMb) return;
      if (volume.predictive && freeMb >= volume.predictive.targetFreeMb) delete volume.predictive;
      if (!volume.predictive)
        volume.predictive = { since: admittedAt, targetFreeMb, lastAttemptAt: admittedAt, checkedAt, freeMb };
      else Object.assign(volume.predictive, { lastAttemptAt: admittedAt, checkedAt, freeMb });
    },
    endPredictive(device?: number): void {
      for (const [key, volume] of volumes) if (device === undefined || key === device) delete volume.predictive;
    },
    status() {
      return [...volumes].flatMap(([device, volume]) => {
        const sample = volume.samples.at(-1);
        if (!sample) return [];
        const rate = fillRate(volume.samples);
        return [
          {
            device,
            observedAt: sample.at,
            freeMb: sample.freeMb,
            fillMbPerSecond: rate === null ? null : rate * 1000,
            firstFreeMs: volume.firstFreeMs ?? null,
            ...(volume.predictive ? { predictive: { ...volume.predictive } } : {}),
          },
        ];
      });
    },
    targets(minFreeMb: number, tickMs: number): PacerTarget[] {
      if (minFreeMb <= 0) {
        for (const volume of volumes.values()) delete volume.predictive;
        return [];
      }
      const targets: PacerTarget[] = [];
      for (const [device, volume] of volumes) {
        if (volume.level !== 'normal') {
          delete volume.predictive;
          continue;
        }
        const rate = fillRate(volume.samples);
        const sample = volume.samples.at(-1);
        if (!sample || rate === null || rate <= 0 || sample.at - (volume.samples[0]?.at ?? sample.at) < MINUTE_MS) {
          delete volume.predictive;
          continue;
        }
        const leadTimeMs = (volume.firstFreeMs ?? 0) + tickMs;
        const freeMb = minFreeMb + rate * leadTimeMs;
        if (sample.freeMb < freeMb) targets.push({ device, fillMbPerMs: rate, leadTimeMs, freeMb });
        else delete volume.predictive;
      }
      return targets;
    },
  };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function diskPacerVolumes(value: unknown): DiskPacerVolume[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is DiskPacerVolume => {
    if (
      !isJsonObject(entry) ||
      !finite(entry.device) ||
      typeof entry.volume !== 'string' ||
      !finite(entry.observedAt) ||
      !finite(entry.freeMb) ||
      !(entry.fillMbPerSecond === null || (finite(entry.fillMbPerSecond) && entry.fillMbPerSecond >= 0)) ||
      !(entry.firstFreeMs === null || (finite(entry.firstFreeMs) && entry.firstFreeMs >= 0))
    )
      return false;
    const episode = entry.predictive;
    return (
      episode === undefined ||
      (isJsonObject(episode) &&
        finite(episode.since) &&
        finite(episode.targetFreeMb) &&
        finite(episode.lastAttemptAt) &&
        finite(episode.checkedAt) &&
        finite(episode.freeMb) &&
        episode.since <= episode.lastAttemptAt &&
        episode.lastAttemptAt <= episode.checkedAt)
    );
  });
}
