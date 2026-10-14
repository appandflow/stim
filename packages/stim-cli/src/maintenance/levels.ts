import type { DiskPressureLevel, MaintenanceAction, MaintenanceSize } from '@stim-cli/core/state';
import { DEVICE_LIST_TIMEOUT_MS, deviceSweepIsScoped } from '../commands/gc/devices.ts';
import { collectOwnedDeviceActivity, workspaceBuildInProgress } from '../commands/gc/idle.ts';
import { listAllIosSims } from '../devices/ios.ts';
import { leaseIsExpired, listLeaseFiles } from '../engine/device-lease.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { workspaceActivity } from '../devices/activity.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { readParked } from '../devices/sim-pool.ts';
import { loadConfig } from '../workspace/config.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { workspaceLastUsed } from '../workspace/workspace-state.ts';
import { formatBytes } from '../fs-util.ts';
import { collectArtifacts } from './artifacts.ts';
import type { MaintenancePlan } from './plan.ts';
import type { MaintenanceSettings } from './settings.ts';
import { planWorktrees, type WorktreePlan } from './sweep.ts';

interface LevelContext {
  settings: MaintenanceSettings;
  sizes: readonly MaintenanceSize[];
  protectedRoot: string;
  pinned: (workspace: string) => boolean;
  now: number;
}

function deviceActiveReason(root: string, now: number): string | null {
  const holder = canonicalPath(root);
  for (const { lease } of listLeaseFiles())
    if (lease && !leaseIsExpired(lease, now) && canonicalPath(lease.holder) === holder)
      return `it holds the ${lease.platform} device lease on ${lease.deviceName ?? lease.id}`;
  if (!hasOwnedDevices(root)) return null;
  let sims;
  try {
    sims = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
  } catch {
    return 'its owned devices cannot be listed to prove them idle';
  }
  const busy = collectOwnedDeviceActivity(loadConfig(), sims, now).find(
    (device) => device.project === root && device.activity.state !== 'idle',
  );
  return busy ? `its owned ${busy.kind} device ${busy.name} is ${busy.activity.state}` : null;
}

/** Why a workspace is not inactive for the pressure window, or null when maintenance may stop it. */
export function workspaceActiveReason(root: string, now: number, windowMs: number): string | null {
  if (workspaceBuildInProgress(root)) return 'a build is in progress';
  const device = deviceActiveReason(root, now);
  if (device) return device;
  const activity = workspaceActivity(root, now);
  const at = Date.parse(activity.lastActivityAt ?? '');
  if (activity.state !== 'idle') return `its activity is ${activity.state}`;
  if (!Number.isFinite(at)) return 'its last activity is unknown';
  const used = workspaceLastUsed(root);
  const last = Number.isFinite(used) ? Math.max(at, used) : at;
  return now - last < windowMs ? `used within the last ${Math.round(windowMs / 60_000)} minutes` : null;
}

function hasOwnedDevices(root: string): boolean {
  try {
    return projectDeviceSlots(loadConfig()?.projects?.[root]).some(
      ({ platforms }) => platforms.ios?.owned === true || platforms.android?.owned === true,
    );
  } catch {
    return false;
  }
}

