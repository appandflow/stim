import { basename, sep } from 'node:path';
import { LAST_BUILD_KEYS } from '@stim-cli/core/state';
import { listBuildLocks } from '../engine/build-lock.ts';
import { readParked } from '../devices/sim-pool.ts';
import { metroStoreRoot } from '../supervisor/metro-store.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { loadConfig, type Config } from '../workspace/config.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { readWorkspaceState, workspaceLastUsed } from '../workspace/workspace-state.ts';
import type { MaintenanceSettings } from './settings.ts';

const BUILD_RECORDS = ['lastBuild', ...Object.values(LAST_BUILD_KEYS)];

function recordKeys(record: unknown): string[] {
  if (record === null || typeof record !== 'object') return [];
  const value = record as { cacheKey?: unknown; missReason?: { baseline?: { cacheKey?: unknown } | null } };
  return [value.cacheKey, value.missReason?.baseline?.cacheKey].filter((key): key is string => typeof key === 'string');
}

function protectedCacheKeys(config: Config | null = loadConfig()): Set<string> {
  const keys = new Set<string>();
  for (const root of Object.keys(config?.projects ?? {})) {
    const state = readWorkspaceState(root) as Record<string, unknown> | null;
    for (const name of BUILD_RECORDS) for (const key of recordKeys(state?.[name])) keys.add(key);
  }
  for (const platform of ['ios', 'android'] as const)
    for (const record of readParked(platform, { config })) if (record.cacheKey) keys.add(record.cacheKey);
  for (const lock of listBuildLocks()) if ((lock.alive || lock.unresolved) && lock.key) keys.add(lock.key);
  return keys;
}

function liveMetroStores(config: Config | null = loadConfig()): string[] {
  return Object.keys(config?.projects ?? {})
    .filter((root) => workspaceInUse(root, { managedLocks: false, hosted: false, nativeRun: false }).length > 0)
    .map((root) => canonicalPath(metroStoreRoot(root)));
}

export function cacheEntryProtection(config: Config | null = loadConfig()): (entry: string) => string | null {
  try {
    const keys = protectedCacheKeys(config);
    const stores = liveMetroStores(config);
    return (entry) => {
      if (keys.has(basename(entry))) return 'a project, parked device or running build still uses this build';
      const path = canonicalPath(entry);
      if (stores.some((store) => path === store || path.startsWith(`${store}${sep}`)))
        return 'its project has a running or unverifiable dev server';
      return null;
    };
  } catch (error) {
    const reason = `cache protection could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return () => reason;
  }
}

export function recentUse(workspace: string, settings: Pick<MaintenanceSettings, 'protectRecentHours'>): string | null {
  const since = Date.now() - workspaceLastUsed(workspace);
  return Number.isFinite(since) && since < settings.protectRecentHours * 3_600_000
    ? `used within the last ${settings.protectRecentHours} hours`
    : null;
}
