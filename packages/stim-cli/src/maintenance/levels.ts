import type { StimContext } from '@stim-cli/core';
import type { DiskPressureLevel, MaintenanceAction, MaintenanceSize } from '@stim-cli/core/state';
import { deviceSweepIsScoped } from '../commands/gc/devices.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { readParked } from '../devices/sim-pool.ts';
import { loadConfig } from '../workspace/config.ts';
import { workspaceInUse } from '../workspace/in-use.ts';
import { workspaceLastUsed } from '../workspace/workspace-state.ts';
import { formatBytes } from '../fs-util.ts';
import { cachedDeviceActivityAsync, workspaceActiveReason, workspaceActiveReasonAsync } from './activity.ts';
import { collectArtifacts, collectArtifactsAsync } from './artifacts.ts';
import type { MaintenancePlan } from './plan.ts';
import type { MaintenanceSettings } from './settings.ts';
import { planDeviceDeletion, planDeviceDeletionAsync } from './devices.ts';
import { planWorktrees, type WorktreePlan } from './sweep.ts';
import { collectGradleVersions } from '../commands/gc/gradle-versions.ts';
import { collectMemoryReport, memorySweepIsScoped } from '../commands/gc/memory.ts';
import { collectTempLeftovers } from '../commands/gc/temp-leftovers.ts';

interface LevelContext {
  settings: MaintenanceSettings;
  sizes: readonly MaintenanceSize[];
  protectedRoot: string;
  pinned: (workspace: string) => boolean;
  now: number;
  refresh?: boolean;
  operation?: StimContext;
}

