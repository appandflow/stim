import { basename, sep } from 'node:path';
import { LAST_BUILD_KEYS, readBuildHistory } from '@stim-cli/core/state';
import { listBuildLocks } from '../engine/build-lock.ts';
import { readParked } from '../devices/sim-pool.ts';
import { metroStoreRoot } from '../supervisor/metro-store.ts';
import { readWorkspaceLaunches } from '../supervisor/state.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { loadConfig, type Config } from '../workspace/config.ts';
import { workspaceInUse, workspaceInUseAsync } from '../workspace/in-use.ts';
import { readWorkspaceState, workspaceLastUsed } from '../workspace/workspace-state.ts';
import { maintenanceKeepSetting, resolveProjectSettings, resolveProjectSettingsAsync } from '../workspace/settings.ts';
import type { StimContext } from '@stim-cli/core';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
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
    for (const entries of Object.values(readBuildHistory(state))) {
      const key = entries.find((entry) => entry.result === 'succeeded')?.cacheKey;
      if (key) keys.add(key);
    }
    for (const launch of Object.values(readWorkspaceLaunches(root)))
      if (launch.artifact?.cacheKey) keys.add(launch.artifact.cacheKey);
  }
  for (const platform of ['ios', 'android'] as const)
    for (const record of readParked(platform, { config })) if (record.cacheKey) keys.add(record.cacheKey);
  for (const lock of listBuildLocks()) if ((lock.alive || lock.unresolved) && lock.key) keys.add(lock.key);
  return keys;
}

const STORE_CHECKS = { managedLocks: false, hosted: false, nativeRun: false } as const;

function liveMetroStores(config: Config | null = loadConfig()): string[] {
  return Object.keys(config?.projects ?? {})
    .filter((root) => workspaceInUse(root, STORE_CHECKS).length > 0)
    .map((root) => canonicalPath(metroStoreRoot(root)));
}

async function liveMetroStoresAsync(config: Config | null, operation: StimContext): Promise<string[]> {
  const stores: string[] = [];
  for (const root of Object.keys(config?.projects ?? {}))
    if ((await workspaceInUseAsync(root, STORE_CHECKS, operation.signal, operation)).length > 0)
      stores.push(canonicalPath(metroStoreRoot(root)));
  return stores;
}

export function cacheEntryProtection(config: Config | null = loadConfig()): (entry: string) => string | null {
  return entryProtection(config, () => liveMetroStores(config));
}

/** `cacheEntryProtection`, read without blocking when an operation is given. */
export async function cacheEntryProtectionFor(
  config: Config | null,
  operation: StimContext | undefined,
): Promise<(entry: string) => string | null> {
  if (!operation) return cacheEntryProtection(config);
  let stores: string[] | Error;
  try {
    stores = await liveMetroStoresAsync(config, operation);
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    stores = error instanceof Error ? error : new Error(String(error));
  }
  return entryProtection(config, () => {
    if (stores instanceof Error) throw stores;
    return stores;
  });
}

function entryProtection(config: Config | null, liveStores: () => string[]): (entry: string) => string | null {
  try {
    const keys = protectedCacheKeys(config);
    const stores = liveStores();
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

export function maintenancePinned(root: string): boolean {
  try {
    return maintenanceKeepSetting(resolveProjectSettings(root).settings);
  } catch {
    return true;
  }
}

export async function maintenancePinnedAsync(root: string, operation: StimContext): Promise<boolean> {
  try {
    return maintenanceKeepSetting(
      (await resolveProjectSettingsAsync(root, { env: operation.env, signal: operation.signal, declareFor: operation }))
        .settings,
    );
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation.signal.throwIfAborted();
    return true;
  }
}

/** `maintenancePinned`, read without blocking when an operation is given. */
export function maintenancePinnedReader(
  operation: StimContext | undefined,
): (root: string) => boolean | Promise<boolean> {
  return operation ? (root) => maintenancePinnedAsync(root, operation) : maintenancePinned;
}

export function recentUse(
  workspace: string,
  settings: Pick<MaintenanceSettings, 'protectRecentHours'>,
  windowMs: number = settings.protectRecentHours * 3_600_000,
): string | null {
  const since = Date.now() - workspaceLastUsed(workspace);
  if (!Number.isFinite(since) || since >= windowMs) return null;
  return windowMs < 3_600_000
    ? `used within the last ${Math.round(windowMs / 60_000)} minutes`
    : `used within the last ${windowMs / 3_600_000} hours`;
}
