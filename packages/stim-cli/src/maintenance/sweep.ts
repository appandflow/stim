import type { StimContext } from '@stim-cli/core';
import { existsSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import type { MaintenanceAction, MaintenanceSize } from '@stim-cli/core/state';
import { cacheLabel, trimmableCaches } from '../budget.ts';
import { readManifest } from '../cache/cache-manifest.ts';
import { collectOrphanedWorkspaces, collectWorkspaceOutputs, isInsideWorkspaces } from '../commands/gc/workspaces.ts';
import { collectWorktreeSweep, worktreeRemovalReason, type WorktreeSweep } from '../commands/gc/worktrees.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { isOnMountedVolume, listMountedVolumes } from '../fs-util.ts';
import { deviceSweepIsScoped } from '../commands/gc/devices.ts';
import { readParked } from '../devices/sim-pool.ts';
import { loadConfig } from '../workspace/config.ts';
import { finishedWorkspaces, planDeviceDeletion, planDeviceDeletionAsync } from './devices.ts';
import type { MaintenancePlan } from './plan.ts';
import type { MaintenanceSettings } from './settings.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { endedPullRequest } from '../workspace/pull-request.ts';
import { LOCKED_REASON } from '../workspace/worktree.ts';

export async function planSweep({
  settings,
  sizes,
  protectedRoot,
  pinned,
  now,
  devices = true,
  operation,
}: {
  settings: MaintenanceSettings;
  sizes: readonly MaintenanceSize[];
  protectedRoot: string;
  pinned: (workspace: string) => boolean;
  now: number;
  devices?: boolean;
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
    if (root !== null && entry.keptCode === 'locked')
      skips.push({ target: root, reason: LOCKED_REASON, workspace: root });
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
    ? trimmableCaches(operation?.env, operation?.cwd).filter((candidate) => !isInsideWorkspaces(candidate.dir))
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
        reason: `its project ${orphan.projectRoot} no longer exists`,
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
  if (devices && settings.deviceIdleDays > 0) {
    const options: Parameters<typeof planDeviceDeletion>[0] = {
      roots: Object.keys(loadConfig()?.projects ?? {}).map((root) => ({ root })),
      windowMs: settings.deviceIdleDays * 86_400_000,
      reason: `idle for ${settings.deviceIdleDays} days (age sweep)`,
      protectedRoot,
      pinned,
      sizes,
      now,
      extra: { check: 'sweep', olderThanDays: settings.deviceIdleDays },
      env: operation?.env,
    };
    const reaped = operation
      ? await planDeviceDeletionAsync(options, operation.signal, operation)
      : planDeviceDeletion(options);
    actions.push(...reaped.actions);
    skips.push(...reaped.skips);
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
  return { actions, blocked, skips };
}

export interface WorktreePlan extends MaintenancePlan {
  sweep: WorktreeSweep;
}

export async function planWorktrees({
  protectedRoot,
  pinned,
  now,
  level,
  graceMs,
  sizes,
  protectRecentMs = 0,
  refresh,
  idleDays = null,
  operation,
}: {
  protectedRoot: string;
  pinned: (workspace: string) => boolean;
  now: number;
  level?: 3;
  idleDays?: number | null;
  graceMs?: number;
  sizes?: readonly MaintenanceSize[];
  protectRecentMs?: number;
  refresh?: boolean;
  operation?: StimContext;
}): Promise<WorktreePlan> {
  const sweep = await collectWorktreeSweep({
    idle: idleDays !== null,
    olderThan: idleDays,
    now,
    underPressure: level === 3,
    operation,
    ...(graceMs === undefined ? {} : { graceMs }),
    ...(refresh === undefined ? {} : { refresh }),
  });
  const actions: MaintenanceAction[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const keep: WorktreeSweep['worktrees'] = [];
  for (const worktree of sweep.worktrees) {
    if (worktree.skipped) continue;
    const path = canonicalPath(worktree.path);
    const reason =
      protectedRoot === path || protectedRoot.startsWith(`${path}${sep}`)
        ? 'the command that started this pass runs inside it'
        : worktree.keys.some(pinned)
          ? 'pinned by maintenance.keep'
          : null;
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
        level === undefined && idleDays !== null && !worktree.merge?.merged && !endedPullRequest(worktree.pullRequest)
          ? 'sweep'
          : 'worktree',
      ...(level ? { level } : {}),
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
      ? await planDeviceDeletionAsync(options, operation.signal, operation)
      : planDeviceDeletion(options);
    actions.push(...devices.actions);
    skips.push(...devices.skips);
  }
  return { actions, blocked: [], skips, sweep: { ...sweep, worktrees: keep } };
}