async function planLevel2({
  settings,
  sizes,
  protectedRoot,
  pinned,
  now,
  operation,
}: LevelContext): Promise<MaintenancePlan> {
  const windowMs = settings.pressureProtectMinutes * 60_000;
  const actions: MaintenanceAction[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const reason = `disk pressure level 2, idle for ${settings.pressureProtectMinutes} minutes`;
  const outputs = (
    await collectWorkspaceOutputs({ olderThan: null, now, measure: false, signal: operation?.signal, operation })
  ).workspaces
    .flatMap((entry) => {
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
  if (!deviceSweepIsScoped(operation?.env ?? process.env))
    for (const platform of ['ios', 'android'] as const)
      for (const record of readParked(platform))
        actions.push({
          kind: 'would-delete-parked-device',
          target: platform === 'ios' ? record.udid : record.name,
          bytes: 0,
          reason: `parked ${platform} device, disk pressure level 2`,
          level: 2,
        });
  const leftovers = await collectTempLeftovers({ now, env: operation?.env, signal: operation?.signal, operation });
  const deletable = leftovers?.entries.filter((entry) => entry.willDelete) ?? [];
  if (leftovers && deletable.length)
    actions.push({
      kind: 'would-delete-temp-leftovers',
      target: leftovers.root,
      bytes: deletable.reduce((sum, entry) => sum + entry.bytes, 0),
      reason:
        'disk pressure level 2, Stim temp directories, xctrace recordings and SwiftPM temp directories unmodified for 24 hours',
      level: 2,
    });
  const options = { now, windowMs, protectedRoot, pinned };
  const build = operation
    ? await collectArtifactsAsync('build', options, operation.signal, operation)
    : collectArtifacts('build', options);
  for (const candidate of build.candidates)
    actions.push({ kind: 'would-clear-build-dirs', target: candidate.path, bytes: 0, reason, level: 2 });
  skips.push(...build.skips);
  const deviceOptions: Parameters<typeof planDeviceDeletion>[0] = {
    roots: Object.keys(loadConfig()?.projects ?? {}).map((root) => ({ root })),
    windowMs,
    reason,
    protectedRoot,
    pinned,
    sizes,
    now,
    extra: { level: 2 },
    env: operation?.env,
  };
  const devices = operation
    ? await planDeviceDeletionAsync(deviceOptions, operation.signal, operation)
    : planDeviceDeletion(deviceOptions);
  actions.push(...devices.actions);
  skips.push(...devices.skips);
  return { actions, blocked: [], skips };
}

async function planGradleDaemonStop(
  blockers: readonly number[],
  operation?: StimContext,
): Promise<{ pids?: number[]; kept?: string }> {
  if (memorySweepIsScoped(operation?.env ?? process.env))
    return { kept: 'STIM_HOME scopes this config, so the machine-global Gradle daemons that keep it are not stopped' };
  const report = await collectMemoryReport({ watchman: false, gradle: true }, false, operation);
  const skipped = report.notices.find((notice) => notice.startsWith('memory sweep skipped'));
  if (skipped) return { kept: `the running Gradle processes could not be checked: ${skipped}` };
  const plans = new Map(report.processes.map((entry) => [entry.pid, entry]));
  for (const pid of blockers) {
    const plan = plans.get(pid);
    if (!plan || !plan.reclaimable)
      return {
        kept: `Gradle pid ${pid} keeps it: ${plan?.detail ?? 'it is not a daemon gc --delete --cache gradle-daemons stops'}`,
      };
  }
  return { pids: [...blockers] };
}

async function planLevel3({
  settings,
  sizes,
  protectedRoot,
  pinned,
  now,
  refresh,
  operation,
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
    ? await planWorktrees({ protectedRoot, pinned, now, level: 3, graceMs: windowMs, refresh, operation })
    : null;
  actions.push(...(worktrees?.actions ?? []));
  skips.push(...(worktrees?.skips ?? []));
  const activity = operation ? cachedDeviceActivityAsync(now, operation.env, operation.signal, operation) : null;
  for (const root of Object.keys(loadConfig()?.projects ?? {}).map(canonicalPath)) {
    if (root === protectedRoot || pinned(root)) continue;
    if (workspaceInUse(root, { managedLocks: false, hosted: false, nativeRun: false }).length === 0) continue;
    const active = activity
      ? await workspaceActiveReasonAsync(root, now, windowMs, activity, operation?.signal)
      : workspaceActiveReason(root, now, windowMs);
    if (active) skips.push({ target: root, reason: active, workspace: root });
    else actions.push({ kind: 'would-stop-workspace', target: root, workspace: root, bytes: 0, reason, level: 3 });
  }
  const artifactOptions = { now, windowMs, protectedRoot, pinned };
  const dependencies = operation
    ? await collectArtifactsAsync('dependencies', artifactOptions, operation.signal, operation)
    : collectArtifacts('dependencies', artifactOptions);
  for (const candidate of dependencies.candidates)
    actions.push({ kind: 'would-delete-dependencies', target: candidate.path, bytes: 0, reason, level: 3 });
  skips.push(...dependencies.skips);
  if (settings.gradleVersionIdleDays > 0) {
    const gradle = await collectGradleVersions({
      operation,
      olderThanDays: settings.gradleVersionIdleDays,
      now,
      measure: false,
      pastRunningGradle: true,
    });
    const stop =
      gradle.gradleRunning && gradle.versions.some((entry) => entry.willDelete)
        ? await planGradleDaemonStop(gradle.gradleRunningPids, operation)
        : null;
    if (stop?.pids)
      actions.push({
        kind: 'would-stop-gradle-daemons',
        target: `pid ${stop.pids.join(', ')}`,
        bytes: 0,
        reason: 'disk pressure level 3, these idle Gradle and Kotlin daemons keep unpinned Gradle versions',
        level: 3,
      });
    for (const entry of gradle.versions) {
      if (entry.willDelete && !stop?.kept)
        actions.push({
          kind: 'would-delete-gradle-version',
          target: entry.version,
          dir: gradle.home,
          bytes: 0,
          reason: `disk pressure level 3, no registered project pins it and it is unmodified for ${settings.gradleVersionIdleDays} days`,
          level: 3,
        });
      else
        skips.push({
          target: `Gradle ${entry.version}`,
          reason: (entry.willDelete && stop?.kept) || entry.detail || 'kept',
        });
    }
  }
  return { actions, blocked, skips, ...(worktrees ? { sweep: worktrees.sweep } : {}) };
}

/** Level 2 and 3 actions for a pass that measured `level`; level 1 is the regular plan. */
export async function planPressureLevels(
  level: DiskPressureLevel,
  context: LevelContext,
): Promise<MaintenancePlan & { pressureSweep?: WorktreePlan['sweep'] }> {
  if (level < 1) return { actions: [], blocked: [], skips: [] };
  const second = await planLevel2(context);
  if (level < 3) return second;
  const third = await planLevel3(context);
  return {
    actions: [...second.actions, ...third.actions],
    blocked: third.blocked,
    skips: [...second.skips, ...third.skips],
    ...(third.sweep ? { pressureSweep: third.sweep } : {}),
  };
}
