import type { MaintenanceAction, MaintenanceSize } from '@stim-cli/core/state';
import type { StimContext } from '@stim-cli/core';
import { DEVICE_LIST_TIMEOUT_MS, deviceSweepIsScoped } from '../commands/gc/devices.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { worktreeRemovalReason, type WorktreeSweep } from '../commands/gc/worktrees.ts';
import { formatLongDuration } from '../command-output.ts';
import { workspaceDeviceLastUseAt } from '../devices/activity.ts';
import { listAvds, ownedAvdDirectory } from '../devices/android.ts';
import { dueIdleDevices } from '../devices/idle-shutdown.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listAllIosSims, type IosSimRecord } from '../devices/ios.ts';
import { readParked } from '../devices/sim-pool.ts';
import { measuredDirectorySizeAsync } from '../fs-util.ts';
import { loadConfig } from '../workspace/config.ts';
import { deviceIdleShutdownMinutesSetting, resolveProjectSettings } from '../workspace/settings.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { workspaceLastUsed } from '../workspace/workspace-state.ts';
import { endedPullRequest } from '../workspace/pull-request.ts';
import {
  cachedDeviceActivity,
  cachedDeviceActivityAsync,
  hasOwnedDevices,
  usedWithin,
  workspaceActiveReason,
  workspaceActiveReasonAsync,
} from './activity.ts';
import type { MaintenancePlan } from './plan.ts';

const AVD_SIZE_TIMEOUT_MS = 30_000;

export interface OwnedDeviceReads {
  sims?: () => IosSimRecord[];
  avds?: () => string[];
  avdDirectory?: (name: string) => string | null;
  size?: (dir: string) => number | null | Promise<number | null>;
}

export interface OwnedDeviceUsage {
  kind: 'ios' | 'android';
  name: string;
  dir: string;
  bytes: number;
  workspace?: string;
}

/** The disk of each owned simulator or emulator of a registered workspace and of each parked device. */
export async function ownedDeviceUsage(
  failure: (target: string, workspace?: string) => void,
  {
    sims = () => listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }),
    avds = () => listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }),
    avdDirectory = ownedAvdDirectory,
    size = (dir) => measuredDirectorySizeAsync(dir, { timeoutMs: AVD_SIZE_TIMEOUT_MS }),
  }: OwnedDeviceReads = {},
): Promise<OwnedDeviceUsage[]> {
  const config = loadConfig();
  const owned: { kind: 'ios' | 'android'; id: string; workspace?: string }[] = [];
  for (const [root, project] of Object.entries(config?.projects ?? {}))
    for (const { platforms } of projectDeviceSlots(project)) {
      if (platforms.ios?.owned && platforms.ios.deviceUdid)
        owned.push({ kind: 'ios', id: platforms.ios.deviceUdid, workspace: canonicalPath(root) });
      if (platforms.android?.owned && platforms.android.avdName)
        owned.push({ kind: 'android', id: platforms.android.avdName, workspace: canonicalPath(root) });
    }
  for (const record of readParked('ios', { config })) owned.push({ kind: 'ios', id: record.udid });
  for (const record of readParked('android', { config })) owned.push({ kind: 'android', id: record.name });
  const listed = <T>(read: () => T[], label: string): T[] | null => {
    if (!owned.length) return [];
    try {
      return read();
    } catch {
      failure(label);
      return null;
    }
  };
  const iosRecords = owned.some((device) => device.kind === 'ios') ? listed(sims, 'the simulator list') : [];
  const avdNames = owned.some((device) => device.kind === 'android') ? listed(avds, 'the emulator list') : [];
  const usage: OwnedDeviceUsage[] = [];
  for (const device of owned) {
    const workspace = device.workspace ? { workspace: device.workspace } : {};
    if (device.kind === 'ios') {
      const sim = iosRecords?.find((record) => record.udid === device.id);
      if (sim && typeof sim.dataPathSize === 'number')
        usage.push({
          kind: 'ios',
          name: sim.name,
          dir: sim.dataPath ?? device.id,
          bytes: sim.dataPathSize,
          ...workspace,
        });
      continue;
    }
    const dir = avdNames?.includes(device.id) ? avdDirectory(device.id) : null;
    if (!dir) continue;
    const bytes = await size(dir);
    if (bytes === null) failure(dir, device.workspace);
    else usage.push({ kind: 'android', name: device.id, dir, bytes, ...workspace });
  }
  return usage;
}

export async function measureOwnedDevices(
  now: number,
  failure: (target: string, workspace?: string) => void,
): Promise<MaintenanceSize[]> {
  return (await ownedDeviceUsage(failure)).map(({ kind, name, dir, bytes, workspace }) => {
    const size: MaintenanceSize = {
      name: `${workspace ? 'owned' : 'parked'} ${kind === 'ios' ? 'simulator' : 'emulator'} ${name}`,
      category: 'owned-devices',
      dir,
      bytes,
      measuredAt: now,
    };
    if (workspace) size.workspace = workspace;
    return size;
  });
}

/**
 * Plans deleting the owned simulators and emulators of each workspace in `roots` that is idle for `windowMs`: no dev
 * server, driver, lease, lock, build or recorded use in that window. Devices are recreated on the next run.
 */
interface DeviceDeletionOptions {
  roots: readonly { root: string; reason?: string }[];
  windowMs: number;
  reason: string;
  protectedRoot: string;
  pinned: (workspace: string) => boolean;
  sizes: readonly MaintenanceSize[];
  now: number;
  extra: Pick<MaintenanceAction, 'level' | 'check' | 'olderThanDays'>;
  env?: NodeJS.ProcessEnv;
}

