import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { buildCacheRoot, metroCacheRoot, type StimContext } from '@stim-cli/core';
import { sharedCompilationCache, type MaintenanceAction } from '@stim-cli/core/state';
import { cacheLabel } from '../budget.ts';
import { unregister, readManifest } from '../cache/cache-manifest.ts';
import { discoverCachesAsync, pruneCache, type CacheDescriptor } from '../cache/caches.ts';
import { emptyCaches, planCacheEmptying } from '../commands/gc/caches.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { deleteGradleVersion, waitForGradleExit } from '../commands/gc/gradle-versions.ts';
import { stopIdleGradleDaemons } from '../commands/gc/memory.ts';
import { deleteTempLeftovers } from '../commands/gc/temp-leftovers.ts';
import { deleteTrash } from '../commands/gc/trash.ts';
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
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listAllIosSimsAsync } from '../devices/ios.ts';
import { liveShareKeepReason } from '../local-server.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { isOnMountedVolume, listMountedVolumes } from '../fs-util.ts';
import { loadConfig } from '../workspace/config.ts';
import { cacheBlocked, lowestFree, measureDisk, measureDiskAsync } from './measure.ts';
import {
  cacheEntryProtectionFor,
  maintenancePinned,
  maintenancePinnedAsync,
  maintenancePinnedReader,
  recentUse,
} from './protect.ts';
import { artifactWorktreesFor, clearArtifact, type ArtifactWorktree } from './artifacts.ts';
import {
  cachedDeviceActivity,
  cachedDeviceActivityAsync,
  workspaceActiveReason,
  workspaceActiveReasonAsync,
} from './activity.ts';
import { stopIdleWorkspace } from './idle-stop.ts';
import type { MaintenanceSettings } from './settings.ts';

export interface ActionOutcome {
  status: 'done' | 'kept' | 'failed';
  bytes: number;
  detail: string;
  shortfall?: string;
}

export interface ActContext {
  settings: MaintenanceSettings;
  protectedRoot: string;
  background?: boolean;
  worktreeSweep?: WorktreeSweep;
  protect?: (entry: string) => string | null;
  worktrees?: ArtifactWorktree[];
  /** The daemon tick's context, whose reads run without blocking its event loop. */
  operation?: StimContext;
}

const protectWindowMs = (settings: Pick<MaintenanceSettings, 'protectRecentHours'>) =>
  settings.protectRecentHours * 3_600_000;

function freedSince(beforeMb: number, disk = measureDisk()): number {
  const freed = lowestFree(disk) - beforeMb;
  return Number.isFinite(freed) && freed > 0 ? Math.round(freed * 1024 * 1024) : 0;
}

const kept = (detail: string): ActionOutcome => ({ status: 'kept', bytes: 0, detail });

let quietTurn: Promise<unknown> = Promise.resolve();

/** One runs at a time per process: the gc result buffer, the console and the exit code it swaps are process-wide. */
function quietly<T>(run: () => Promise<T> | T): Promise<{ value: T; results: GcResult[] }> {
  const turn = quietTurn.then(() => quietlyNow(run));
  quietTurn = turn.catch(() => {});
  return turn;
}

