import { assignSlotDevice, deviceSlotPlatforms, removeSlotDevice } from './device-slots.ts';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ensureConfig,
  getConfigDir,
  getConfigPath,
  loadConfig,
  saveConfig,
  withConfigLock,
} from '../workspace/config.ts';
import { clearClaimChild, markClaimChildPending, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import type { Config, DeviceRecord } from '@stim-cli/core/state';

export type PoolPlatform = 'ios' | 'android';

interface ParkedRecord {
  udid: string;
  name: string;
  parkedAt: string;
  deletionClaim?: unknown;
}

export interface ParkedSim extends ParkedRecord {
  deviceTypeIdentifier: string;
  runtimeIdentifier: string;
  simslimManaged: boolean;
  bundleId?: string;
  cacheKey?: string;
}

export interface ParkedAvd extends ParkedRecord {
  systemImage: string;
  configuration: string;
}

type PoolRecords = { ios: ParkedSim; android: ParkedAvd };

export const DEFAULT_PARKED_MAX = 3;

export const POOL_SETTING_REMEDY: string =
  'Run `stim guide settings` for the device pool bounds and where it can be set.';

const MAX_SETTING: Record<PoolPlatform, { key: string; env: string }> = {
  ios: { key: 'iosParkedMax', env: 'STIM_POOL_IOS_PARKED_MAX' },
  android: { key: 'androidParkedMax', env: 'STIM_POOL_ANDROID_PARKED_MAX' },
};

export interface ParkedMax {
  max: number;
  error: string | null;
}

function parseMax(raw: unknown, strings: boolean): number | null {
  const value = strings && typeof raw === 'string' ? (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

export function parkedMaxSetting(
  platform: PoolPlatform,
  { config, env = process.env }: { config?: Config | null; env?: NodeJS.ProcessEnv } = {},
): ParkedMax {
  const { key, env: envKey } = MAX_SETTING[platform];
  const fromEnv = env[envKey];
  const explicit = fromEnv !== undefined && fromEnv !== '';
  const cfg = config === undefined ? loadConfig() : config;
  const pool = cfg?.pool;
  if (!explicit && pool !== undefined && (pool === null || typeof pool !== 'object' || Array.isArray(pool))) {
    return { max: 0, error: 'Invalid pool value. Expected an object with simulator and emulator bounds.' };
  }
  const fromConfig =
    pool !== null && typeof pool === 'object' && !Array.isArray(pool)
      ? (pool as Record<string, unknown>)[key]
      : undefined;
  const raw = explicit ? fromEnv : fromConfig;
  if (raw === undefined) return { max: env.STIM_HOME ? 0 : DEFAULT_PARKED_MAX, error: null };
  const parsed = parseMax(raw, explicit);
  if (parsed === null) {
    return {
      max: 0,
      error: `Invalid ${explicit ? envKey : `pool.${key}`} value ${JSON.stringify(raw)}. Expected a whole number of parked ${platform === 'ios' ? 'simulators' : 'emulators'}, 0 or more.`,
    };
  }
  return { max: explicit ? parsed : env.STIM_HOME ? 0 : parsed, error: null };
}

function isParkedRecord(value: unknown, platform: PoolPlatform): value is PoolRecords[PoolPlatform] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.udid === 'string' &&
    typeof record.name === 'string' &&
    record.name.startsWith('stim-') &&
    typeof record.parkedAt === 'string' &&
    (platform === 'android'
      ? record.udid === record.name &&
        /^stim-[A-Za-z0-9._-]+$/.test(record.name) &&
        typeof record.systemImage === 'string' &&
        typeof record.configuration === 'string'
      : typeof record.deviceTypeIdentifier === 'string' &&
        typeof record.runtimeIdentifier === 'string' &&
        typeof record.simslimManaged === 'boolean' &&
        (record.bundleId === undefined || typeof record.bundleId === 'string') &&
        (record.cacheKey === undefined || typeof record.cacheKey === 'string'))
  );
}

function poolBlock(config: Config | null): { [P in PoolPlatform]: PoolRecords[P][] } {
  const raw = config?.parked;
  const block = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const read = <P extends PoolPlatform>(platform: P): PoolRecords[P][] => {
    const list = block[platform];
    return Array.isArray(list)
      ? list.filter((record): record is PoolRecords[P] => isParkedRecord(record, platform))
      : [];
  };
  return { ios: read('ios'), android: read('android') };
}

export function readParked<P extends PoolPlatform>(
  platform: P,
  { config }: { config?: Config | null } = {},
): PoolRecords[P][] {
  return poolBlock(config === undefined ? loadConfig() : config)[platform];
}

function writeParked<P extends PoolPlatform>(config: Config, platform: P, records: PoolRecords[P][]): void {
  const block = poolBlock(config);
  config.parked = { ...block, [platform]: records };
}

function oldestFirst<T extends ParkedRecord>(records: readonly T[]): T[] {
  return records.toSorted((a, b) => String(a.parkedAt).localeCompare(String(b.parkedAt)));
}

export function isLegacyDeletionClaim(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
  const marker = value as { kind?: unknown; claimId?: unknown };
  return marker.kind !== 'ownership-claim' || typeof marker.claimId !== 'string' || marker.claimId.length === 0;
}

export function selectParked(
  records: readonly ParkedSim[],
  { deviceTypeIdentifier, runtimeIdentifier }: { deviceTypeIdentifier: string; runtimeIdentifier: string },
): ParkedSim[] {
  return oldestFirst(
    records.filter(
      (r) =>
        !isLegacyDeletionClaim(r.deletionClaim) &&
        r.deviceTypeIdentifier === deviceTypeIdentifier &&
        r.runtimeIdentifier === runtimeIdentifier,
    ),
  );
}

export function evictOverflow<T extends ParkedRecord>(records: readonly T[], max: number): { keep: T[]; evicted: T[] } {
  if (records.length <= max) return { keep: [...records], evicted: [] };
  const ordered = oldestFirst(records);
  const evicted = ordered.slice(0, ordered.length - max);
  const dropped = new Set(evicted.map((r) => r.udid));
  return { keep: records.filter((r) => !dropped.has(r.udid)), evicted };
}

export function parkSim<P extends PoolPlatform>({
  platform,
  projectPath,
  slot = 'default',
  record,
  max,
}: {
  platform: P;
  projectPath: string;
  slot?: string;
  record: PoolRecords[P];
  max: number;
}): PoolRecords[P][] {
  return withConfigLock(() => {
    const cfg = ensureConfig();
    const current = deviceSlotPlatforms(cfg.projects[projectPath], slot)?.[platform];
    const currentId = platform === 'ios' ? current?.deviceUdid : current?.avdName;
    if (!current?.owned || currentId !== record.udid)
      throw new Error(`The ${platform === 'ios' ? 'simulator' : 'emulator'} assignment changed before parking.`);
    const kept = readParked(platform, { config: cfg }).filter((r) => r.udid !== record.udid);
    const { keep, evicted } = evictOverflow([...kept, record], max);
    writeParked(cfg, platform, [...keep, ...evicted]);
    const project = cfg.projects[projectPath];
    if (project) removeSlotDevice(project, platform, slot);
    saveConfig(cfg);
    return evicted;
  });
}

export function adoptParked<P extends PoolPlatform>({
  platform,
  projectPath,
  slot = 'default',
  udid,
  device,
}: {
  platform: P;
  projectPath: string;
  slot?: string;
  udid: string;
  device: DeviceRecord;
}): PoolRecords[P] | null {
  const claim = claimParkedOperation(platform, udid);
  if (!claim) return null;
  try {
    return withConfigLock(() => {
      const cfg = ensureConfig();
      const records = readParked(platform, { config: cfg });
      const taken = records.find((r) => r.udid === udid);
      if (!taken || isLegacyDeletionClaim(taken.deletionClaim)) return null;
      if (deviceSlotPlatforms(cfg.projects[projectPath], slot)?.[platform]) return null;
      writeParked(
        cfg,
        platform,
        records.filter((r) => r.udid !== udid),
      );
      const project = cfg.projects[projectPath];
      if (!project) throw new Error(`Project not registered: ${projectPath}`);
      assignSlotDevice(project, platform, device, slot);
      saveConfig(cfg);
      const adopted = { ...taken };
      delete adopted.deletionClaim;
      return adopted;
    });
  } finally {
    releaseClaim(claim);
  }
}

function claimParkedOperation(platform: PoolPlatform, udid: string) {
  const attempt = tryAcquireClaim({
    root: join(getConfigDir(), 'pool-locks', platform, `${encodeURIComponent(udid.toLowerCase())}.lock`),
    mode: 'exclusive',
    label: `parked ${platform} device ${udid}`,
  });
  if (attempt.pending) releaseClaim(attempt.pending);
  return attempt.acquired ?? null;
}

export function removeParkedAfter<P extends PoolPlatform>(
  platform: P,
  udid: string,
  beforeRemove: (record: PoolRecords[P]) => void,
): PoolRecords[P] | null {
  const claim = claimParkedOperation(platform, udid);
  if (!claim) return null;
  try {
    const claimed = withConfigLock(() => {
      const cfg = loadConfig();
      if (!cfg) return null;
      const records = readParked(platform, { config: cfg });
      const current = records.find((candidate) => candidate.udid === udid);
      if (!current) return null;
      if (isLegacyDeletionClaim(current.deletionClaim)) {
        throw new Error(
          `Parked ${platform} device ${udid} has a legacy deletionClaim in ${getConfigPath()}. ` +
            'Its PID does not establish whether the original operation finished. Keep the device and pool record; after verifying that ' +
            "neither the old Stim process nor its native child is using it, remove only that record's deletionClaim field and retry.",
        );
      }
      const record = { ...current };
      delete record.deletionClaim;
      // Older CLIs reject non-PID markers: https://github.com/appandflow/stim/issues/836.
      const marked = { ...record, deletionClaim: { kind: 'ownership-claim', claimId: claim.claimId } };
      writeParked(
        cfg,
        platform,
        records.map((candidate) => (candidate.udid === udid ? marked : candidate)),
      );
      saveConfig(cfg);
      return { record, marked };
    });
    if (!claimed) return null;
    let completed = false;
    let removed: PoolRecords[P] | null = null;
    try {
      markClaimChildPending(claim);
      try {
        beforeRemove(claimed.record);
      } finally {
        clearClaimChild(claim);
      }
      completed = true;
    } finally {
      withConfigLock(() => {
        const cfg = loadConfig();
        if (!cfg) return;
        const records = readParked(platform, { config: cfg });
        const current = records.find((candidate) => candidate.udid === udid);
        if (!isDeepStrictEqual(current, claimed.marked)) return;
        writeParked(
          cfg,
          platform,
          completed
            ? records.filter((candidate) => candidate.udid !== udid)
            : records.map((candidate) => (candidate.udid === udid ? claimed.record : candidate)),
        );
        saveConfig(cfg);
        if (completed) removed = claimed.record;
      });
    }
    return removed;
  } finally {
    releaseClaim(claim);
  }
}

export function dropParked(platform: PoolPlatform, udid: string): boolean {
  return removeParkedAfter(platform, udid, () => {}) !== null;
}
