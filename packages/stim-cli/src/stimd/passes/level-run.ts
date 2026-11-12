import type { StimContext } from '@stim-cli/core';
import {
  readDaemonSnapshot,
  type DaemonLadderAction,
  type DaemonPressure,
  type MaintenanceAction,
  type PressureLevel,
} from '@stim-cli/core/state';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { loadConfig } from '../../workspace/config.ts';
import { measureDisk, measureMemory } from '../../daemon/measure.ts';
import { classifyPressure, diskThresholds } from '../../daemon/pressure.ts';
import { runDormantReduction, runForcedLadder } from '../../daemon/passes.ts';
import { discoveredKeepReason, dormantAfterMs } from '../../daemon/stages.ts';
import { PRESSURE_IDLE_MS } from '../../daemon/idle.ts';
import { discoveredReads } from '../../workspace/discovered-reads.ts';
import { deviceSweepIsScoped } from '../../commands/gc/devices.ts';
import { executeAction, type ActionOutcome } from './act.ts';
import { executedActionName } from '../../maintenance-kind.ts';
import { measureSizes } from './measure.ts';
import { measureOwnedDevices } from './devices.ts';
import { plannedMaintenance, triggeringRoot } from './preview.ts';
import { executionRank } from './run.ts';
import { resolveMaintenanceSettings } from './settings.ts';
import { existsSync } from 'node:fs';
import {
  broadDiscoverRoots,
  discoverCheckouts,
  discoveredOutside,
  type DiscoveredCheckout,
} from '../../workspace/discovery.ts';
import { listedRoots } from '../../commands/gc/worktrees.ts';

/** One thing a maintenance run at a level did, would do, or kept, with what it freed or would free. */
export interface LevelRunAction {
  /** The pressure ladder rung that planned it, or null for the maintenance plan every level runs. */
  rung: number | null;
  kind: string;
  target: string;
  workspace?: string;
  outcome: 'would' | 'done' | 'kept' | 'failed';
  bytes: number;
  /** Why the run took it, or why it kept it. */
  reason: string;
  detail: string;
  restore?: string;
}

export interface LevelRun {
  /** The level the machine measured; `level` is it unless the caller chose one. */
  pressure: DaemonPressure;
  level: PressureLevel;
  actions: LevelRunAction[];
  /** What the run could not decide or reach, each for a person to look at. */
  blocked: string[];
  /** Checkouts no stim command ran in that this run treats as workspaces, with the actions it took or would take in each. */
  discovered: (DiscoveredCheckout & { actions: LevelRunAction[]; kept?: string })[];
  /** Worktrees discovery reached outside the folders Stim manages, which no run acts on. */
  outside: { path: string; from: string }[];
  /** The largest things Stim keeps on disk and can reclaim, from the sizes the run measured, largest first. */
  usage: { name: string; dir: string; bytes: number }[];
}

/** Measures disk and memory once and classifies them as the daemon would. */
async function measureLevel(operation?: StimContext): Promise<DaemonPressure> {
  const config = loadConfig();
  const { thresholds } = diskThresholds(config, operation?.env);
  const [disk, memory] = await Promise.all([
    measureDisk(config, operation?.signal),
    measureMemory(operation?.signal, operation),
  ]);
  return classifyPressure({
    disk,
    memory,
    thresholds,
    previousWarningSince: readDaemonSnapshot()?.pressure?.memoryWarningSince ?? null,
    now: Date.now(),
  });
}

function fromOutcome(action: MaintenanceAction, outcome: ActionOutcome): LevelRunAction {
  return {
    rung: null,
    kind: executedActionName(action),
    target: action.target,
    ...(action.workspace ? { workspace: action.workspace } : {}),
    outcome: outcome.status,
    bytes: outcome.bytes,
    reason: action.reason,
    detail: outcome.detail,
    ...(outcome.restore ? { restore: outcome.restore } : {}),
  };
}

function fromLadder(action: DaemonLadderAction, dormant = false): LevelRunAction {
  return {
    rung: dormant ? null : action.rung,
    kind: action.kind,
    target: action.target,
    ...(action.workspace ? { workspace: action.workspace } : {}),
    outcome: action.outcome,
    bytes: action.bytes,
    reason: dormant ? `no activity for ${action.setting ?? 'idle.dormantDays'}` : `pressure ladder rung ${action.rung}`,
    detail: action.detail,
    ...(action.restore ? { restore: action.restore } : {}),
  };
}

/**
 * One maintenance run at `level`, the measured one by default: at every level the plan of automatic maintenance (cap
 * trims, the age sweep with unused simulator runtimes, the prune of stale records and the finished-worktree check) and
 * the dormant reduction of workspaces idle `idle.dormantDays`, then above normal the pressure ladder forced to that
 * level, every rung to its end. Without `act` it plans and measures and deletes nothing.
 * `onAction` sees each action once it is decided.
 */
