import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDirLock } from '@stim-cli/core';
import {
  maintenanceChildLogFile,
  maintenanceDir,
  maintenanceRunClaims,
  maintenanceStateFile,
  readMaintenanceState,
  type MaintenanceAction,
  type MaintenanceCheck,
  type MaintenanceState,
  type MaintenanceRecord,
} from '@stim-cli/core/state';
import { tryAcquireClaim, releaseClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { relaunchWithLogFile } from '../detached-entry.ts';
import { formatBytes } from '../fs-util.ts';
import { memoryCulpritsUnder } from '../host-memory.ts';
import { memoryCulpritAdvice } from '../memory-culprits.ts';
import { resolveBudget } from '../budget.ts';
import { resolveMaintenanceSettings } from './settings.ts';
import { due } from './due.ts';
import { capChildLog } from './attempt.ts';
import { measureDisk, measurePressure, measureSizes, sizeScanDeferred } from './measure.ts';
import { diskRecovered, executeAction, type ActionOutcome } from './act.ts';
import { plannedMaintenance, triggeringRoot, type PlannedMaintenance } from './preview.ts';
import { maintenanceLogger } from './log.ts';
import { diskPressureLevel, levelFloors, levelStillShort, lowestFree } from './pressure.ts';

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

function claimPass(trigger: string): ClaimHandle | undefined {
  const take = () => {
    const attempt = tryAcquireClaim({
      root: maintenanceRunClaims(),
      mode: 'exclusive',
      label: 'maintenance',
      details: { trigger },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    return attempt.acquired;
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
  'would-trim-cache': 2,
  'would-clear-build-dirs': 3,
  'would-empty-cache': 3,
  'would-remove-worktree': 4,
  'would-stop-workspace': 5,
  'would-delete-dependencies': 6,
};

const executionRank = (action: MaintenanceAction) => (action.level ?? 1) * 10 + (EXECUTION_ORDER[action.kind] ?? 9);

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
    case 'would-clear-build-dirs':
      return `Cleared the build directory ${action.target}`;
    case 'would-delete-dependencies':
      return `Deleted the installed dependencies ${action.target}`;
    case 'would-stop-workspace':
      return `Stopped ${name} and deleted its owned devices`;
    default:
      return `Unregistered the stale cache ${action.target}`;
  }
}

const actionKey = (action: MaintenanceState['plan'][number]) => JSON.stringify([action.kind, action.target]);
const stableText = (text: string) => text.replace(/\d+(?:\.\d+)?/g, '#');
const sameSet = (before: Set<string>, after: Set<string>) =>
  before.size === after.size && [...before].every((key) => after.has(key));

export async function runMaintenance(trigger: string): Promise<void> {
  const startedAt = Date.now();
  let claim: ClaimHandle | undefined;
  try {
    claim = claimPass(trigger);
  } catch (error) {
    crashLine(error);
    return;
  }
  if (!claim) return;
  let logger: ReturnType<typeof maintenanceLogger> | undefined;
  try {
    const settings = resolveMaintenanceSettings();
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
    const record = (
      event: MaintenanceRecord['event'],
      level: MaintenanceRecord['level'],
      msg: string,
      fields: Record<string, unknown> = {},
    ) => {
      let entry: MaintenanceRecord | null = null;
      try {
        entry = logger?.write(event, level, msg, fields) ?? null;
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
    const budget = resolveBudget().budget;
    const ran = new Set<MaintenanceCheck>();
    for (const check of checks) {
      if (check !== 'pressure' && sizeScanDeferred(settings)) {
        record('maintenance_skip', 'debug', `${check} check deferred: host load exceeds maintenance.maxLoadPerCore`, {
          target: check,
          reason: 'host load exceeds maintenance.maxLoadPerCore',
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
        if (check === 'worktree' || check === 'sweep') continue;
        if (check === 'pressure') {
          state.pressure = measurePressure(settings, state.pressure, state.lastAt[check]!);
          state.pressure.diskLevel = diskPressureLevel(lowestFree(state.pressure.disk), budget, settings);
          const culprits =
            settings.memoryPressureLevel === 'off' ? null : memoryCulpritsUnder(state.pressure.memory.level);
          if (culprits) state.pressure.memory.culprits = culprits;
          const floor = Math.max(budget.minFreeDiskMb, budget.hardFloorDiskMb);
          for (const disk of state.pressure.disk)
            record('maintenance_check', 'debug', `Disk free on ${disk.volume}: ${(disk.freeMb / 1024).toFixed(1)}G`, {
              check: {
                kind: 'disk-free',
                value: disk.freeMb / 1024,
                threshold: floor / 1024,
                unit: 'GiB',
              },
            });
          record('maintenance_check', 'debug', `Memory pressure: ${state.pressure.memory.level ?? 'unavailable'}`, {
            check: {
              kind: state.pressure.memory.availableBytes === null ? 'memory-pressure' : 'memory-available',
              value:
                state.pressure.memory.availableBytes === null
                  ? state.pressure.memory.level
                  : state.pressure.memory.availableBytes / 1024 ** 3,
              threshold:
                state.pressure.memory.availableBytes === null
                  ? settings.memoryPressureLevel
                  : (settings.minAvailableMemoryGb ?? '10% of RAM'),
              unit: state.pressure.memory.availableBytes === null ? 'level' : 'GiB',
            },
          });
          for (const culprit of state.pressure.memory.culprits ?? [])
            record('maintenance_check', 'info', memoryCulpritAdvice([culprit])!, { culprit });
        } else {
          measuredSizes = true;
          state.sizes = await measureSizes(state.lastAt[check]!, (target, workspace) => {
            failures.push(`Could not measure ${target}`);
            record('maintenance_failure', 'error', `Could not measure ${target}`, {
              target,
              error: 'du failed or timed out',
              ...(workspace ? { workspace } : {}),
            });
          });
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
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        record('maintenance_failure', 'error', `${check} check failed: ${message}`, { target: check, error: message });
      }
    }
    let result: PlannedMaintenance;
    try {
      result = await plannedMaintenance(state.pressure, state.sizes, settings, {
        sweep: ran.has('sweep'),
        worktrees: ran.has('worktree'),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      record('maintenance_failure', 'error', `Could not plan maintenance: ${message}`, {
        target: 'plan',
        error: message,
      });
      result = { actions: [], blocked: [], skips: [] };
      for (const check of ['sweep', 'worktree'] as const) if (ran.has(check)) delete state.lastAt[check];
    }
    async function executePlan(
      actions: readonly MaintenanceAction[],
    ): Promise<{ action: MaintenanceAction; outcome: ActionOutcome }[]> {
      const context = {
        settings,
        budget,
        protectedRoot: triggeringRoot(),
        worktreeSweep: result.worktreeSweep,
        pressureSweep: result.pressureSweep,
      };
      const results: { action: MaintenanceAction; outcome: ActionOutcome }[] = [];
      const ordered = actions.toSorted((a, b) => executionRank(a) - executionRank(b));
      for (const action of ordered) {
        const began = Date.now();
        let outcome: ActionOutcome;
        try {
          outcome =
            action.check === 'disk' && diskRecovered(budget)
              ? { status: 'kept', bytes: 0, detail: 'free disk recovered before this action' }
              : action.level !== undefined && !levelStillShort(action, lowestFree(measureDisk()), budget, settings)
                ? { status: 'kept', bytes: 0, detail: `free disk is back above the level ${action.level} floor` }
                : await executeAction(action, context);
        } catch (error) {
          outcome = { status: 'failed', bytes: 0, detail: error instanceof Error ? error.message : String(error) };
        }
        results.push({ action, outcome });
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
            `${describeDone(action)} (${formatBytes(outcome.bytes)}): ${action.reason}`,
            fields,
          );
        else if (outcome.status === 'failed') {
          failures.push(`${describeDone(action)} failed: ${outcome.detail}`);
          record('maintenance_failure', 'error', `Could not process ${action.target}: ${outcome.detail}`, {
            target: action.target,
            error: outcome.detail,
            ...(fields.workspace ? { workspace: fields.workspace } : {}),
          });
        } else if (!loggedSkips.has(action.target)) {
          loggedSkips.add(action.target);
          record('maintenance_skip', 'info', `Kept ${action.target}: ${outcome.detail}`, {
            target: action.target,
            reason: outcome.detail,
            ...(fields.workspace ? { workspace: fields.workspace } : {}),
          });
        }
      }
      return results;
    }
    const retained = state.plan.filter(
      (action) => (action.check === 'sweep' || action.check === 'worktree') && !ran.has(action.check),
    );
    const previousActions = new Set(state.plan.map(actionKey));
    const previousSkips = new Set(state.skipKeys ?? []);
    const nextSkips = new Set(result.skips.map((skip) => skip.target));
    const loggedSkips = new Set(previousSkips);
    for (const skip of result.skips) {
      if (loggedSkips.has(skip.target)) continue;
      loggedSkips.add(skip.target);
      record('maintenance_skip', 'info', `Kept ${skip.target}: ${skip.reason}`, skip);
    }
    if (writeError) failures.push(`Could not write the maintenance state or log: ${writeError}`);
    if (settings.mode !== 'on' && state.pressure?.diskLevel === 3)
      failures.push(criticalLine(state.pressure.disk, budget, settings));
    if (settings.mode === 'on') {
      const outcomes = await executePlan(result.actions);
      if (state.pressure) {
        state.pressure.disk = measureDisk();
        state.pressure.diskLevel = diskPressureLevel(lowestFree(state.pressure.disk), budget, settings);
        if (state.pressure.diskLevel === 3) failures.push(criticalLine(state.pressure.disk, budget, settings));
      }
      const blockedNow = [
        ...result.blocked,
        ...failures,
        ...outcomes.flatMap(({ outcome }) => (outcome.shortfall ? [outcome.shortfall] : [])),
      ];
      const done = outcomes.filter(({ outcome }) => outcome.status === 'done');
      const freedBytes = done.reduce((sum, { outcome }) => sum + outcome.bytes, 0);
      for (const { action, outcome } of done) shrinkSizes(state, action, outcome);
      state.plan = outcomes.filter(({ outcome }) => outcome.status !== 'done').map(({ action }) => action);
      state.skipKeys = [
        ...nextSkips,
        ...outcomes.filter(({ outcome }) => outcome.status === 'kept').map(({ action }) => action.target),
      ];
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
      if (done.length || measuredSizes || blockedChanged || (state.pressure?.diskLevel ?? 0) > 0)
        record(
          'maintenance_pass',
          state.lastPass.blocked.length ? 'warn' : 'info',
          `Pass: ${done.length} actions, ${formatBytes(freedBytes)} freed${state.lastPass.blocked.length ? `; ${state.lastPass.blocked.join('; ')}` : ''}`,
          { ...state.lastPass },
        );
    } else {
      const blocked = [...result.blocked, ...failures];
      const planned = [...result.actions, ...retained];
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

function criticalLine(
  disk: { volume: string; freeMb: number }[],
  budget: Parameters<typeof levelFloors>[0],
  settings: Parameters<typeof levelFloors>[1],
): string {
  const floor = levelFloors(budget, settings)[3];
  const low = disk.filter((volume) => volume.freeMb < floor);
  return `disk pressure level 3: ${low.map((volume) => `${(volume.freeMb / 1024).toFixed(1)}G free on ${volume.volume}`).join(', ')} after this pass, under the ${(floor / 1024).toFixed(1)}G critical floor; builds refuse below budget.hardFloorDiskGb`;
}

function crashLine(error: unknown): void {
  try {
    mkdirSync(maintenanceDir(), { recursive: true });
    const file = maintenanceChildLogFile();
    capChildLog();
    appendFileSync(file, `${String(error).replaceAll('\n', ' ')}\n`);
  } catch {}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!relaunchWithLogFile(process.argv.slice(2))) await runMaintenance(process.argv[2] ?? 'command');
}
