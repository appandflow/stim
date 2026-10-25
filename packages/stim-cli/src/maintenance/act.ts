import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { buildCacheRoot, metroCacheRoot, type StimContext } from '@stim-cli/core';
import { sharedCompilationCache, type MaintenanceAction } from '@stim-cli/core/state';
import { cacheLabel, type Budget } from '../budget.ts';
import { unregister, readManifest } from '../cache/cache-manifest.ts';
import { discoverCaches, pruneCache, type CacheDescriptor } from '../cache/caches.ts';
import { emptyCaches, planCacheEmptying } from '../commands/gc/caches.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { deleteGradleVersion, waitForGradleExit } from '../commands/gc/gradle-versions.ts';
import { stopIdleGradleDaemons } from '../commands/gc/memory.ts';
import { deleteTempLeftovers } from '../commands/gc/temp-leftovers.ts';
import { plural } from '../command-output.ts';
import { takeGcResults, GC_OUTPUT, type GcResult, type GcOutput } from '../commands/gc/results.ts';
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
import { listAvdsAsync } from '../devices/android.ts';
import {
  dueIdleDevices,
  shutDownIdleDevices,
  writeIdleShutdownEvent,
  type IdleShutdownEvent,
} from '../devices/idle-shutdown.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listAllIosSimsAsync } from '../devices/ios.ts';
import { stopOwnedMetro } from '../supervisor/cache-reset.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { isOnMountedVolume, listMountedVolumes } from '../fs-util.ts';
import { loadConfig } from '../workspace/config.ts';
import { cacheBlocked, measureDisk, measureDiskAsync } from './measure.ts';
import { cacheEntryProtection, maintenancePinned, maintenancePinnedAsync, recentUse } from './protect.ts';
import { artifactWorktrees, clearArtifact, type ArtifactWorktree } from './artifacts.ts';
import { cachedDeviceActivityAsync, workspaceActiveReason, workspaceActiveReasonAsync } from './activity.ts';
import { levelFloors, lowestFree, protectWindowMs } from './pressure.ts';
import type { MaintenanceSettings } from './settings.ts';
import { idleShutdownMinutes } from './devices.ts';

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