export async function runMaintenanceAtLevel({
  level: chosen,
  act,
  operation,
  onAction,
}: {
  level?: PressureLevel;
  act: boolean;
  operation?: StimContext;
  onAction?: (action: LevelRunAction) => void;
}): Promise<LevelRun> {
  const env = operation?.env ?? process.env;
  const pressure = await measureLevel(operation);
  const level = chosen ?? pressure.level;
  const settings = resolveMaintenanceSettings(loadConfig(), env);
  const actions: LevelRunAction[] = [];
  const blocked: string[] = [];
  const take = (action: LevelRunAction) => {
    actions.push(action);
    onAction?.(action);
  };
  const found = await discoverCheckouts(loadConfig(), listedRoots(), operation);
  for (const root of broadDiscoverRoots(loadConfig(), env))
    blocked.push(
      `maintenance.discoverRoots entry ${root} is too broad (the home folder, a folder holding it or /), so nothing is discovered there`,
    );
  const outside = await discoveredOutside(loadConfig(), listedRoots(), operation);
  const now = Date.now();
  const measureFailed = (target: string) => blocked.push(`Could not measure ${target}`);
  const sizes = [
    ...(await measureSizes(now, measureFailed, operation)),
    ...(deviceSweepIsScoped(env) ? [] : await measureOwnedDevices(now, measureFailed)),
  ];
  const plan = await plannedMaintenance(sizes, settings, {
    caps: true,
    sweep: true,
    worktrees: settings.removeFinishedWorktrees,
    refresh: act,
    operation,
  });
  blocked.push(...plan.blocked);
  for (const skip of plan.skips)
    take({ rung: null, kind: 'keep', target: skip.target, outcome: 'kept', bytes: 0, reason: '', detail: skip.reason });
  const context = {
    settings,
    background: false,
    protectedRoot: triggeringRoot(operation),
    ...(plan.worktreeSweep ? { worktreeSweep: plan.worktreeSweep } : {}),
    ...(operation ? { operation } : {}),
  };
  for (const action of plan.actions.toSorted((a, b) => executionRank(a) - executionRank(b))) {
    operation?.signal.throwIfAborted();
    if (!act) {
      take({
        ...fromOutcome(action, { status: 'done', bytes: action.bytes, detail: 'stim gc would do this' }),
        outcome: 'would',
      });
      continue;
    }
    let outcome: ActionOutcome;
    try {
      outcome = await executeAction(action, context);
    } catch (error) {
      if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
      operation?.signal.throwIfAborted();
      outcome = { status: 'failed', bytes: 0, detail: error instanceof Error ? error.message : String(error) };
    }
    take(fromOutcome(action, outcome));
  }
  for (const action of await runDormantReduction({
    act,
    trigger: 'gc',
    ...(operation ? { operation } : {}),
    protectedRoot: context.protectedRoot,
  }))
    take(fromLadder(action, true));
  if (level !== 'normal') {
    const ladder = await runForcedLadder({
      levels: [level],
      act,
      why: `stim gc at ${level}`,
      trigger: 'gc',
      operation,
      protectedRoot: context.protectedRoot,
      measured: chosen === undefined,
    });
    for (const action of ladder?.levels.flatMap((entry) => entry.actions) ?? []) take(fromLadder(action));
  }
  const idleMs = level === 'normal' ? dormantAfterMs(loadConfig(), env) : PRESSURE_IDLE_MS;
  const reads = discoveredReads(operation?.signal);
  const discovered: LevelRun['discovered'] = [];
  const ownerOf = (path: string) =>
    found
      .filter((entry) => path === entry.path || path.startsWith(`${entry.path}/`))
      .toSorted((a, b) => b.path.length - a.path.length)[0]?.path;
  for (const checkout of found) {
    const mine = actions.filter((action) => ownerOf(action.target) === checkout.path);
    const taken = mine.some((action) => action.outcome === 'would' || action.outcome === 'done');
    const kept =
      taken || idleMs <= 0 || !existsSync(checkout.path)
        ? null
        : await discoveredKeepReason(checkout.path, idleMs, operation, reads);
    if (kept && /source entries to check|cannot be read/.test(kept))
      blocked.push(`Discovered checkout ${checkout.path}: ${kept}, so it is never reduced`);
    discovered.push({ ...checkout, actions: mine, ...(kept ? { kept } : {}) });
  }
  const usage = sizes
    .filter((size) => size.bytes > 0)
    .toSorted((a, b) => b.bytes - a.bytes)
    .slice(0, 10)
    .map(({ name, dir, bytes }) => ({ name, dir, bytes }));
  return { pressure, level, actions, blocked, discovered, outside, usage };
}
