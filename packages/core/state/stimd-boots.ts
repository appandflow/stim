import { isJsonObject, readJsonObject } from './json-file.ts';
import { stimdRunDir } from './paths.ts';
import { join } from 'node:path';

const BOOT_WINDOW_MS = 10 * 60_000;
const BOOTS_KEPT = 20;
const ABNORMAL_KEPT = 10;
const CRASHES = 3;

/** One stimd start in a Stim home: when, from which build, and whether that stimd exited abnormally. */
export type Boot = {
  at: number;
  build: string;
  pid: number;
  abnormal?: true;
  /** Why the exit was abnormal, and when it was found out. */
  reason?: string;
  exitedAt?: number;
  /** For a fault of the Stim home rather than of the build: what to fix. Such a boot does not count toward a rollback. */
  home?: string;
};

/** `run/stimd-boots.json`: the boots of this home's stimds, written by stimd while it holds the home. */
export function stimdBootsFile(home?: string): string {
  return join(stimdRunDir(home), 'stimd-boots.json');
}

/** The boots in `stimd-boots.json`, as stimd recorded them. */
export function parseBoots(value: unknown): Boot[] {
  return (Array.isArray(value) ? value : []).flatMap((boot) => {
    if (!isJsonObject(boot) || typeof boot.at !== 'number' || typeof boot.build !== 'string') return [];
    const parsed: Boot = { at: boot.at, build: boot.build, pid: typeof boot.pid === 'number' ? boot.pid : 0 };
    if (boot.abnormal === true) parsed.abnormal = true;
    if (typeof boot.reason === 'string') parsed.reason = boot.reason;
    if (typeof boot.exitedAt === 'number') parsed.exitedAt = boot.exitedAt;
    if (typeof boot.home === 'string') parsed.home = boot.home;
    return [parsed];
  });
}

export function readStimdBoots(home?: string): Boot[] {
  return parseBoots(readJsonObject(stimdBootsFile(home))?.boots);
}

/**
 * The boots stimd keeps at `now`, oldest first: those of the last 10 minutes (at most 20) and the last 10 abnormal ones
 * of any age, which `stim status` lists.
 */
export function keptBoots(boots: readonly Boot[], now: number): Boot[] {
  const sorted = boots.filter((boot) => boot.at <= now).toSorted((a, b) => a.at - b.at);
  const recent = sorted.filter((boot) => now - boot.at < BOOT_WINDOW_MS).slice(-BOOTS_KEPT);
  const abnormal = sorted.filter((boot) => boot.abnormal).slice(-ABNORMAL_KEPT);
  return [...new Set([...abnormal, ...recent])].toSorted((a, b) => a.at - b.at);
}

/** The abnormal boots of `build` in the last 10 minutes at `now`, oldest first. */
const recentAbnormal = (boots: readonly Boot[], build: string, now: number): Boot[] =>
  boots
    .filter((boot) => boot.build === build && boot.abnormal && boot.at <= now && now - boot.at < BOOT_WINDOW_MS)
    .toSorted((a, b) => a.at - b.at);

/** What a crash-loop hold of one build is made of. */
export type CrashLoop = {
  build: string;
  /** The abnormal boots of the build in the last 10 minutes. */
  count: number;
  /** When the oldest boot that keeps the hold in force leaves the 10-minute window. */
  until: number;
  /** Whether three of them are not faults of the Stim home, which is what a rollback needs. */
  engineCaused: boolean;
  /** What to fix, for the newest boot that a fault of the Stim home ended. */
  home?: string;
  /** Why the newest of them ended. */
  reason?: string;
};

/** The crash loop of `build` at `now`: three abnormal boots of it among those of the last 10 minutes. */
export function crashLoop(boots: readonly Boot[], build: string, now: number): CrashLoop | null {
  const abnormal = recentAbnormal(boots, build, now);
  if (abnormal.length < CRASHES) return null;
  const homeFault = abnormal.findLast((boot) => boot.home);
  return {
    build,
    count: abnormal.length,
    until: (abnormal[abnormal.length - CRASHES]?.at ?? now) + BOOT_WINDOW_MS,
    engineCaused: abnormal.filter((boot) => !boot.home).length >= CRASHES,
    ...(homeFault?.home ? { home: homeFault.home } : {}),
    ...(abnormal.at(-1)?.reason ? { reason: abnormal.at(-1)?.reason } : {}),
  };
}

/** The crash loop of any build in `boots` at `now`, the one of the newest abnormal boot when several loop. */
export function anyCrashLoop(boots: readonly Boot[], now: number): CrashLoop | null {
  const builds = [...new Set(boots.toSorted((a, b) => b.at - a.at).map((boot) => boot.build))];
  return builds.flatMap((build) => crashLoop(boots, build, now) ?? [])[0] ?? null;
}

/** `run/successor-missing.json`: a handover whose successor never started, which the next client starts a stimd for at once. */
export function stimdSuccessorMissingFile(home?: string): string {
  return join(stimdRunDir(home), 'successor-missing.json');
}

export type SuccessorMissing = { at: number; pid: number; build: string; reason: string };

export function readSuccessorMissing(home?: string): SuccessorMissing | null {
  const record = readJsonObject(stimdSuccessorMissingFile(home));
  return record &&
    typeof record.at === 'number' &&
    typeof record.pid === 'number' &&
    typeof record.build === 'string' &&
    typeof record.reason === 'string'
    ? { at: record.at, pid: record.pid, build: record.build, reason: record.reason }
    : null;
}
