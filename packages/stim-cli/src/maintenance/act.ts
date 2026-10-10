import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { buildCacheRoot, metroCacheRoot } from '@stim-cli/core';
import { sharedCompilationCache, type MaintenanceAction } from '@stim-cli/core/state';
import { cacheLabel, type Budget } from '../budget.ts';
import { unregister, readManifest } from '../cache/cache-manifest.ts';
import { discoverCaches, pruneCache, type CacheDescriptor } from '../cache/caches.ts';
import { emptyCaches, planCacheEmptying } from '../commands/gc/caches.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { takeGcResults, type GcResult } from '../commands/gc/results.ts';
import {
  clearWorkspaceOutputs,
  collectOrphanedWorkspaces,
  collectWorkspaceOutputs,
  deleteOrphanedWorkspaces,
} from '../commands/gc/workspaces.ts';
import { removeWorktrees, type WorktreeSweep } from '../commands/gc/worktrees.ts';
import { isOnMountedVolume, listMountedVolumes } from '../fs-util.ts';
import { loadConfig } from '../workspace/config.ts';
import { cacheBlocked, measureDisk } from './measure.ts';
import { cacheEntryProtection, maintenancePinned, recentUse } from './protect.ts';
import type { MaintenanceSettings } from './settings.ts';

export interface ActionOutcome {
  status: 'done' | 'kept' | 'failed';
  bytes: number;
  detail: string;
  shortfall?: string;
}

export interface ActContext {
  settings: MaintenanceSettings;
  budget: Budget;
  protectedRoot: string;
  worktreeSweep?: WorktreeSweep;
  protect?: (entry: string) => string | null;
}

const kept = (detail: string): ActionOutcome => ({ status: 'kept', bytes: 0, detail });

async function quietly<T>(run: () => Promise<T> | T): Promise<{ value: T; results: GcResult[] }> {
  const { log, error } = { log: console.log, error: console.error };
  const exitCode = process.exitCode;
  takeGcResults();
  console.log = () => {};
  console.error = () => {};
  try {
    const value = await run();
    return { value, results: takeGcResults() };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
    takeGcResults();
  }
}

function outcomeOf(results: readonly GcResult[], fallbackBytes: number): ActionOutcome {
  const failed = results.find((result) => result.status === 'failed');
  if (failed) return { status: 'failed', bytes: 0, detail: failed.detail ?? `could not process ${failed.label}` };
  const done = results.filter((result) => result.status === 'done');
  if (done.length)
    return {
      status: 'done',
      bytes: done.reduce((sum, result) => sum + (result.bytes ?? 0), 0) || fallbackBytes,
      detail: done.map((result) => result.label).join(', '),
    };
  return kept(results.find((result) => result.detail)?.detail ?? 'nothing was eligible when the action ran');
}

function rootCache(dir: string): CacheDescriptor | null {
  const name =
    canonicalPath(dir) === canonicalPath(buildCacheRoot())
      ? 'Build cache'
      : canonicalPath(dir) === canonicalPath(metroCacheRoot())
        ? 'Metro transform caches'
        : null;
  return name ? { name, dir, prune: 'entries', entriesDepth: name === 'Build cache' ? 2 : 3, note: '' } : null;
}

function cacheOf(action: MaintenanceAction): CacheDescriptor | null {
  const discovered = discoverCaches();
  if (action.dir) {
    const dir = canonicalPath(action.dir);
    return discovered.find((cache) => canonicalPath(cache.dir) === dir) ?? rootCache(action.dir);
  }
  return discovered.find((cache) => cacheLabel(cache) === action.target) ?? null;
}

function trimCache(action: MaintenanceAction, context: ActContext): ActionOutcome {
  const cache = cacheOf(action);
  if (!cache) return kept('it is no longer a cache Stim may trim');
  const [planned] = planCacheEmptying([cache], false);
  if (!planned || planned.machineGlobal) return kept(planned?.machineGlobal ?? 'it is no longer a cache Stim may trim');
  const aged = action.olderThanDays !== undefined;
  const result = pruneCache(cache, {
    olderThanDays: Math.max(action.olderThanDays ?? 0, context.settings.protectRecentHours / 24),
    byMtime: true,
    protect: (context.protect ??= cacheEntryProtection()),
    ...(aged ? {} : { evictBytes: action.bytes }),
  });
  if (result.skipped) return kept(result.skipped);
  if (result.failed)
    return { status: 'failed', bytes: result.bytes, detail: `${result.failed} entries could not be removed` };
  const protectedNote = result.protectedEntries ? `; ${result.protectedEntries} protected entries kept` : '';
  if (result.removed === 0) return kept(`no unprotected entry was old enough${protectedNote}`);
  return {
    status: 'done',
    bytes: result.bytes,
    detail: `${result.removed} entries${protectedNote}`,
    ...(!aged && result.bytes < action.bytes
      ? { shortfall: `${action.target} reached ${result.bytes} of ${action.bytes} bytes${protectedNote}` }
      : {}),
  };
}