async function quietlyNow<T>(run: () => Promise<T> | T): Promise<{ value: T; results: GcResult[] }> {
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

async function cacheOf(action: MaintenanceAction): Promise<CacheDescriptor | null> {
  const discovered = await discoverCachesAsync();
  if (action.dir) {
    const dir = canonicalPath(action.dir);
    return discovered.find((cache) => canonicalPath(cache.dir) === dir) ?? rootCache(action.dir);
  }
  return discovered.find((cache) => cacheLabel(cache) === action.target) ?? null;
}

async function trimCache(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  const cache = await cacheOf(action);
  if (!cache) return kept('it is no longer a cache Stim may trim');
  const [planned] = planCacheEmptying([cache], false);
  if (!planned || planned.machineGlobal) return kept(planned?.machineGlobal ?? 'it is no longer a cache Stim may trim');
  const aged = action.olderThanDays !== undefined;
  const result = pruneCache(cache, {
    olderThanDays: Math.max(action.olderThanDays ?? 0, context.settings.protectRecentHours / 24),
    byMtime: true,
    protect: (context.protect ??= await cacheEntryProtectionFor(loadConfig(), context.operation)),
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

async function emptyCompilationCache(action: MaintenanceAction): Promise<ActionOutcome> {
  const dir = sharedCompilationCache();
  const discovered = await discoverCachesAsync();
  const blocked = cacheBlocked({ name: 'Swift compilation cache', dir, category: 'compilation-cache' }, discovered);
  if (blocked) return kept(blocked);
  const cache = discovered.find((candidate) => canonicalPath(candidate.dir) === canonicalPath(dir));
  if (cache?.prune !== 'atomic') return kept('it is not a registered cache Stim empties whole');
  const [planned] = planCacheEmptying([{ ...cache, bytes: action.bytes }], true);
  const { results } = await quietly(() => emptyCaches(planned ? [planned] : []));
  return outcomeOf(results, action.bytes);
}

async function clearOutputs(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  const root = action.workspace;
  if (!root) return kept('the action names no workspace');
  if (root === context.protectedRoot) return kept('the command that started this pass runs in it');
  if (await maintenancePinnedReader(context.operation)(root)) return kept('pinned by maintenance.keep');
  const recent = recentUse(root, context.settings, protectWindowMs(context.settings));
  if (recent) return kept(recent);
  const olderThan = action.olderThanDays ?? null;
  const now = Date.now();
  const { operation } = context;
  const report = operation
    ? await collectWorkspaceOutputs({ olderThan, now, measure: false, only: root, signal: operation.signal, operation })
    : collectWorkspaceOutputs({ olderThan, now, measure: false, only: root });
  const entry = report.workspaces.find(
    (candidate) => candidate.projectRoot && canonicalPath(candidate.projectRoot) === root,
  );
  if (!entry) return kept('it has no build outputs any more');
  const { results } = await quietly(() =>
    clearWorkspaceOutputs({ ...report, workspaces: [entry] }, { olderThan, now, operation }),
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
  const pinned = maintenancePinnedReader(context.operation);
  for (const key of worktree.keys) if (await pinned(key)) return kept('pinned by maintenance.keep');
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

/**
 * Deletes the owned simulators and emulators of a workspace that stays idle for `windowMs`, under its native-run
 * claim, without stopping anything: a running dev server, lease, lock, driver or live web share keeps every device.
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
  const active = (await activeReason()) ?? (await liveShareKeepReason(root));
  if (active) return kept(active);
  const before = lowestFree(operation ? await measureDiskAsync(operation) : measureDisk());
  const run = await withIdleWorkspace(
    root,
    async (): Promise<ActionOutcome | null> => {
      if (await activeReason()) return kept('it became active');
      const share = await liveShareKeepReason(root);
      return share ? kept(share) : deleteOwnedDevicesOf(root, { noneIsKept: true, operation, output });
    },
    { purpose, operation },
  );
  if (!run.ran) return kept(`in use: ${run.reasons.join('; ')}`);
  const bytes = operation ? freedSince(before, await measureDiskAsync(operation)) : freedSince(before);
  return run.value ? { ...run.value, bytes } : { status: 'done', bytes, detail: root };
}

function deviceWindowMs(action: MaintenanceAction, context: ActContext): number {
  if (action.olderThanDays !== undefined) return action.olderThanDays * 86_400_000;
  return Math.max(context.worktreeSweep?.graceMs ?? 0, context.settings.protectRecentHours * 3_600_000);
}

async function deleteDevices(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  const { value } = await quietly(() =>
    deleteIdleWorkspaceDevices(action.workspace ?? action.target, {
      windowMs: deviceWindowMs(action, context),
      protectedRoot: context.protectedRoot,
      purpose: 'automatic maintenance',
      operation: context.operation,
    }),
  );
  return value;
}

async function clearArtifacts(action: MaintenanceAction, context: ActContext): Promise<ActionOutcome> {
  return clearArtifact(action, action.kind === 'would-delete-dependencies' ? 'dependencies' : 'build', {
    windowMs: protectWindowMs(context.settings),
    protectedRoot: context.protectedRoot,
    pinned: maintenancePinnedReader(context.operation),
    worktrees: (context.worktrees ??= await artifactWorktreesFor(context.operation)),
    operation: context.operation,
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

async function deleteTrashAction(): Promise<ActionOutcome> {
  const { value: done } = await quietly(() => deleteTrash(undefined));
  if (done.failures) return { status: 'failed', bytes: done.bytes, detail: `${done.failures} could not be deleted` };
  return done.count
    ? { status: 'done', bytes: done.bytes, detail: `${done.count} deleted` }
    : kept('none is deletable now');
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
      return emptyCompilationCache(action);
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
      return kept('automatic maintenance does not stop devices or dev servers for disk');
    case 'would-stop-workspace':
      return action.check === 'idle'
        ? stopIdleWorkspace(action, {
            protectedRoot: context.background ? '' : context.protectedRoot,
            devices: () => {
              const { operation } = context;
              return operation
                ? cachedDeviceActivityAsync(Date.now(), operation.env, operation.signal, operation)
                : cachedDeviceActivity(Date.now());
            },
            operation: context.operation,
            hostedOnly: true,
          })
        : kept(
            'the stim-daemon stops idle workspaces; maintenance stops one with a hosted device after maintenance.idleStopHours',
          );
    case 'would-clear-build-dirs':
    case 'would-delete-dependencies':
      return clearArtifacts(action, context);
    case 'would-stop-gradle-daemons':
      return stopGradleDaemonsAction(action);
    case 'would-delete-gradle-version':
      return deleteGradleVersionAction(action, context);
    case 'would-delete-temp-leftovers':
      return deleteTempLeftoversAction();
    case 'would-delete-trash':
      return deleteTrashAction();
    default:
      return kept('automatic maintenance does not stop devices or dev servers yet');
  }
}
