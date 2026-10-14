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
import {
  DEVICE_LIST_TIMEOUT_MS,
  collectParkedAvds,
  collectParkedSims,
  deleteParkedAvds,
  deleteParkedSims,
  deleteProjectDevices,
  deviceSweepIsScoped,
  findStaleProjectDevices,
} from '../commands/gc/devices.ts';
import { listAvds } from '../devices/android.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listAllIosSims } from '../devices/ios.ts';
import { stopOwnedMetro } from '../supervisor/cache-reset.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { isOnMountedVolume, listMountedVolumes } from '../fs-util.ts';
import { loadConfig } from '../workspace/config.ts';
import { cacheBlocked, measureDisk } from './measure.ts';
import { cacheEntryProtection, maintenancePinned, recentUse } from './protect.ts';
import { artifactWorktrees, clearArtifact, type ArtifactWorktree } from './artifacts.ts';
import { workspaceActiveReason } from './levels.ts';
import { levelFloors, lowestFree, protectWindowMs } from './pressure.ts';
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
  pressureSweep?: WorktreeSweep;
  protect?: (entry: string) => string | null;
  worktrees?: ArtifactWorktree[];
}

function freedSince(beforeMb: number): number {
  const freed = lowestFree(measureDisk()) - beforeMb;
  return Number.isFinite(freed) && freed > 0 ? Math.round(freed * 1024 * 1024) : 0;
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
  const floor = action.level === 3 ? levelFloors(context.budget, context.settings)[3] : context.budget.hardFloorDiskMb;
  if (!measureDisk().some((disk) => disk.freeMb < floor))
    return kept(
      action.level === 3
        ? 'free disk is back above the level 3 floor, and this cache can only be emptied whole'
        : 'free disk is above budget.hardFloorDiskGb, and this cache can only be emptied whole',
    );
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
  const recent = recentUse(root, context.settings, protectWindowMs(action, context.settings));
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
  const sweep = action.level === 3 ? context.pressureSweep : context.worktreeSweep;
  const worktree = sweep?.worktrees.find((candidate) => candidate.path === action.target);
  if (!sweep || !worktree) return kept("it is not in this pass's worktree check");
  const path = canonicalPath(worktree.path);
  if (context.protectedRoot === path || context.protectedRoot.startsWith(`${path}${sep}`))
    return kept('the command that started this pass runs inside it');
  if (worktree.keys.some(maintenancePinned)) return kept('pinned by maintenance.keep');
  const before = lowestFree(measureDisk());
  const { results } = await quietly(() => removeWorktrees({ ...sweep, worktrees: [worktree] }));
  return outcomeOf(results, freedSince(before));
}

async function removeOrphan(action: MaintenanceAction): Promise<ActionOutcome> {
  const orphans = await collectOrphanedWorkspaces(Object.keys(loadConfig()?.projects ?? {}), listMountedVolumes());
  const orphan = orphans.orphaned.find((candidate) => candidate.dir === action.target);
  if (!orphan) return kept('it is no longer an orphaned workspace directory');
  const { results } = await quietly(() => deleteOrphanedWorkspaces([orphan]));
  return outcomeOf(results, orphan.bytes ?? 0);
}

async function deleteParkedDevice(action: MaintenanceAction): Promise<ActionOutcome> {
  if (deviceSweepIsScoped()) return kept('STIM_HOME scopes this config, and devices are machine-wide');
  const sims = (await collectParkedSims({})).filter((sim) => sim.udid === action.target);
  const avds = sims.length ? [] : (await collectParkedAvds({})).filter((avd) => avd.name === action.target);
  if (!sims.length && !avds.length) return kept('it is no longer parked');
  const before = lowestFree(measureDisk());
  const { results } = await quietly(async () => (await deleteParkedSims(sims)) + (await deleteParkedAvds(avds)));
  return outcomeOf(results, freedSince(before));
}

async function stopWorkspace(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  const root = action.workspace ?? action.target;
  if (root === context.protectedRoot) return kept('the command that started this pass runs in it');
  if (maintenancePinned(root)) return kept('pinned by maintenance.keep');
  const windowMs = protectWindowMs(action, context.settings);
  const active = workspaceActiveReason(root, Date.now(), windowMs);
  if (active) return kept(active);
  const before = lowestFree(measureDisk());
  const run = await withIdleWorkspace(
    root,
    async (): Promise<ActionOutcome | null> => {
      if (workspaceActiveReason(root, Date.now(), windowMs)) return kept('it became active');
      const metro = await stopOwnedMetro(root, { by: 'automatic maintenance', workspace: context.protectedRoot });
      if ('reason' in metro) return kept(`its dev server: ${metro.reason}`);
      if (deviceSweepIsScoped()) return null;
      const config = loadConfig();
      const project = config?.projects?.[root];
      if (!config || !project) return null;
      const owns = (kind: 'ios' | 'android') =>
        projectDeviceSlots(project).some(({ platforms }) => platforms[kind]?.owned === true);
      let sims: ReturnType<typeof listAllIosSims> = [];
      let avds: string[] = [];
      try {
        if (owns('ios')) sims = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
        if (owns('android')) avds = listAvds();
      } catch (error) {
        return {
          status: 'failed',
          bytes: 0,
          detail: `its owned devices could not be listed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const devices = findStaleProjectDevices({
        config: { ...config, projects: { [root]: project } },
        sims,
        avds,
        olderThanDays: 0,
        lastTouched: () => 0,
      });
      const { value: failures } = await quietly(() => deleteProjectDevices([], devices, []));
      return failures ? { status: 'failed', bytes: 0, detail: `${failures} owned devices could not be deleted` } : null;
    },
    { purpose: 'automatic maintenance', supervisor: false },
  );
  if (!run.ran) return kept(`in use: ${run.reasons.join('; ')}`);
  const bytes = freedSince(before);
  return run.value ? { ...run.value, bytes } : { status: 'done', bytes, detail: root };
}

async function clearArtifacts(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  return clearArtifact(action, action.kind === 'would-delete-dependencies' ? 'dependencies' : 'build', {
    windowMs: protectWindowMs(action, context.settings),
    protectedRoot: context.protectedRoot,
    pinned: maintenancePinned,
    worktrees: (context.worktrees ??= artifactWorktrees()),
  });
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
    case 'would-delete-parked-device':
      return deleteParkedDevice(action);
    case 'would-stop-workspace':
      return action.level === 3
        ? stopWorkspace(action, context)
        : kept('automatic maintenance stops dev servers only at disk pressure level 3');
    case 'would-clear-build-dirs':
    case 'would-delete-dependencies':
      return clearArtifacts(action, context);
    default:
      return kept('automatic maintenance does not stop devices or dev servers yet');
  }
}

export function diskRecovered(budget: Budget): boolean {
  const floor = Math.max(budget.minFreeDiskMb, budget.hardFloorDiskMb);
  return measureDisk().every((disk) => disk.freeMb >= floor);
}
