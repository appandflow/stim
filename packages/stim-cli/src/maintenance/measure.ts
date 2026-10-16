import { existsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { configDir, metroCacheRoot, buildCacheRoot, type StimContext } from '@stim-cli/core';
import {
  buildWorkerRoot,
  loadConfig,
  sharedCcache,
  sharedCompilationCache,
  type DiskPressureLevel,
  type MaintenancePressure,
  type MaintenanceSize,
} from '@stim-cli/core/state';
import { readVolumeSpace, readVolumeSpaceAsync, resolveBudget } from '../budget.ts';
import { measuredDirectorySizeAsync } from '../fs-util.ts';
import { readHostMemoryPressure, readHostMemoryPressureAsync, type HostMemoryPressure } from '../host-memory.ts';
import { discoverCaches, type CacheDescriptor } from '../cache/caches.ts';
import { planCacheEmptying } from '../commands/gc/caches.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { cacheUser } from '../cache/cache-claim.ts';
import { diskPressureLevel, lowestFree } from './pressure.ts';
import { resolveMaintenanceSettings, type MaintenanceSettings } from './settings.ts';

export function measureDisk(): MaintenancePressure['disk'] {
  return readVolumeSpace([configDir(), ...Object.keys(loadConfig()?.projects ?? {}), buildWorkerRoot(loadConfig())]);
}

/** The disk pressure level of the fullest volume Stim writes to, measured now. */
export function currentDiskLevel(): DiskPressureLevel {
  return diskPressureLevel(lowestFree(measureDisk()), resolveBudget().budget, resolveMaintenanceSettings());
}

export function measurePressure(
  settings: MaintenanceSettings,
  previous: MaintenancePressure | null,
  now: number,
): MaintenancePressure {
  return pressureFromObservations(settings, previous, now, readHostMemoryPressure(), measureDisk());
}

export async function measurePressureAsync(
  settings: MaintenanceSettings,
  previous: MaintenancePressure | null,
  now: number,
  operation: StimContext,
): Promise<MaintenancePressure> {
  const level = await readHostMemoryPressureAsync();
  const disk = await readVolumeSpaceAsync(
    [configDir(), ...Object.keys(loadConfig()?.projects ?? {}), buildWorkerRoot(loadConfig())],
    operation.signal,
  );
  return pressureFromObservations(settings, previous, now, level, disk);
}

function pressureFromObservations(
  settings: MaintenanceSettings,
  previous: MaintenancePressure | null,
  now: number,
  level: HostMemoryPressure | null,
  disk: MaintenancePressure['disk'],
): MaintenancePressure {
  const availableBytes = process.platform === 'darwin' ? null : freemem();
  const warningSince = level === 'warning' ? (previous?.warningSince ?? now) : null;
  const pressured =
    settings.memoryPressureLevel !== 'off' &&
    (level === 'critical' ||
      (settings.memoryPressureLevel === 'warning' &&
        warningSince !== null &&
        now - warningSince >= settings.memoryWarningMinutes * 60_000) ||
      (availableBytes !== null &&
        availableBytes <
          (settings.minAvailableMemoryGb === undefined
            ? totalmem() * 0.1
            : settings.minAvailableMemoryGb * 1024 ** 3)));
  return {
    disk,
    memory: { level, availableBytes, pressured },
    warningSince,
  };
}

export function sizeScanDeferred(settings: MaintenanceSettings): boolean {
  return loadavg()[0]! / Math.max(1, cpus().length) > settings.maxLoadPerCore;
}

export function cacheBlocked(
  entry: Pick<MaintenanceSize, 'name' | 'dir' | 'category'>,
  discovered: CacheDescriptor[] = discoverCaches(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    planCacheEmptying(
      [
        {
          ...entry,
          note: '',
          prune: 'entries',
          ...(discovered.some(
            (cache) => canonicalPath(cache.dir) === canonicalPath(entry.dir) && cache.source === 'registered',
          )
            ? { source: 'registered' as const }
            : {}),
        },
      ],
      false,
      env,
    )[0]?.machineGlobal ?? (entry.category === 'compilation-cache' ? cacheUser(entry.dir) : undefined)
  );
}

export async function measureSizes(
  now: number,
  failure: (target: string, workspace?: string) => void,
): Promise<MaintenanceSize[]> {
  const sizes: MaintenanceSize[] = [];
  const outputs = await collectWorkspaceOutputs({
    olderThan: null,
    now,
    sizeTimeoutMs: 120_000,
  });
  for (const entry of outputs.workspaces) {
    if (entry.bytes === null) {
      failure(entry.dir, entry.projectRoot ?? undefined);
      continue;
    }
    sizes.push({
      name: 'workspace build outputs',
      category: 'workspace-outputs',
      dir: entry.dir,
      bytes: entry.bytes,
      measuredAt: now,
      ...(entry.projectRoot ? { workspace: canonicalPath(entry.projectRoot) } : {}),
      idleDays: entry.idleDays,
      ...(!entry.willClear ? { blocked: entry.keptReason ?? 'workspace ownership is unresolved' } : {}),
    });
  }
  const known: {
    name: string;
    dir: string;
    category: MaintenanceSize['category'];
    blocked?: string;
  }[] = [
    {
      name: 'shared build cache',
      dir: buildCacheRoot(),
      category: 'build-cache',
    },
    {
      name: 'Metro transform caches',
      dir: metroCacheRoot(),
      category: 'metro-cache',
    },
    { name: 'ccache', dir: sharedCcache(), category: 'ccache' },
    {
      name: 'Swift compilation cache',
      dir: sharedCompilationCache(),
      category: 'compilation-cache',
    },
  ];
  const discovered = discoverCaches();
  for (const cache of discovered) {
    if (cache.source !== 'registered' && !canonicalPath(cache.dir).startsWith(`${canonicalPath(configDir())}/`))
      continue;
    if (cache.prune === 'report-only') continue;
    const dir = canonicalPath(cache.dir);
    if (known.some((item) => dir === canonicalPath(item.dir) || dir.startsWith(`${canonicalPath(item.dir)}/`)))
      continue;
    const category = cache.name.startsWith('Metro transform cache')
      ? 'metro-cache'
      : /^(Expo build cache|native build cache|Build cache)$/.test(cache.name)
        ? 'build-cache'
        : 'other';
    known.push({ name: cache.name, dir: cache.dir, category });
  }
  for (const entry of known) {
    if (!existsSync(entry.dir)) continue;
    const bytes = await measuredDirectorySizeAsync(entry.dir, { timeoutMs: 120_000 });
    if (bytes === null) {
      failure(entry.dir);
      continue;
    }
    const blocked = cacheBlocked(entry, discovered);
    sizes.push({
      ...entry,
      bytes,
      measuredAt: now,
      ...(blocked ? { blocked } : {}),
    });
  }
  return sizes;
}