function freedSince(beforeMb: number, disk = measureDisk()): number {
  const freed = lowestFree(disk) - beforeMb;
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
  const lighten = action.level === 2;
  const recent = lighten ? null : recentUse(root, context.settings, protectWindowMs(action, context.settings));
  if (recent) return kept(recent);
  const olderThan = action.olderThanDays ?? null;
  const now = Date.now();
  const report = collectWorkspaceOutputs({ olderThan, now, measure: false, lighten });
  const entry = report.workspaces.find(
    (candidate) => candidate.projectRoot && canonicalPath(candidate.projectRoot) === root,
  );
  if (!entry) return kept('it has no build outputs any more');
  const { results } = await quietly(() =>
    clearWorkspaceOutputs({ ...report, workspaces: [entry] }, { olderThan, now, lighten }),
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
  const outcome = outcomeOf(results, freedSince(before));
  const removal = results.find((result) => result.status === 'done')?.detail;
  return outcome.status === 'done' ? { ...outcome, detail: removal ?? action.reason } : outcome;
}

async function removeOrphan(action: MaintenanceAction): Promise<ActionOutcome> {
  const orphans = await collectOrphanedWorkspaces(Object.keys(loadConfig()?.projects ?? {}), listMountedVolumes());
  const orphan = orphans.orphaned.find((candidate) => candidate.dir === action.target);
  if (!orphan) return kept('it is no longer an orphaned workspace directory');
  const { results } = await quietly(() => deleteOrphanedWorkspaces([orphan]));
  return outcomeOf(results, orphan.bytes ?? 0);
}

async function shutDownIdleDevice(action: MaintenanceAction): Promise<ActionOutcome> {
  if (deviceSweepIsScoped()) return kept('STIM_HOME scopes this config, and devices are machine-wide');
  const root = action.workspace ?? action.target;
  const minutes = idleShutdownMinutes(root);
  if (minutes === 0) return kept('devices.idleShutdownMinutes is 0 for this workspace');
  const idleMs = minutes * 60_000;
  const due = dueIdleDevices(root, idleMs).find(({ device }) => device.id === action.target);
  if (!due) return kept(`it is no longer idle for ${minutes} minutes`);
  const failures: string[] = [];
  const skips: string[] = [];
  const log = (event: IdleShutdownEvent) => {
    writeIdleShutdownEvent(root, event);
    if (event.event === 'device_idle_shutdown_failed') (event.skipped ? skips : failures).push(event.msg);
  };
  const run = await withIdleWorkspace(
    root,
    () => shutDownIdleDevices(root, idleMs, log, Date.now(), { only: due.device }),
    { purpose: 'automatic maintenance idle shutdown', supervisor: false, managedLocks: false },
  );
  if (!run.ran) return kept(`in use: ${run.reasons.join('; ')}`);
  if (run.value) return { status: 'done', bytes: 0, detail: action.target };
  if (failures.length) return { status: 'failed', bytes: 0, detail: failures.join('; ') };
  return kept(skips.join('; ') || `it is no longer idle for ${minutes} minutes`);
}

async function deleteParkedDevice(action: MaintenanceAction): Promise<ActionOutcome> {
  if (deviceSweepIsScoped()) return kept('STIM_HOME scopes this config, and devices are machine-wide');
  const age = { olderThanDays: action.olderThanDays ?? null, now: Date.now() };
  const sims = (await collectParkedSims({}, age)).filter((sim) => sim.udid === action.target);
  const avds = sims.length ? [] : (await collectParkedAvds({}, age)).filter((avd) => avd.name === action.target);
  if (!sims.length && !avds.length)
    return kept(
      action.olderThanDays === undefined
        ? 'it is no longer parked'
        : `it is no longer parked, or was parked within ${action.olderThanDays} days`,
    );
  const before = lowestFree(measureDisk());
  const { results } = await quietly(async () => (await deleteParkedSims(sims)) + (await deleteParkedAvds(avds)));
  return outcomeOf(results, freedSince(before));
}

async function deleteOwnedDevicesOf(
  root: string,
  {
    noneIsKept = false,
    operation,
    output = GC_OUTPUT,
  }: {
    noneIsKept?: boolean;
    operation?: StimContext;
    output?: GcOutput;
  } = {},
): Promise<ActionOutcome | null> {
  operation?.signal.throwIfAborted();
  if (deviceSweepIsScoped(operation?.env ?? process.env)) return null;
  const config = loadConfig();
  const project = config?.projects?.[root];
  if (!config || !project) return null;
  const owns = (kind: 'ios' | 'android') =>
    projectDeviceSlots(project).some(({ platforms }) => platforms[kind]?.owned === true);
  let sims: Awaited<ReturnType<typeof listAllIosSimsAsync>> = [];
  let avds: string[] = [];
  try {
    if (owns('ios'))
      sims = await listAllIosSimsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, operation, signal: operation?.signal });
    operation?.signal.throwIfAborted();
    if (owns('android')) avds = await listAvdsAsync({ operation, signal: operation?.signal });
    operation?.signal.throwIfAborted();
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
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
  if (noneIsKept && devices.length === 0) return kept('it owns no listed devices any more');
  const failures = await deleteProjectDevices([], devices, [], output, operation);
  return failures ? { status: 'failed', bytes: 0, detail: `${failures} owned devices could not be deleted` } : null;
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
      return (await quietly(() => deleteOwnedDevicesOf(root))).value;
    },
    { purpose: 'automatic maintenance', supervisor: false },
  );
  if (!run.ran) return kept(`in use: ${run.reasons.join('; ')}`);
  const bytes = freedSince(before);
  return run.value ? { ...run.value, bytes } : { status: 'done', bytes, detail: root };
}

/**
 * Deletes the owned simulators and emulators of a workspace that stays idle for `windowMs`, under its native-run
 * claim, without stopping anything: a running dev server, lease, lock or driver keeps every device.
 */
export async function deleteIdleWorkspaceDevices(
  root: string,
  {
    windowMs,
    protectedRoot,
    purpose,
    operation,
    output,
  }: { windowMs: number; protectedRoot: string; purpose: string; operation?: StimContext; output?: GcOutput },
): Promise<ActionOutcome> {
  operation?.signal.throwIfAborted();
  if (root === protectedRoot) return kept('the command that started this pass runs in it');
  if (operation ? await maintenancePinnedAsync(root, operation) : maintenancePinned(root))
    return kept('pinned by maintenance.keep');
  if (deviceSweepIsScoped(operation?.env ?? process.env))
    return kept('STIM_HOME scopes this config, and devices are machine-wide');
  const activeReason = async () => {
    const now = Date.now();
    if (!operation) return workspaceActiveReason(root, now, windowMs);
    const reason = await workspaceActiveReasonAsync(
      root,
      now,
      windowMs,
      cachedDeviceActivityAsync(now, operation.env, operation.signal, operation),
      operation.signal,
    );
    operation.signal.throwIfAborted();
    return reason;
  };
  const active = await activeReason();
  if (active) return kept(active);
  const before = lowestFree(operation ? await measureDiskAsync(operation) : measureDisk());
  const run = await withIdleWorkspace(
    root,
    async (): Promise<ActionOutcome | null> =>
      (await activeReason())
        ? kept('it became active')
        : deleteOwnedDevicesOf(root, { noneIsKept: true, operation, output }),
    { purpose, operation },
  );
  if (!run.ran) return kept(`in use: ${run.reasons.join('; ')}`);
  const bytes = operation ? freedSince(before, await measureDiskAsync(operation)) : freedSince(before);
  return run.value ? { ...run.value, bytes } : { status: 'done', bytes, detail: root };
}

