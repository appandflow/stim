import { existsSync, statfsSync, statSync } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { volumeRootFor } from '../../fs-util.ts';
import { discoverCachesAsync } from '../../cache/caches.ts';
import { planCacheEmptying, type GcCache } from '../../commands/gc/caches.ts';

const MB = 1024 * 1024;

export interface VolumeSpace {
  volume: string;
  freeMb: number;
  /** The device id `stat` reported; two volumes can share a `volume` label. */
  device?: number;
}

function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

export function readVolumeSpace(paths: readonly string[]): VolumeSpace[] {
  const seen = new Set<number>();
  const volumes: VolumeSpace[] = [];
  for (const path of paths) {
    try {
      const existing = existingAncestor(path);
      const device = statSync(existing).dev;
      if (seen.has(device)) continue;
      seen.add(device);
      const fs = statfsSync(existing);
      volumes.push({ volume: volumeRootFor(path), freeMb: (fs.bavail * fs.bsize) / MB });
    } catch {}
  }
  return volumes;
}

export async function readVolumeSpaceAsync(paths: readonly string[], signal?: AbortSignal): Promise<VolumeSpace[]> {
  const seen = new Set<number>();
  const volumes: VolumeSpace[] = [];
  for (const path of paths) {
    signal?.throwIfAborted();
    try {
      let existing = path;
      let info;
      while (!info) {
        try {
          info = await stat(existing);
        } catch (error) {
          if (dirname(existing) === existing) throw error;
          existing = dirname(existing);
        }
        signal?.throwIfAborted();
      }
      if (seen.has(info.dev)) continue;
      seen.add(info.dev);
      const fs = await statfs(existing);
      signal?.throwIfAborted();
      volumes.push({ volume: volumeRootFor(path), freeMb: (fs.bavail * fs.bsize) / MB, device: info.dev });
    } catch {
      signal?.throwIfAborted();
    }
  }
  return volumes;
}

export function cacheLabel(cache: { name: string; dir: string }): string {
  return `${cache.name} ${cache.dir}`;
}

export async function trimmableCaches(env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<GcCache[]> {
  return planCacheEmptying(await discoverCachesAsync(env, cwd), false, env).filter(
    (cache) => cache.prune !== 'report-only' && cache.prune !== 'atomic' && !cache.machineGlobal,
  );
}

export interface BudgetRefusal {
  code: string;
  message: string;
  remedy: string;
}

export type ReclaimObserver = (state: 'start' | 'complete' | 'failed') => void;
