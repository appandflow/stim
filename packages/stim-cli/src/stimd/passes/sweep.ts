import type { StimContext } from '@stim-cli/core';
import { existsSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import type { MaintenanceAction, MaintenanceSize } from '@stim-cli/core/state';
import { cacheLabel, trimmableCaches } from './budget.ts';
import { readManifest } from '../../cache/cache-manifest.ts';
import {
  collectOrphanedWorkspaces,
  collectWorkspaceOutputs,
  isInsideWorkspaces,
  keptByLock,
} from '../../commands/gc/workspaces.ts';
import {
  collectWorktreeSweep,
  worktreeRemovalReason,
  type WorktreeSkipCode,
  type WorktreeSweep,
} from '../../commands/gc/worktrees.ts';
import { canonicalPath } from '../../commands/gc/paths.ts';
import { formatBytes, isOnMountedVolume, listMountedVolumes } from '../../fs-util.ts';
import { deviceSweepIsScoped } from '../../commands/gc/devices.ts';
import { readParked } from '../../devices/sim-pool.ts';
import { loadConfig } from '../../workspace/config.ts';
import { collectGradleVersions } from '../../commands/gc/gradle-versions.ts';
import {
  collectMemoryReport,
  memorySweepIsScoped,
  planWatchmanStop,
  runningBuild,
  watchmanStopBytes,
} from '../../commands/gc/memory.ts';
import { collectTempLeftovers } from '../../commands/gc/temp-leftovers.ts';
import { collectTrash } from '../../commands/gc/trash.ts';
import { listBuildLocks } from '../../engine/build-lock.ts';
import { listBuildSlots } from '../../engine/build-slots.ts';
import type { OwnedDeviceActivity } from '../../commands/gc/idle.ts';
import { finishedWorkspaces, planDeviceDeletion, planDeviceDeletionAsync } from './devices.ts';
import type { MaintenancePlan } from './plan.ts';
import { planPrune } from './prune.ts';
import { planRecords } from './records.ts';
import type { MaintenanceSettings } from './settings.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { endedPullRequest } from '../../workspace/pull-request.ts';

export async function planSweep({
  settings,
  sizes,
  protectedRoot,
  pinned,
  now,
  devices = true,
  background = false,
  operation,
}: {
  settings: MaintenanceSettings;
  sizes: readonly MaintenanceSize[];
  protectedRoot: string;
  pinned: (workspace: string) => boolean;
  now: number;
  devices?: boolean;
  background?: boolean;
  operation?: StimContext;
}): Promise<MaintenancePlan> {
  const actions: MaintenanceAction[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const blocked: string[] = [];
  const days = settings.olderThanDays;
  const outputs =
    days > 0
      ? await collectWorkspaceOutputs({
          olderThan: days,
          now,
          measure: false,
          signal: operation?.signal,
          operation,
        })
      : { workspaces: [] };
  for (const entry of outputs.workspaces) {
    const root = entry.projectRoot === null ? null : canonicalPath(entry.projectRoot);
    if (root !== null && keptByLock(entry) && entry.keptReason)
      skips.push({ target: root, reason: entry.keptReason, workspace: root });
    if (root === null || !entry.willClear || root === protectedRoot) continue;
    if (pinned(root)) {
      skips.push({ target: root, reason: 'pinned by maintenance.keep', workspace: root });
      continue;
    }
    const size = sizes.find((candidate) => candidate.workspace === root && candidate.category === 'workspace-outputs');
    actions.push({
      kind: 'would-clear-outputs',
      target: root,
      workspace: root,
      bytes: size?.bytes ?? 0,
      olderThanDays: days,
      reason: `idle ${entry.idleDays} days, older than ${days} days (age sweep)`,
      check: 'sweep',
    });
  }
  for (const cache of days > 0
    ? (await trimmableCaches(operation?.env, operation?.cwd)).filter((candidate) => !isInsideWorkspaces(candidate.dir))
    : [])
    actions.push({
      kind: 'would-trim-cache',
      target: cacheLabel(cache),
      dir: cache.dir,
      bytes: 0,
      olderThanDays: days,
      reason: `entries unused for ${days} days (age sweep)`,
      check: 'sweep',
    });
  try {
    const orphans = await collectOrphanedWorkspaces(Object.keys(loadConfig()?.projects ?? {}), listMountedVolumes(), {
      measure: false,
      operation,
    });
    for (const orphan of orphans.orphaned)
      actions.push({
        kind: 'would-remove-orphan',
        target: orphan.dir,
        bytes: orphan.bytes ?? 0,
        reason:
          orphan.projectRoot === null
            ? 'it is empty and has no workspace.json'
            : `its project ${orphan.projectRoot} no longer exists`,
        check: 'sweep',
      });
    for (const kept of orphans.skipped) skips.push({ target: kept.dir, reason: kept.reason });
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    blocked.push(
      `Could not look for orphaned workspace directories: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (devices && days > 0 && !deviceSweepIsScoped(operation?.env ?? process.env))
    for (const kind of ['ios', 'android'] as const)
      for (const record of readParked(kind)) {
        const parkedDays = Math.floor((now - Date.parse(record.parkedAt)) / 86_400_000);
        if (!(parkedDays >= days)) continue;
        const label = `parked ${kind === 'ios' ? 'simulator' : 'emulator'} ${record.name}`;
        actions.push({
          kind: 'would-delete-parked-device',
          target: kind === 'ios' ? record.udid : record.name,
          bytes:
            sizes.find((size) => size.category === 'owned-devices' && !size.workspace && size.name === label)?.bytes ??
            0,
          olderThanDays: days,
          reason: `${label} unused for ${parkedDays} days, older than ${days} days (age sweep)`,
          check: 'sweep',
        });
      }
  const mounted = listMountedVolumes();
  for (const cache of readManifest().caches) {
    if (!isAbsolute(cache.dir) || existsSync(cache.dir) || !isOnMountedVolume(cache.dir, mounted)) continue;
    actions.push({
      kind: 'would-unregister-cache',
      target: cache.dir,
      dir: cache.dir,
      bytes: 0,
      reason: 'its directory no longer exists',
      check: 'sweep',
    });
  }
  const prune = await planPrune({ now, mounted, operation });
  actions.push(...prune.actions.map((action) => ({ ...action, check: 'sweep' as const })));
  skips.push(...prune.skips);
  blocked.push(...prune.blocked);
  const records = await planRecords({ devices, background, operation });
  actions.push(...records.actions.map((action) => ({ ...action, check: 'sweep' as const })));
  skips.push(...records.skips);
  blocked.push(...records.blocked);
  const sweep = await planRung6(settings, { operation });
  actions.push(...sweep.actions.map((action) => ({ ...action, check: 'sweep' as const })));
  skips.push(...sweep.skips);
  return { actions, blocked, skips };
}

async function planGradleDaemonStop(
  blockers: readonly number[],
  operation?: StimContext,
): Promise<{ pids?: number[]; kept?: string }> {
  const report = await collectMemoryReport({ watchman: false, gradle: true }, false, operation);
  const skipped = report.notices.find((notice) => notice.startsWith('memory sweep skipped'));
  if (skipped) return { kept: `the running Gradle processes could not be checked: ${skipped}` };
  const plans = new Map(report.processes.map((entry) => [entry.pid, entry]));
  for (const pid of blockers) {
    const plan = plans.get(pid);
    if (!plan || !plan.reclaimable)
      return {
        kept: `Gradle pid ${pid} keeps it: ${plan?.detail ?? 'it is not a daemon stim gc stops'}`,
      };
  }
  return { pids: [...blockers] };
}

/**
 * Pressure ladder rung 6, which the daily sweep also runs: stop the idle Gradle and Kotlin daemons, shut down an
 * unused watchman whose footprint is over its threshold (a lower one with `memory` pressure), and with `disk`
 * delete the unpinned Gradle versions unmodified for `maintenance.gradleVersionIdleDays`, the recognized TMPDIR
 * leftovers unmodified for 24 hours, and the worktree trash. Gradle and TMPDIR are machine-global, so a scoped
 * Stim home leaves them alone.
 */
export async function planRung6(
  settings: Pick<MaintenanceSettings, 'gradleVersionIdleDays'>,
  {
    disk = true,
    memory = false,
    everyGradleVersion = false,
    now = Date.now(),
    operation,
  }: { disk?: boolean; memory?: boolean; everyGradleVersion?: boolean; now?: number; operation?: StimContext } = {},
): Promise<MaintenancePlan> {
  const actions: MaintenanceAction[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const scoped = memorySweepIsScoped(operation?.env ?? process.env);
  if (scoped)
    skips.push({
      target: 'Gradle daemons and versions',
      reason: 'STIM_HOME scopes this config, and Gradle daemons, Gradle versions and TMPDIR are machine-global',
    });
  const building = scoped ? null : runningBuild(listBuildLocks(), listBuildSlots());
  if (building) skips.push({ target: 'Gradle daemons', reason: building });
  if (!scoped) {
    const report = await collectMemoryReport(
      { watchman: true, gradle: !building, watchmanMinBytes: watchmanStopBytes(memory) },
      false,
      operation,
    );
    const pids = report.processes
      .filter((entry) => entry.reclaimable && (entry.kind === 'gradleDaemon' || entry.kind === 'kotlinDaemon'))
      .map((entry) => entry.pid);
    if (pids.length)
      actions.push({
        kind: 'would-stop-gradle-daemons',
        target: `pid ${pids.join(', ')}`,
        bytes: 0,
        reason: 'these Gradle and Kotlin daemons are idle',
      });
    const daemon = report.processes.find((entry) => entry.kind === 'watchman');
    const decision = planWatchmanStop(daemon, memory);
    if (daemon && decision?.stop)
      actions.push({
        kind: 'would-stop-watchman',
        target: `pid ${daemon.pid}`,
        bytes: 0,
        reason: `the shared watchman daemon holds ${formatBytes(daemon.bytes)} and nothing uses it`,
      });
    else if (daemon && decision && !decision.stop)
      skips.push({ target: `watchman pid ${daemon.pid}`, reason: decision.reason });
  }
  if (!disk) return { actions, blocked: [], skips };
  if (!scoped && settings.gradleVersionIdleDays > 0) {
    const idleDays = everyGradleVersion ? 0 : settings.gradleVersionIdleDays;
    const gradle = await collectGradleVersions({
      operation,
      olderThanDays: idleDays,
      now,
      measure: false,
      pastRunningGradle: true,
    });
    const stop =
      gradle.gradleRunning && gradle.versions.some((entry) => entry.willDelete)
        ? await planGradleDaemonStop(gradle.gradleRunningPids, operation)
        : null;
    if (stop?.pids && !actions.some((action) => action.kind === 'would-stop-gradle-daemons'))
      actions.push({
        kind: 'would-stop-gradle-daemons',
        target: `pid ${stop.pids.join(', ')}`,
        bytes: 0,
        reason: 'these idle Gradle and Kotlin daemons keep unpinned Gradle versions',
      });
    for (const entry of gradle.versions) {
      if (entry.willDelete && !stop?.kept)
        actions.push({
          kind: 'would-delete-gradle-version',
          target: entry.version,
          dir: gradle.home,
          bytes: 0,
          olderThanDays: idleDays,
          reason: everyGradleVersion
            ? 'no registered project pins it, and the disk is at critical'
            : `no registered project pins it and it is unmodified for ${idleDays} days`,
        });
      else
        skips.push({
          target: `Gradle ${entry.version}`,
          reason: (entry.willDelete && stop?.kept) || entry.detail || 'kept',
        });
    }
  }
  const leftovers = await collectTempLeftovers({ now, env: operation?.env, signal: operation?.signal, operation });
  const deletable = leftovers?.entries.filter((entry) => entry.willDelete) ?? [];
  if (leftovers && deletable.length)
    actions.push({
      kind: 'would-delete-temp-leftovers',
      target: leftovers.root,
      bytes: deletable.reduce((sum, entry) => sum + entry.bytes, 0),
      reason: 'Stim temp directories, xctrace recordings and SwiftPM temp directories unmodified for 24 hours',
    });
  const trash = await collectTrash({ signal: operation?.signal, operation });
  const trashed = trash?.entries.filter((entry) => entry.willDelete) ?? [];
  if (trash && trashed.length)
    actions.push({
      kind: 'would-delete-trash',
      target: trash.root,
      bytes: trashed.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
      reason: 'worktree removals finished moving these entries out of their worktrees',
    });
  return { actions, blocked: [], skips };
}

const UNREPORTED_KEEPS: ReadonlySet<WorktreeSkipCode> = new Set([
  'not-a-worktree',
  'bare-repository',
  'source-checkout',
]);

export interface WorktreePlan extends MaintenancePlan {
  sweep: WorktreeSweep;
  /** The merged or ended worktree kept only for its grace period that becomes removable first. */
  nextRemoval?: { target: string; at: number };
}

export async function planWorktrees({
  protectedRoot,
  pinned,
  now,
  graceMs,
  sizes,
  protectRecentMs = 0,
  refresh,
  idleDays = null,
  operation,
  deviceActivity,
}: {
  protectedRoot: string;
  pinned: (workspace: string) => boolean;
  now: number;
  idleDays?: number | null;
  graceMs?: number;
  sizes?: readonly MaintenanceSize[];
  protectRecentMs?: number;
  refresh?: boolean;
  operation?: StimContext;
  /** Reads owned device activity for an operation; a new listing when absent. */
  deviceActivity?: (withSims: boolean) => Promise<OwnedDeviceActivity[]>;
}): Promise<WorktreePlan> {
  const sweep = await collectWorktreeSweep({
    idle: idleDays !== null,
    olderThan: idleDays,
    now,
    operation,
    ...(graceMs === undefined ? {} : { graceMs }),
    ...(refresh === undefined ? {} : { refresh }),
  });
  const actions: MaintenanceAction[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const keep: WorktreeSweep['worktrees'] = [];
  let nextRemoval: WorktreePlan['nextRemoval'];
  const keptReason = (worktree: WorktreeSweep['worktrees'][number]) => {
    const path = canonicalPath(worktree.path);
    return protectedRoot === path || protectedRoot.startsWith(`${path}${sep}`)
      ? 'the command that started this pass runs inside it'
      : worktree.keys.some(pinned)
        ? 'pinned by maintenance.keep'
        : null;
  };
  for (const worktree of sweep.worktrees) {
    if (worktree.skipped) {
      const at = worktree.eligibleAt;
      if (
        worktree.skipCode === 'recent-activity' &&
        at !== null &&
        (!nextRemoval || at < nextRemoval.at) &&
        (worktree.merge?.merged || endedPullRequest(worktree.pullRequest)) &&
        !keptReason(worktree)
      )
        nextRemoval = { target: worktree.path, at };
      if (
        worktree.skipCode &&
        !UNREPORTED_KEEPS.has(worktree.skipCode) &&
        (idleDays !== null || worktree.merge?.merged || endedPullRequest(worktree.pullRequest))
      )
        skips.push({
          target: worktree.path,
          reason: worktree.skipped,
          code: worktree.skipCode,
          workspace: canonicalPath(worktree.path),
        });
      continue;
    }
    const reason = keptReason(worktree);
    if (reason) {
      skips.push({ target: worktree.path, reason });
      continue;
    }
    keep.push(worktree);
    actions.push({
      kind: 'would-remove-worktree',
      target: worktree.path,
      bytes: 0,
      reason: worktreeRemovalReason(worktree, sweep),
      check:
        idleDays !== null && !worktree.merge?.merged && !endedPullRequest(worktree.pullRequest) ? 'sweep' : 'worktree',
    });
  }
  if (sizes) {
    const options: Parameters<typeof planDeviceDeletion>[0] = {
      roots: finishedWorkspaces(sweep, now),
      windowMs: Math.max(sweep.graceMs, protectRecentMs),
      reason: 'finished-worktree check',
      protectedRoot,
      pinned,
      sizes,
      now,
      extra: { check: 'worktree' },
      env: operation?.env,
    };
    const devices = operation
      ? await planDeviceDeletionAsync(options, operation.signal, operation, deviceActivity)
      : planDeviceDeletion(options);
    actions.push(...devices.actions);
    skips.push(...devices.skips);
  }
  return {
    actions,
    blocked: [],
    skips,
    sweep: { ...sweep, worktrees: keep },
    ...(nextRemoval ? { nextRemoval } : {}),
  };
}