async function emptyCompilationCache(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  if (!measureDisk().some((disk) => disk.freeMb < context.budget.hardFloorDiskMb))
    return kept('free disk is above budget.hardFloorDiskGb, and this cache can only be emptied whole');
  const dir = sharedCompilationCache();
  const blocked = cacheBlocked({ name: 'Swift compilation cache', dir, category: 'compilation-cache' });
  if (blocked) return kept(blocked);
  const cache = discoverCaches().find((candidate) => canonicalPath(candidate.dir) === canonicalPath(dir));
  if (cache?.prune !== 'atomic') return kept('it is not a registered cache Stim empties whole');
  const [planned] = planCacheEmptying([{ ...cache, bytes: action.bytes }], true);
  const { results } = await quietly(() => emptyCaches(planned ? [planned] : []));
  return outcomeOf(results, action.bytes);
}

async function clearOutputs(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  const root = action.workspace;
  if (!root) return kept('the action names no workspace');
  if (root === context.protectedRoot) return kept('the command that started this pass runs in it');
  if (maintenancePinned(root)) return kept('pinned by maintenance.keep');
  const recent = recentUse(root, context.settings);
  if (recent) return kept(recent);
  const olderThan = action.olderThanDays ?? null;
  const now = Date.now();
  const report = collectWorkspaceOutputs({ olderThan, now, measure: false });
  const entry = report.workspaces.find(
    (candidate) => candidate.projectRoot && canonicalPath(candidate.projectRoot) === root,
  );
  if (!entry) return kept('it has no build outputs any more');
  const { results } = await quietly(() =>
    clearWorkspaceOutputs({ ...report, workspaces: [entry] }, { olderThan, now }),
  );
  return outcomeOf(results, action.bytes);
}

async function removeWorktree(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  const sweep = context.worktreeSweep;
  const worktree = sweep?.worktrees.find((candidate) => candidate.path === action.target);
  if (!sweep || !worktree) return kept("it is not in this pass's worktree check");
  const path = canonicalPath(worktree.path);
  if (context.protectedRoot === path || context.protectedRoot.startsWith(`${path}${sep}`))
    return kept('the command that started this pass runs inside it');
  if (worktree.keys.some(maintenancePinned)) return kept('pinned by maintenance.keep');
  const { results } = await quietly(() => removeWorktrees({ ...sweep, worktrees: [worktree] }));
  return outcomeOf(results, 0);
}

async function removeOrphan(action: MaintenanceAction): Promise<ActionOutcome> {
  const orphans = collectOrphanedWorkspaces(Object.keys(loadConfig()?.projects ?? {}), listMountedVolumes());
  const orphan = orphans.orphaned.find((candidate) => candidate.dir === action.target);
  if (!orphan) return kept('it is no longer an orphaned workspace directory');
  const { results } = await quietly(() => deleteOrphanedWorkspaces([orphan]));
  return outcomeOf(results, orphan.bytes ?? 0);
}

function unregisterCache(action: MaintenanceAction): ActionOutcome {
  const dir = action.dir ?? action.target;
  if (
    existsSync(dir) ||
    !isOnMountedVolume(dir, listMountedVolumes()) ||
    !readManifest().caches.some((c) => c.dir === dir)
  )
    return kept('it can no longer be shown to be a stale registration');
  return unregister(dir) ? { status: 'done', bytes: 0, detail: dir } : kept('it was already unregistered');
}

export async function executeAction(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  switch (action.kind) {
    case 'would-clear-outputs':
      return clearOutputs(action, context);
    case 'would-trim-cache':
      return trimCache(action, context);
    case 'would-empty-cache':
      return emptyCompilationCache(action, context);
    case 'would-remove-worktree':
      return removeWorktree(action, context);
    case 'would-remove-orphan':
      return removeOrphan(action);
    case 'would-unregister-cache':
      return unregisterCache(action);
    default:
      return kept('automatic maintenance does not stop devices or dev servers yet');
  }
}

export function diskRecovered(budget: Budget): boolean {
  const floor = Math.max(budget.minFreeDiskMb, budget.hardFloorDiskMb);
  return measureDisk().every((disk) => disk.freeMb >= floor);
}
