import { existsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { configDir, metroCacheRoot, buildCacheRoot } from '@stim-cli/core';
import {
  buildWorkerRoot,
  loadConfig,
  sharedCcache,
  sharedCompilationCache,
  type MaintenancePressure,
  type MaintenanceSize,
} from '@stim-cli/core/state';
import { readVolumeSpace } from '../budget.ts';
import { measuredDirectorySizeAsync } from '../fs-util.ts';
import { readHostMemoryPressure } from '../host-memory.ts';
import { discoverCaches, type CacheDescriptor } from '../cache/caches.ts';
import { planCacheEmptying } from '../commands/gc/caches.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { listBuildLocks } from '../engine/build-lock.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import type { MaintenanceSettings } from './settings.ts';

export function measureDisk(): MaintenancePressure['disk'] {
  return readVolumeSpace([configDir(), ...Object.keys(loadConfig()?.projects ?? {}), buildWorkerRoot(loadConfig())]);
}

export function measurePressure(
  settings: MaintenanceSettings,
  previous: MaintenancePressure | null,
  now: number,
): MaintenancePressure {
  const level = readHostMemoryPressure();
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
    disk: measureDisk(),
    memory: { level, availableBytes, pressured },
    warningSince,
  };
}

export function sizeScanDeferred(settings: MaintenanceSettings): boolean {
  return loadavg()[0]! / Math.max(1, cpus().length) > settings.maxLoadPerCore;
}

const held = (item: { pid: number | null; projectRoot: string | null }) =>
  `pid ${item.pid ?? '?'}${item.projectRoot ? ` in ${item.projectRoot}` : ''}`;

const owner = (item: { pid: number | null; logFile: string | null }) =>
  item.pid === null || item.logFile === null ? null : `${item.pid}\0${item.logFile}`;

function compilationCacheUser(): string | undefined {
  const locks = listBuildLocks();
  const lock = locks.find((item) => (item.alive || item.unresolved) && item.platform !== 'android');
  if (lock)
    return lock.alive
      ? `the ${lock.platform} build (${held(lock)}) may be using it`
      : `the build lock ${lock.path} is unresolved, so a build may be using it`;
  const android = new Set(
    locks.flatMap((item) => (item.alive && item.platform === 'android' && owner(item) ? [owner(item)] : [])),
  );
  const slot = listBuildSlots().find(
    (item) => (item.alive || item.unresolved) && !(item.alive && owner(item) && android.has(owner(item))),
  );
  if (!slot) return undefined;
  return slot.alive
    ? `the build holding ${slot.name} (${held(slot)}) has no Android build lock, so it may be using it`
    : `the build slot ${slot.path} is unresolved, so a build may be using it`;
}

export function cacheBlocked(
  entry: Pick<MaintenanceSize, 'name' | 'dir' | 'category'>,
  discovered: CacheDescriptor[] = discoverCaches(),
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
    )[0]?.machineGlobal ?? (entry.category === 'compilation-cache' ? compilationCacheUser() : undefined)
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
