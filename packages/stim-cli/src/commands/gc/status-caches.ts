import { rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import chalk from 'chalk';
import { listStatusCacheEntries, type StatusCacheEntry } from '@stim-cli/core/state';
import { formatBytes, isOnMountedVolume, listMountedVolumes } from '../../fs-util.ts';
import type { GcSkip } from './types.ts';
import { recordGcResult } from './results.ts';
import { rootPresence } from './workspaces.ts';

export interface StaleStatusCache {
  kind: StatusCacheEntry['kind'];
  file: string;
  path: string;
  bytes: number;
}

const KINDS: readonly StatusCacheEntry['kind'][] = ['disk-usage', 'pull-request'];

type Verdict = 'gone' | 'present' | 'unreadable' | 'unknown' | 'unmounted';

const KEPT_REASON: Record<'unreadable' | 'unknown' | 'unmounted', string> = {
  unreadable: 'the file records no readable path of its own',
  unknown: 'Stim cannot tell whether the folder it measures still exists',
  unmounted: 'the volume of the folder it measures is not mounted',
};

/** A measured `node_modules` folder is cached as empty while it is missing, so its checkout decides. */
function witnessPath(path: string): string {
  return basename(path).startsWith('node_modules') ? dirname(path) : path;
}

function judge(path: string | null, mountedVolumes: string[]): Verdict {
  if (path === null) return 'unreadable';
  const witness = witnessPath(path);
  const present = rootPresence(witness);
  if (present === null) return 'unknown';
  if (present) return 'present';
  return isOnMountedVolume(witness, mountedVolumes) ? 'gone' : 'unmounted';
}

export function classifyStatusCaches(
  entries: readonly StatusCacheEntry[],
  mountedVolumes: string[],
): { stale: StaleStatusCache[]; skipped: GcSkip[] } {
  const stale: StaleStatusCache[] = [];
  const kept = new Map<string, { dir: string; verdict: 'unreadable' | 'unknown' | 'unmounted'; count: number }>();
  for (const { kind, file, path, bytes } of entries) {
    const verdict = judge(path, mountedVolumes);
    if (verdict === 'present') continue;
    if (verdict === 'gone') {
      stale.push({ kind, file, path: path as string, bytes });
      continue;
    }
    const dir = dirname(file);
    const key = `${dir}\n${verdict}`;
    const seen = kept.get(key);
    if (seen) seen.count++;
    else kept.set(key, { dir, verdict, count: 1 });
  }
  const skipped = [...kept.values()].map(({ dir, verdict, count }) => ({
    dir,
    reason: `${count} entr${count === 1 ? 'y' : 'ies'} kept: ${KEPT_REASON[verdict]}`,
  }));
  return { stale, skipped };
}

export function collectStaleStatusCaches(mountedVolumes: string[]): { stale: StaleStatusCache[]; skipped: GcSkip[] } {
  return classifyStatusCaches(listStatusCacheEntries(), mountedVolumes);
}

export function statusCacheLines(stale: readonly StaleStatusCache[]): string[] {
  if (!stale.length) return [];
  const total = stale.reduce((sum, entry) => sum + entry.bytes, 0);
  const lines = [
    `Stale status cache entries (${stale.length}, ${formatBytes(total)}) - the folder or worktree they measure is gone:`,
  ];
  for (const kind of KINDS) {
    const count = stale.filter((entry) => entry.kind === kind).length;
    if (count) lines.push(`  ${kind}: ${count}`);
  }
  lines.push('              --delete removes them; `stim status` measures a folder again if it comes back.');
  return lines;
}

export function deleteStaleStatusCaches(stale: readonly StaleStatusCache[]): number {
  const mountedVolumes = listMountedVolumes();
  let failures = 0;
  for (const kind of KINDS) {
    let removed = 0;
    let bytes = 0;
    for (const entry of stale.filter((candidate) => candidate.kind === kind)) {
      if (judge(entry.path, mountedVolumes) !== 'gone') continue;
      try {
        rmSync(entry.file, { force: true });
        removed++;
        bytes += entry.bytes;
      } catch (error) {
        failures++;
        const detail = (error as Error)?.message || String(error);
        console.log(chalk.red(`Could not remove ${entry.file}: ${detail}`));
        recordGcResult('statusCache', 'failed', `${kind} cache entry`, { id: entry.file, detail });
      }
    }
    if (!removed) continue;
    const label = `${removed} stale ${kind} cache entr${removed === 1 ? 'y' : 'ies'}`;
    console.log(chalk.green(`Removed ${label}`));
    recordGcResult('statusCache', 'done', label, { bytes });
  }
  return failures;
}
