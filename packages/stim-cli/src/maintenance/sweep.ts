import { existsSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import type { MaintenanceAction, MaintenanceSize } from '@stim-cli/core/state';
import { cacheLabel, trimmableCaches } from '../budget.ts';
import { readManifest } from '../cache/cache-manifest.ts';
import { collectOrphanedWorkspaces, collectWorkspaceOutputs, isInsideWorkspaces } from '../commands/gc/workspaces.ts';
import { collectWorktreeSweep, worktreeRemovalReason, type WorktreeSweep } from '../commands/gc/worktrees.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { isOnMountedVolume, listMountedVolumes } from '../fs-util.ts';
import { loadConfig } from '../workspace/config.ts';
import type { MaintenancePlan } from './plan.ts';
import type { MaintenanceSettings } from './settings.ts';

export function planSweep({
  settings,
  sizes,
  protectedRoot,
  pinned,
  now,
}: {
  settings: MaintenanceSettings;
  sizes: readonly MaintenanceSize[];
  protectedRoot: string;
  pinned: (workspace: string) => boolean;
  now: number;
}): MaintenancePlan {
  const actions: MaintenanceAction[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const blocked: string[] = [];
  const days = settings.olderThanDays;
  for (const entry of collectWorkspaceOutputs({ olderThan: days, now, measure: false }).workspaces) {
    const root = entry.projectRoot === null ? null : canonicalPath(entry.projectRoot);
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
  for (const cache of trimmableCaches().filter((candidate) => !isInsideWorkspaces(candidate.dir)))
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
    const orphans = collectOrphanedWorkspaces(Object.keys(loadConfig()?.projects ?? {}), listMountedVolumes(), {
      measure: false,
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
    blocked.push(
      `Could not look for orphaned workspace directories: ${error instanceof Error ? error.message : error}`,
    );
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
}: {
  protectedRoot: string;
  pinned: (workspace: string) => boolean;
  now: number;
}): Promise<WorktreePlan> {
  const sweep = await collectWorktreeSweep({ idle: false, olderThan: null, now });
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
      reason: worktreeRemovalReason(worktree),
      check: 'worktree',
    });
  }
  return { actions, blocked: [], skips, sweep: { ...sweep, worktrees: keep } };
}