function planLevel2({ settings, sizes, protectedRoot, pinned, now }: LevelContext): MaintenancePlan {
  const windowMs = settings.pressureProtectMinutes * 60_000;
  const actions: MaintenanceAction[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const reason = `disk pressure level 2, idle for ${settings.pressureProtectMinutes} minutes`;
  const outputs = collectWorkspaceOutputs({ olderThan: null, now, measure: false })
    .workspaces.flatMap((entry) => {
      const root = entry.projectRoot === null ? null : canonicalPath(entry.projectRoot);
      if (root === null || !entry.willClear || root === protectedRoot || pinned(root)) return [];
      const used = workspaceLastUsed(root);
      return Number.isFinite(used) && now - used >= windowMs ? [{ root, used }] : [];
    })
    .toSorted((a, b) => a.used - b.used);
  for (const { root } of outputs) {
    const size = sizes.find((entry) => entry.workspace === root && entry.category === 'workspace-outputs');
    actions.push({
      kind: 'would-clear-outputs',
      target: root,
      workspace: root,
      bytes: size?.bytes ?? 0,
      reason,
      level: 2,
    });
  }
  if (!deviceSweepIsScoped())
    for (const platform of ['ios', 'android'] as const)
      for (const record of readParked(platform))
        actions.push({
          kind: 'would-delete-parked-device',
          target: platform === 'ios' ? record.udid : record.name,
          bytes: 0,
          reason: `parked ${platform} device, disk pressure level 2`,
          level: 2,
        });
  const build = collectArtifacts('build', { now, windowMs, protectedRoot, pinned });
  for (const candidate of build.candidates)
    actions.push({ kind: 'would-clear-build-dirs', target: candidate.path, bytes: 0, reason, level: 2 });
  skips.push(...build.skips);
  return { actions, blocked: [], skips };
}

async function planLevel3({
  settings,
  sizes,
  protectedRoot,
  pinned,
  now,
}: LevelContext): Promise<MaintenancePlan & { sweep?: WorktreePlan['sweep'] }> {
  const windowMs = settings.pressureProtectMinutes * 60_000;
  const actions: MaintenanceAction[] = [];
  const blocked: string[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const reason = `disk pressure level 3, idle for ${settings.pressureProtectMinutes} minutes`;
  for (const size of sizes.filter((entry) => entry.category === 'compilation-cache')) {
    if (size.blocked) {
      skips.push({ target: size.dir, reason: size.blocked });
      blocked.push(
        `the Swift compilation cache (${formatBytes(size.bytes)}) can only be emptied whole and is kept: ${size.blocked}`,
      );
    } else
      actions.push({
        kind: 'would-empty-cache',
        target: size.dir,
        dir: size.dir,
        bytes: size.bytes,
        reason: 'disk pressure level 3',
        level: 3,
      });
  }
  const worktrees = settings.removeFinishedWorktrees
    ? await planWorktrees({ protectedRoot, pinned, now, level: 3, graceMs: windowMs })
    : null;
  actions.push(...(worktrees?.actions ?? []));
  skips.push(...(worktrees?.skips ?? []));
  for (const root of Object.keys(loadConfig()?.projects ?? {}).map(canonicalPath)) {
    if (root === protectedRoot || pinned(root)) continue;
    const serving = workspaceInUse(root, { managedLocks: false, hosted: false, nativeRun: false }).length > 0;
    if (!serving && !hasOwnedDevices(root)) continue;
    const active = workspaceActiveReason(root, now, windowMs);
    if (active) skips.push({ target: root, reason: active, workspace: root });
    else actions.push({ kind: 'would-stop-workspace', target: root, workspace: root, bytes: 0, reason, level: 3 });
  }
  const dependencies = collectArtifacts('dependencies', { now, windowMs, protectedRoot, pinned });
  for (const candidate of dependencies.candidates)
    actions.push({ kind: 'would-delete-dependencies', target: candidate.path, bytes: 0, reason, level: 3 });
  skips.push(...dependencies.skips);
  return { actions, blocked, skips, ...(worktrees ? { sweep: worktrees.sweep } : {}) };
}

/** Level 2 and 3 actions for a pass that measured `level`; level 1 is the regular plan. */
export async function planPressureLevels(
  level: DiskPressureLevel,
  context: LevelContext,
): Promise<MaintenancePlan & { pressureSweep?: WorktreePlan['sweep'] }> {
  if (level < 1) return { actions: [], blocked: [], skips: [] };
  const second = planLevel2(context);
  if (level < 3) return second;
  const third = await planLevel3(context);
  return {
    actions: [...second.actions, ...third.actions],
    blocked: third.blocked,
    skips: [...second.skips, ...third.skips],
    ...(third.sweep ? { pressureSweep: third.sweep } : {}),
  };
}