function deviceWindowMs(action: MaintenanceAction, context: ActContext): number {
  if (action.level !== undefined) return protectWindowMs(action, context.settings);
  if (action.olderThanDays !== undefined) return action.olderThanDays * 86_400_000;
  return Math.max(context.worktreeSweep?.graceMs ?? 0, context.settings.protectRecentHours * 3_600_000);
}

async function deleteDevices(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  const { value } = await quietly(() =>
    deleteIdleWorkspaceDevices(action.workspace ?? action.target, {
      windowMs: deviceWindowMs(action, context),
      protectedRoot: context.protectedRoot,
      purpose: 'automatic maintenance',
    }),
  );
  return value;
}

async function clearArtifacts(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  return clearArtifact(action, action.kind === 'would-delete-dependencies' ? 'dependencies' : 'build', {
    windowMs: protectWindowMs(action, context.settings),
    protectedRoot: context.protectedRoot,
    pinned: maintenancePinned,
    worktrees: (context.worktrees ??= artifactWorktrees()),
  });
}

const GRADLE_EXIT_WAIT_MS = 3000;

async function stopGradleDaemonsAction(action: MaintenanceAction): Promise<ActionOutcome> {
  const targets = [...action.target.matchAll(/\d+/g)].map((match) => Number(match[0]));
  const { value: failures, results } = await quietly(() => stopIdleGradleDaemons(targets));
  const daemons = results.filter((result) => result.kind === 'gradleDaemon' || result.kind === 'kotlinDaemon');
  const stopped = daemons.filter((result) => result.status === 'done');
  if (failures) return { status: 'failed', bytes: 0, detail: `${plural(failures, 'daemon')} could not be stopped` };
  if (stopped.length === 0) return kept(daemons.find((result) => result.detail)?.detail ?? 'no daemon was stopped');
  const left = await waitForGradleExit(
    stopped.flatMap((result) => (result.id && /^\d+$/.test(result.id) ? [Number(result.id)] : [])),
    GRADLE_EXIT_WAIT_MS,
  );
  const labels = stopped.map((result) => result.label).join(', ');
  return {
    status: 'done',
    bytes: 0,
    detail: left.length ? `${labels}; pid ${left.join(', ')} had not exited yet` : labels,
  };
}

async function deleteGradleVersionAction(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  const before = lowestFree(measureDisk());
  try {
    const result = await deleteGradleVersion(action.target, { olderThanDays: context.settings.gradleVersionIdleDays });
    return result.deleted ? { status: 'done', bytes: freedSince(before), detail: result.detail } : kept(result.detail);
  } catch (error) {
    return {
      status: 'failed',
      bytes: freedSince(before),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function deleteTempLeftoversAction(): Promise<ActionOutcome> {
  const { value: done } = await quietly(() => deleteTempLeftovers());
  if (done.failures) return { status: 'failed', bytes: done.bytes, detail: `${done.failures} could not be deleted` };
  return done.count ? { status: 'done', bytes: done.bytes, detail: `${done.count} deleted` } : kept('none is idle now');
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
    case 'would-delete-devices':
      return deleteDevices(action, context);
    case 'would-shutdown-device':
      return action.check === 'disk'
        ? kept('automatic maintenance does not stop devices or dev servers for disk')
        : shutDownIdleDevice(action);
    case 'would-stop-workspace':
      return action.level === 3
        ? stopWorkspace(action, context)
        : kept('automatic maintenance stops dev servers only at disk pressure level 3');
    case 'would-clear-build-dirs':
    case 'would-delete-dependencies':
      return clearArtifacts(action, context);
    case 'would-stop-gradle-daemons':
      return stopGradleDaemonsAction(action);
    case 'would-delete-gradle-version':
      return deleteGradleVersionAction(action, context);
    case 'would-delete-temp-leftovers':
      return deleteTempLeftoversAction();
    default:
      return kept('automatic maintenance does not stop devices or dev servers yet');
  }
}

export function diskRecovered(budget: Budget): boolean {
  const floor = Math.max(budget.minFreeDiskMb, budget.hardFloorDiskMb);
  return measureDisk().every((disk) => disk.freeMb >= floor);
}
