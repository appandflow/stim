import { existsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { configDir, metroCacheRoot, buildCacheRoot, type StimContext } from '@stim-cli/core';
import {
  buildWorkerRoot,
  loadConfig,
  readDaemonSnapshot,
  sharedCcache,
  sharedCompilationCache,
  type MaintenancePressure,
  type MaintenanceSize,
} from '@stim-cli/core/state';
import { readVolumeSpace, readVolumeSpaceAsync } from '../budget.ts';
import { memoryPressure } from '../daemon/pressure.ts';
import { measuredDirectorySizeAsync } from '../fs-util.ts';
import { readHostMemoryPressure, readHostMemoryPressureAsync, type HostMemoryPressure } from '../host-memory.ts';
import { discoverCachesAsync, type CacheDescriptor } from '../cache/caches.ts';
import { planCacheEmptying } from '../commands/gc/caches.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { cacheUser } from '../cache/cache-claim.ts';

export function measureDisk(): MaintenancePressure['disk'] {
  return readVolumeSpace([configDir(), ...Object.keys(loadConfig()?.projects ?? {}), buildWorkerRoot(loadConfig())]);
}

export function measureDiskAsync(operation: StimContext): Promise<MaintenancePressure['disk']> {
  return readVolumeSpaceAsync(
    [configDir(), ...Object.keys(loadConfig()?.projects ?? {}), buildWorkerRoot(loadConfig())],
    operation.signal,
  );
}

export function lowestFree(disk: MaintenancePressure['disk']): number {
  return disk.length ? Math.min(...disk.map((volume) => volume.freeMb)) : Infinity;
}

export function measurePressure(previous: MaintenancePressure | null, now: number): MaintenancePressure {
  return pressureFromObservations(previous, now, readHostMemoryPressure(), measureDisk());
}

export async function measurePressureAsync(
  previous: MaintenancePressure | null,
  now: number,
  operation: StimContext,
): Promise<MaintenancePressure> {
  const level = await readHostMemoryPressureAsync(undefined, undefined, operation.signal, operation);
  const disk = await readVolumeSpaceAsync(
    [configDir(), ...Object.keys(loadConfig()?.projects ?? {}), buildWorkerRoot(loadConfig())],
    operation.signal,
  );
  return pressureFromObservations(previous, now, level, disk);
}

/** Pressure from a measurement already taken, such as the daemon tick's. */
export function pressureFromMeasurement(
  previous: MaintenancePressure | null,
  now: number,
  { memory, disk }: { memory: { level: HostMemoryPressure | null }; disk: MaintenancePressure['disk'] },
): MaintenancePressure {
  return pressureFromObservations(previous, now, memory.level, disk);
}

/**
 * Disk and memory as status shows them. `pressured` is the stim-daemon's memory level above normal; the warning clock
 * carries over from the last measurement, or from the daemon's last tick.
 */
function pressureFromObservations(
  previous: MaintenancePressure | null,
  now: number,
  level: HostMemoryPressure | null,
  disk: MaintenancePressure['disk'],
): MaintenancePressure {
  const availableBytes = process.platform === 'darwin' ? null : freemem();
  const since = previous?.warningSince ?? Date.parse(readDaemonSnapshot()?.pressure?.memoryWarningSince ?? '');
  const memory = memoryPressure(
    { level, availableBytes, totalBytes: totalmem() },
    Number.isFinite(since) ? new Date(since).toISOString() : null,
    now,
  );
  const warningSince = Date.parse(memory.warningSince ?? '');
  return {
    disk,
    memory: { level, availableBytes, pressured: memory.level !== 'normal' },
    warningSince: Number.isFinite(warningSince) ? warningSince : null,
  };
}

const SIZE_SCAN_MAX_LOAD_PER_CORE = 4;

export function sizeScanDeferred(): boolean {
  return loadavg()[0]! / Math.max(1, cpus().length) > SIZE_SCAN_MAX_LOAD_PER_CORE;
}

export function cacheBlocked(
  entry: Pick<MaintenanceSize, 'name' | 'dir' | 'category'>,
  discovered: CacheDescriptor[],
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
  operation?: StimContext,
): Promise<MaintenanceSize[]> {
  const sizes: MaintenanceSize[] = [];
  const outputs = await collectWorkspaceOutputs({
    olderThan: null,
    now,
    sizeTimeoutMs: 120_000,
    ...(operation ? { signal: operation.signal, operation } : {}),
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
  const discovered = await discoverCachesAsync();
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