function* deviceDeletionChecks({
  roots,
  windowMs,
  reason,
  protectedRoot,
  pinned,
  sizes,
  now,
  extra,
  env = process.env,
}: DeviceDeletionOptions): Generator<string, MaintenancePlan, string | null> {
  const plan: MaintenancePlan = { actions: [], blocked: [], skips: [] };
  if (deviceSweepIsScoped(env)) return plan;
  for (const entry of roots) {
    const root = canonicalPath(entry.root);
    if (root === protectedRoot || !hasOwnedDevices(root)) continue;
    const kept = pinned(root)
      ? 'pinned by maintenance.keep'
      : now - workspaceLastUsed(root) < windowMs
        ? usedWithin(windowMs)
        : (workspaceInUse(root).map((why) => `in use: ${why}`)[0] ?? (yield root));
    if (kept) {
      plan.skips.push({ target: root, reason: kept, workspace: root });
      continue;
    }
    plan.actions.push({
      kind: 'would-delete-devices',
      target: root,
      workspace: root,
      bytes: sizes
        .filter((size) => size.category === 'owned-devices' && size.workspace === root)
        .reduce((sum, size) => sum + size.bytes, 0),
      reason: entry.reason ? `${entry.reason}, ${reason}` : reason,
      ...extra,
    });
  }
  return plan;
}

export function planDeviceDeletion(options: DeviceDeletionOptions): MaintenancePlan {
  const activity = cachedDeviceActivity(options.now);
  const checks = deviceDeletionChecks(options);
  let step = checks.next();
  while (!step.done) step = checks.next(workspaceActiveReason(step.value, options.now, options.windowMs, activity));
  return step.value;
}

export async function planDeviceDeletionAsync(
  options: DeviceDeletionOptions,
  signal: AbortSignal,
  operation?: StimContext,
): Promise<MaintenancePlan> {
  const activity = cachedDeviceActivityAsync(options.now, options.env ?? process.env, signal, operation);
  const checks = deviceDeletionChecks(options);
  let step = checks.next();
  while (!step.done) {
    signal.throwIfAborted();
    step = checks.next(await workspaceActiveReasonAsync(step.value, options.now, options.windowMs, activity, signal));
  }
  return step.value;
}

/**
 * The workspaces of linked worktrees that gc keeps although their branch is merged or their pull request ended,
 * such as a dirty one. A worktree gc removes takes its devices with it.
 */
export function finishedWorkspaces(
  sweep: WorktreeSweep | null | undefined,
  now: number,
): { root: string; reason: string }[] {
  const kept = new Set([
    'not-a-worktree',
    'bare-repository',
    'source-checkout',
    'source-checkout-unknown',
    'locked',
    'nested-worktree',
    'recent-activity',
    'activity-unknown',
  ]);
  if (!sweep) return [];
  return sweep.worktrees.flatMap((worktree) => {
    if (worktree.skipped === null || kept.has(worktree.skipCode ?? '')) return [];
    const merged = worktree.merge?.merged ? worktree.merge.mergedAt : null;
    const ended = endedPullRequest(worktree.pullRequest);
    if (merged === null && !ended) return [];
    const finishedAt = Math.max(merged ?? -Infinity, ended ? (ended.endedAt ?? now) : -Infinity);
    if (now - finishedAt < sweep.graceMs) return [];
    const reason = `its worktree is finished (${worktreeRemovalReason(worktree, sweep)}) but kept`;
    return worktree.keys.map((root) => ({ root: canonicalPath(root), reason }));
  });
}

/** Each workspace's effective devices.idleShutdownMinutes, or 0 when it cannot be resolved. */
export function idleShutdownMinutes(root: string): number {
  try {
    return deviceIdleShutdownMinutesSetting(resolveProjectSettings(root).settings);
  } catch {
    return 0;
  }
}

/**
 * Plans shutting down each booted owned simulator and emulator idle for its workspace's devices.idleShutdownMinutes,
 * whether or not a supervisor runs there. The devices are shut down, never deleted.
 */
export function planIdleShutdown({
  protectedRoot,
  now,
  env = process.env,
}: {
  protectedRoot: string;
  now: number;
  env?: NodeJS.ProcessEnv;
}): MaintenancePlan {
  const plan: MaintenancePlan = { actions: [], blocked: [], skips: [] };
  if (deviceSweepIsScoped(env)) return plan;
  const minutes = new Map(
    Object.keys(loadConfig()?.projects ?? {}).flatMap((root) => {
      const value = canonicalPath(root) === protectedRoot ? 0 : idleShutdownMinutes(root);
      return value > 0 ? [[root, value] as const] : [];
    }),
  );
  if (minutes.size === 0) return plan;
  for (const { device, idleForMs } of dueIdleDevices(undefined, Math.min(...minutes.values()) * 60_000, now)) {
    const own = minutes.get(device.project);
    if (own === undefined || idleForMs < own * 60_000 || now - workspaceDeviceLastUseAt(device.project) < own * 60_000)
      continue;
    const root = canonicalPath(device.project);
    plan.actions.push({
      kind: 'would-shutdown-device',
      target: device.id,
      workspace: root,
      bytes: 0,
      reason: `${device.kind === 'ios' ? 'simulator' : 'emulator'} ${device.name} idle ${formatLongDuration(idleForMs)}, over devices.idleShutdownMinutes ${own}`,
    });
  }
  return plan;
}
