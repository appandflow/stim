import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { withDirLock, type StimContext } from '@stim-cli/core';
import {
  maintenanceChildLogFile,
  maintenanceDir,
  maintenanceRunClaims,
  maintenanceStateFile,
  readMaintenanceState,
  type MaintenanceAction,
  type MaintenanceCheck,
  type MaintenancePlanPart,
  type MaintenanceState,
  type MaintenanceRecord,
} from '@stim-cli/core/state';
import { tryAcquireClaim, releaseClaim, type ClaimHandle, type ClaimHolder } from '@stim-cli/core/ownership-claim';
import { tickListsSims, type TickMeasurement } from '../../daemon/measure.ts';
import { listAvdsAsync } from '../../devices/android.ts';
import { listAllIosSimsAsync } from '../../devices/ios.ts';
import { loadConfig } from '../../workspace/config.ts';
import { formatBytes } from '../../fs-util.ts';
import { memoryCulpritsUnderAsync } from '../../host-memory.ts';
import { memoryCulpritAdvice } from '../../memory-culprits.ts';
import { DEVICE_LIST_TIMEOUT_MS, deviceSweepIsScoped } from '../../commands/gc/devices.ts';
import { measureOwnedDevices, type OwnedDeviceReads } from './devices.ts';
import { resolveMaintenanceSettings, type MaintenanceSettings } from './settings.ts';
import { due } from './due.ts';
import { skipKey } from './plan.ts';
import { capChildLog } from './attempt.ts';
import { measurePressure, measureSizes, pressureFromMeasurement, sizeScanDeferred } from './measure.ts';
import { executeAction, type ActionOutcome } from './act.ts';
import { plannedMaintenance, triggeringRoot, type PlannedMaintenance } from './preview.ts';
import { maintenanceLogger } from './log.ts';
import { maintenanceItem, openGcLog, type GcLog } from '../../commands/gc/log.ts';

function writeState(state: MaintenanceState): void {
  mkdirSync(maintenanceDir(), { recursive: true });
  withDirLock(join(maintenanceDir(), 'state.lock'), () => {
    const file = maintenanceStateFile();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`);
    try {
      renameSync(tmp, file);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  });
}

const RESERVE_BYTES = 1024 * 1024;
const reserveFile = () => join(maintenanceDir(), 'disk-reserve');

function releaseReserve(): boolean {
  try {
    const bytes = statSync(reserveFile()).size;
    rmSync(reserveFile());
    return bytes > 0;
  } catch {
    return false;
  }
}

function keepReserve(): void {
  try {
    if (statSync(reserveFile()).size === RESERVE_BYTES) return;
  } catch {}
  try {
    mkdirSync(maintenanceDir(), { recursive: true });
    writeFileSync(reserveFile(), randomBytes(RESERVE_BYTES));
  } catch {
    try {
      rmSync(reserveFile(), { force: true });
    } catch {}
  }
}

function claimPass(trigger: string): { acquired?: ClaimHandle; held?: ClaimHolder } {
  const take = () => {
    const attempt = tryAcquireClaim({
      root: maintenanceRunClaims(),
      mode: 'exclusive',
      label: 'maintenance',
      details: { trigger },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    return attempt;
  };
  try {
    return take();
  } catch (error) {
    const full = error instanceof Error && 'code' in error && (error.code === 'ENOSPC' || error.code === 'EDQUOT');
    if (!full || !releaseReserve()) throw error;
    return take();
  }
}

const EXECUTION_ORDER: Partial<Record<MaintenanceAction['kind'], number>> = {
  'would-unregister-cache': 0,
  'would-remove-orphan': 0,
  'would-clear-outputs': 1,
  'would-delete-parked-device': 2,
  'would-delete-temp-leftovers': 2,
  'would-delete-trash': 2,
  'would-delete-status-caches': 2,
  'would-delete-process-locks': 2,
  'would-delete-device-lease': 2,
  'would-delete-expired-archives': 2,
  'would-trim-cache': 2,
  'would-clear-build-dirs': 3,
  'would-empty-cache': 3,
  'would-remove-worktree': 4,
  'would-shutdown-device': 5,
  'would-stop-workspace': 5,
  'would-delete-devices': 5,
  'would-delete-dependencies': 6,
  'would-stop-gradle-daemons': 7,
  'would-stop-watchman': 7,
  'would-delete-gradle-version': 8,
};

const executionRank = (action: MaintenanceAction) => EXECUTION_ORDER[action.kind] ?? 9;

function shrinkSizes(state: MaintenanceState, action: MaintenanceAction, outcome: ActionOutcome): void {
  state.sizes = state.sizes.flatMap((size) => {
    if (
      action.kind === 'would-clear-outputs' &&
      size.category === 'workspace-outputs' &&
      size.workspace === action.workspace
    )
      return [];
    if (action.kind === 'would-trim-cache' && action.dir && size.dir === action.dir)
      return [{ ...size, bytes: Math.max(0, size.bytes - outcome.bytes) }];
    if (action.kind === 'would-empty-cache' && size.dir === action.target) return [];
    if (
      action.kind === 'would-delete-devices' &&
      outcome.status === 'done' &&
      size.category === 'owned-devices' &&
      size.workspace === action.workspace
    )
      return [];
    return [size];
  });
}

const executedKind = (action: MaintenanceAction) => action.kind.replace(/^would-/, '');

function describeDone(action: MaintenanceAction): string {
  const name = basename(action.workspace ?? action.target);
  switch (action.kind) {
    case 'would-clear-outputs':
      return `Cleared build outputs of ${name}`;
    case 'would-trim-cache':
      return `Trimmed ${action.target}`;
    case 'would-empty-cache':
      return `Emptied ${action.target}`;
    case 'would-remove-worktree':
      return `Removed the worktree ${action.target}`;
    case 'would-remove-orphan':
      return `Removed the orphaned workspace directory ${action.target}`;
    case 'would-delete-parked-device':
      return `Deleted the parked device ${action.target}`;
    case 'would-delete-temp-leftovers':
      return `Deleted the recognized leftovers in ${action.target}`;
    case 'would-delete-trash':
      return `Deleted the worktree trash in ${action.target}`;
    case 'would-delete-status-caches':
      return `Deleted the stale status cache entries in ${action.target}`;
    case 'would-delete-process-locks':
      return `Deleted the empty process lock directories in ${action.target}`;
    case 'would-delete-device-lease':
      return `Deleted the expired device lease ${action.target}`;
    case 'would-delete-expired-archives':
      return `Deleted the archives past their retention in ${action.target}`;
    case 'would-delete-devices':
      return `Deleted the owned devices of ${name}`;
    case 'would-clear-build-dirs':
      return `Cleared the build directory ${action.target}`;
    case 'would-delete-dependencies':
      return `Deleted the installed dependencies ${action.target}`;
    case 'would-stop-gradle-daemons':
      return 'Stopped idle Gradle and Kotlin daemons';
    case 'would-stop-watchman':
      return 'Shut down the unused watchman daemon';
    case 'would-delete-gradle-version':
      return `Deleted the unpinned Gradle ${action.target} caches and distributions`;
    case 'would-stop-workspace':
      return action.check === 'idle'
        ? `Stopped ${name} and shut down its owned devices`
        : `Stopped ${name} and deleted its owned devices`;
    case 'would-shutdown-device':
      return `Shut down the idle device ${action.target} of ${name}`;
    default:
      return `Unregistered the stale cache ${action.target}`;
  }
}

const actionKey = (action: MaintenanceState['plan'][number]) => JSON.stringify([action.kind, action.target]);
const stableText = (text: string) => text.replace(/\d+(?:\.\d+)?/g, '#');
const sameSet = (before: Set<string>, after: Set<string>) =>
  before.size === after.size && [...before].every((key) => after.has(key));

const PLAN_PARTS: readonly MaintenancePlanPart[] = ['caps', 'sweep', 'worktree', 'idle'];

const planPart = (action: MaintenanceAction): MaintenancePlanPart =>
  action.check === 'sweep' || action.check === 'worktree' || action.check === 'idle' ? action.check : 'caps';

type PlanParts = NonNullable<MaintenanceState['byCheck']>;

/** The parts this pass planned take its blocked reasons and skips; the others keep those of the pass that planned them last. */
function partsAfter(
  previous: MaintenanceState['byCheck'],
  planned: ReadonlySet<MaintenancePlanPart>,
  result: PlannedMaintenance,
  outcomes: readonly { action: MaintenanceAction; outcome: ActionOutcome }[] = [],
): PlanParts {
  const parts: PlanParts = { ...previous };
  for (const part of planned) {
    const own = outcomes.filter(({ action }) => planPart(action) === part);
    const blocked = [
      ...(result.byCheck[part]?.blocked ?? []),
      ...own.flatMap(({ outcome }) => (outcome.shortfall ? [outcome.shortfall] : [])),
    ];
    const skipKeys = [
      ...(result.byCheck[part]?.skips ?? []).map(skipKey),
      ...own.filter(({ outcome }) => outcome.status === 'kept').map(({ action }) => action.target),
    ];
    if (blocked.length || skipKeys.length) parts[part] = { blocked, skipKeys };
    else delete parts[part];
  }
  return parts;
}

/** The parts whose check its settings turn off: they plan nothing, so nothing of theirs is kept. */
const disabledParts = (settings: MaintenanceSettings): MaintenancePlanPart[] => [
  ...(settings.removeFinishedWorktrees ? [] : (['worktree'] as const)),
  ...(settings.sweepHours > 0 ? [] : (['sweep'] as const)),
];

const partsBlocked = (parts: PlanParts) => PLAN_PARTS.flatMap((part) => parts[part]?.blocked ?? []);
const partsSkipKeys = (parts: PlanParts) => [...new Set(PLAN_PARTS.flatMap((part) => parts[part]?.skipKeys ?? []))];

function uniqueActions(actions: readonly MaintenanceAction[]): MaintenanceAction[] {
  const keys = new Set<string>();
  return actions.filter((action) => {
    const key = actionKey(action);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

const BACKGROUND_TRIGGERS = new Set(['daemon']);

/** The daemon tick a pass runs in: its context, whose reads do not block the event loop, and its measurement. */
export interface MaintenanceTick {
  operation: StimContext;
  measured: TickMeasurement;
}

function tickDeviceReads({ operation, measured }: MaintenanceTick): OwnedDeviceReads {
  const { signal } = operation;
  return {
    sims: () => {
      if (!tickListsSims(loadConfig()))
        return listAllIosSimsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, signal, operation });
      if (measured.sims === null) throw new Error(measured.simsError ?? 'the simulator list failed');
      return measured.sims;
    },
    avds: () => listAvdsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, signal, operation }),
  };
}

function tickDeviceActivity({ measured }: MaintenanceTick) {
  return async (withSims: boolean) => {
    if (withSims && measured.sims === null) throw new Error(measured.simsError ?? 'the simulator list failed');
    return measured.devices;
  };
}

function throwUnverifiedCleanup(error: unknown): void {
  if (error instanceof Error && 'reportCleanup' in error) throw error;
}

/**
 * One automatic maintenance pass in this process, when a check is due. Its idle check stops only workspaces with a
 * hosted device, after `maintenance.idleStopHours`; the activity pass decides idle for every other one. `report`
 * plans and logs without acting, whatever `daemon.mode` says. Within a daemon `tick`, the pass reuses the tick's
 * measurement and runs no child process synchronously. Returns why no pass ran when another process holds the pass.
 */
export async function runMaintenance(
  trigger: string,
  { report = false, tick }: { report?: boolean; tick?: MaintenanceTick } = {},
): Promise<string | void> {
  const startedAt = Date.now();
  let claim: ClaimHandle | undefined;
  try {
    const attempt = claimPass(trigger);
    claim = attempt.acquired;
    if (!claim)
      return attempt.held
        ? `pid ${attempt.held.owner.pid} runs a maintenance pass (${String(attempt.held.details.trigger ?? 'unknown trigger')})`
        : undefined;
  } catch (error) {
    crashLine(error);
    return;
  }
  let logger: ReturnType<typeof maintenanceLogger> | undefined;
  let gcLog: GcLog | undefined;
  try {
    const resolved = resolveMaintenanceSettings();
    const settings = report && resolved.mode === 'on' ? { ...resolved, mode: 'report' as const } : resolved;
    if (settings.mode === 'off') return;
    const state: MaintenanceState = readMaintenanceState() ?? {
      version: 1,
      lastAt: {},
      pressure: null,
      sizes: [],
      lastPass: null,
      recent: [],
      plan: [],
    };
    const checks = due(state, settings, startedAt);
    if (checks.length === 0) return;
    const background = BACKGROUND_TRIGGERS.has(trigger);
    let writeError: string | null = null;
    const noteWriteError = (error: unknown) => {
      writeError ??= error instanceof Error ? error.message : String(error);
    };
    const keepState = () => {
      try {
        writeState(state);
      } catch (error) {
        noteWriteError(error);
      }
    };
    try {
      logger = maintenanceLogger(settings, `p-${claim.claimId}`, trigger);
    } catch (error) {
      noteWriteError(error);
    }
    gcLog = openGcLog({ trigger: 'maintenance', runId: `p-${claim.claimId}`, via: trigger });
    const record = (
      event: MaintenanceRecord['event'],
      level: MaintenanceRecord['level'],
      msg: string,
      fields: Record<string, unknown> = {},
      machine = true,
    ) => {
      let entry: MaintenanceRecord | null = null;
      try {
        entry = logger?.write(event, level, msg, fields, machine) ?? null;
      } catch (error) {
        noteWriteError(error);
      }
      if (
        entry &&
        (event === 'maintenance_action' ||
          event === 'maintenance_failure' ||
          (Array.isArray(fields.blocked) && fields.blocked.length > 0))
      )
        state.recent = [...state.recent, entry].slice(-20);
    };
    const failures: string[] = [];
    let measuredSizes = false;
    const ran = new Set<MaintenanceCheck>();
    for (const check of checks) {
      if (check !== 'pressure' && sizeScanDeferred()) {
        record('maintenance_skip', 'debug', `${check} check deferred: host load exceeds 4 per core`, {
          target: check,
          reason: 'host load exceeds 4 per core',
        });
        state.deferredAt = { ...state.deferredAt, [check]: Date.now() };
        keepState();
        continue;
      }
      state.lastAt[check] = Date.now();
      ran.add(check);
      delete state.deferredAt?.[check];
      keepState();
      try {
        if (check === 'worktree' || check === 'sweep' || check === 'idle') continue;
        if (check === 'pressure') {
          const at = state.lastAt[check]!;
          state.pressure = tick
            ? pressureFromMeasurement(state.pressure, at, tick.measured.measurement)
            : measurePressure(state.pressure, at);
          const culprits = await memoryCulpritsUnderAsync(state.pressure.memory.level);
          if (culprits) state.pressure.memory.culprits = culprits;
          for (const disk of state.pressure.disk)
            record('maintenance_check', 'debug', `Disk free on ${disk.volume}: ${(disk.freeMb / 1024).toFixed(1)}G`, {
              check: { kind: 'disk-free', value: disk.freeMb / 1024, unit: 'GiB' },
            });
          record('maintenance_check', 'debug', `Memory pressure: ${state.pressure.memory.level ?? 'unavailable'}`, {
            check: {
              kind: state.pressure.memory.availableBytes === null ? 'memory-pressure' : 'memory-available',
              value:
                state.pressure.memory.availableBytes === null
                  ? state.pressure.memory.level
                  : state.pressure.memory.availableBytes / 1024 ** 3,
              unit: state.pressure.memory.availableBytes === null ? 'level' : 'GiB',
            },
          });
          for (const culprit of state.pressure.memory.culprits ?? [])
            record('maintenance_check', 'info', memoryCulpritAdvice([culprit])!, { culprit });
        } else {
          measuredSizes = true;
          const measureFailed = (target: string, workspace?: string) => {
            failures.push(`Could not measure ${target}`);
            record('maintenance_failure', 'error', `Could not measure ${target}`, {
              target,
              error: 'du failed or timed out',
              ...(workspace ? { workspace } : {}),
            });
          };
          state.sizes = [
            ...(await measureSizes(state.lastAt[check]!, measureFailed, tick?.operation)),
            ...(deviceSweepIsScoped()
              ? []
              : await measureOwnedDevices(state.lastAt[check]!, measureFailed, tick && tickDeviceReads(tick))),
          ];
          for (const size of state.sizes)
            record('maintenance_check', 'debug', `${size.name}: ${formatBytes(size.bytes)}`, {
              check: {
                kind: `size:${size.category}`,
                value: size.bytes,
                unit: 'bytes',
              },
              target: size.dir,
            });
        }
      } catch (error) {
        throwUnverifiedCleanup(error);
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        record('maintenance_failure', 'error', `${check} check failed: ${message}`, { target: check, error: message });
      }
    }
    const plannedWorktrees =
      ran.has('worktree') || (ran.has('sweep') && settings.removeFinishedWorktrees && settings.removeIdleWorktrees);
    const caps = ran.has('size') || ran.has('sweep') || plannedWorktrees;
    if (!caps && !ran.has('idle')) {
      writeState(state);
      return;
    }
    const partPlanned = { caps, sweep: ran.has('sweep'), worktree: plannedWorktrees, idle: ran.has('idle') };
    let plannedParts = new Set([...PLAN_PARTS.filter((part) => partPlanned[part]), ...disabledParts(settings)]);
    let result: PlannedMaintenance;
    try {
      result = await plannedMaintenance(state.sizes, settings, {
        caps,
        sweep: ran.has('sweep'),
        worktrees: plannedWorktrees,
        idle: ran.has('idle'),
        background,
        ...(tick ? { operation: tick.operation, deviceActivity: tickDeviceActivity(tick) } : {}),
      });
    } catch (error) {
      throwUnverifiedCleanup(error);
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      record('maintenance_failure', 'error', `Could not plan maintenance: ${message}`, {
        target: 'plan',
        error: message,
      });
      result = { actions: [], blocked: [], skips: [], byCheck: {} };
      plannedParts = new Set(disabledParts(settings));
      for (const check of ['sweep', 'worktree'] as const) if (ran.has(check)) delete state.lastAt[check];
    }
    if (plannedWorktrees) {
      if (result.nextRemoval) state.nextRemoval = result.nextRemoval;
      else delete state.nextRemoval;
    }
    async function executePlan(
      actions: readonly MaintenanceAction[],
    ): Promise<{ action: MaintenanceAction; outcome: ActionOutcome }[]> {
      const context = {
        settings,
        background,
        protectedRoot: triggeringRoot(),
        worktreeSweep: result.worktreeSweep,
        ...(tick ? { operation: tick.operation } : {}),
      };
      const results: { action: MaintenanceAction; outcome: ActionOutcome }[] = [];
      const ordered = actions.toSorted((a, b) => executionRank(a) - executionRank(b));
      for (const action of ordered) {
        const began = Date.now();
        let outcome: ActionOutcome;
        try {
          outcome = await executeAction(action, context);
        } catch (error) {
          throwUnverifiedCleanup(error);
          outcome = { status: 'failed', bytes: 0, detail: error instanceof Error ? error.message : String(error) };
        }
        results.push({ action, outcome });
        if (outcome.status !== 'kept') gcLog?.record(maintenanceItem(action, outcome));
        const fields = {
          action: {
            kind: executedKind(action),
            target: action.target,
            bytes: outcome.bytes,
            durationMs: Date.now() - began,
          },
          ...(action.workspace && action.kind !== 'would-remove-worktree' ? { workspace: action.workspace } : {}),
        };
        if (outcome.status === 'done')
          record(
            'maintenance_action',
            action.kind === 'would-remove-worktree' ? 'warn' : 'info',
            `${describeDone(action)} (${formatBytes(outcome.bytes)}): ${action.kind === 'would-remove-worktree' ? outcome.detail : action.reason}`,
            fields,
            false,
          );
        else if (outcome.status === 'failed') {
          failures.push(`${describeDone(action)} failed: ${outcome.detail}`);
          record(
            'maintenance_failure',
            'error',
            `Could not process ${action.target}: ${outcome.detail}`,
            {
              target: action.target,
              error: outcome.detail,
              ...(fields.workspace ? { workspace: fields.workspace } : {}),
            },
            false,
          );
        } else if (!loggedSkips.has(action.target)) {
          loggedSkips.add(action.target);
          gcLog?.record(maintenanceItem(action, outcome));
          record(
            'maintenance_skip',
            'info',
            `Kept ${action.target}: ${outcome.detail}`,
            {
              target: action.target,
              reason: outcome.detail,
              ...(fields.workspace ? { workspace: fields.workspace } : {}),
            },
            false,
          );
        }
      }
      return results;
    }
    const retained = state.plan.filter((action) => !plannedParts.has(planPart(action)));
    const previousActions = new Set(state.plan.map(actionKey));
    const previousSkips = new Set(state.skipKeys ?? []);
    const loggedSkips = new Set(previousSkips);
    for (const skip of result.skips) {
      if (loggedSkips.has(skipKey(skip))) continue;
      loggedSkips.add(skipKey(skip));
      record('maintenance_skip', 'info', `Kept ${skip.target}: ${skip.reason}`, skip);
    }
    if (writeError) failures.push(`Could not write the maintenance state or log: ${writeError}`);
    if (settings.mode === 'on') {
      const outcomes = await executePlan(result.actions);
      state.byCheck = partsAfter(state.byCheck, plannedParts, result, outcomes);
      const blockedNow = [...partsBlocked(state.byCheck), ...failures];
      const done = outcomes.filter(({ outcome }) => outcome.status === 'done');
      const freedBytes = done.reduce((sum, { outcome }) => sum + outcome.bytes, 0);
      for (const { action, outcome } of done) shrinkSizes(state, action, outcome);
      state.plan = uniqueActions([
        ...outcomes.filter(({ outcome }) => outcome.status !== 'done').map(({ action }) => action),
        ...retained,
      ]);
      state.skipKeys = partsSkipKeys(state.byCheck);
      const previousBlocked = state.lastPass?.blocked;
      state.lastPass = {
        startedAt,
        durationMs: Date.now() - startedAt,
        trigger,
        mode: 'on',
        freedBytes,
        actions: done.length,
        stopped: 0,
        blocked: blockedNow,
      };
      const blockedChanged = !sameSet(
        new Set((previousBlocked ?? []).map(stableText)),
        new Set(state.lastPass.blocked.map(stableText)),
      );
      if (done.length || measuredSizes || blockedChanged)
        record(
          'maintenance_pass',
          state.lastPass.blocked.length ? 'warn' : 'info',
          `Pass: ${done.length} actions, ${formatBytes(freedBytes)} freed${state.lastPass.blocked.length ? `; ${state.lastPass.blocked.join('; ')}` : ''}`,
          { ...state.lastPass },
        );
    } else {
      state.byCheck = partsAfter(state.byCheck, plannedParts, result);
      const blocked = [...partsBlocked(state.byCheck), ...failures];
      const nextSkips = new Set(partsSkipKeys(state.byCheck));
      const planned = uniqueActions([...result.actions, ...retained]);
      const nextActions = new Set(planned.map(actionKey));
      const changed =
        !state.lastPass ||
        !sameSet(previousActions, nextActions) ||
        !sameSet(previousSkips, nextSkips) ||
        !sameSet(new Set(state.lastPass.blocked.map(stableText)), new Set(blocked.map(stableText)));
      for (const action of result.actions) {
        if (previousActions.has(actionKey(action))) continue;
        previousActions.add(actionKey(action));
        const label =
          action.kind === 'would-clear-outputs'
            ? `clear build outputs of ${basename(action.workspace ?? action.target)}`
            : `${action.kind.slice(6).replaceAll('-', ' ')} ${action.target}`;
        record('maintenance_action', 'info', `Would ${label} (${formatBytes(action.bytes)}): ${action.reason}`, {
          action: { ...action, durationMs: 0 },
          ...(action.workspace ? { workspace: action.workspace } : {}),
        });
      }
      state.plan = planned;
      state.skipKeys = [...nextSkips];
      state.lastPass = {
        startedAt,
        durationMs: Date.now() - startedAt,
        trigger,
        mode: 'report',
        freedBytes: 0,
        actions: planned.length,
        stopped: 0,
        blocked,
      };
      if (measuredSizes || changed)
        record(
          'maintenance_pass',
          state.lastPass.blocked.length ? 'warn' : 'info',
          `Report-only pass: ${planned.length} planned actions${state.lastPass.blocked.length ? `; ${state.lastPass.blocked.join('; ')}` : ''}`,
          { ...state.lastPass },
        );
    }
    writeState(state);
  } catch (error) {
    throwUnverifiedCleanup(error);
    const message = error instanceof Error ? error.message : String(error);
    try {
      logger?.write('maintenance_failure', 'error', `Maintenance failed: ${message}`, {
        target: 'pass',
        error: message,
      });
    } catch {}
    crashLine(error);
  } finally {
    logger?.close();
    keepReserve();
    releaseClaim(claim);
  }
}

function crashLine(error: unknown): void {
  try {
    mkdirSync(maintenanceDir(), { recursive: true });
    const file = maintenanceChildLogFile();
    capChildLog();
    appendFileSync(file, `${String(error).replaceAll('\n', ' ')}\n`);
  } catch {}
}
