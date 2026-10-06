import { appendFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { withDirLock } from '@stim-cli/core';
import {
  maintenanceChildLogFile,
  maintenanceDir,
  maintenanceRunClaims,
  maintenanceStateFile,
  readMaintenanceState,
  type MaintenanceState,
  type MaintenanceRecord,
} from '@stim-cli/core/state';
import { tryAcquireClaim, releaseClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { relaunchWithLogFile } from '../detached-entry.ts';
import { formatBytes } from '../fs-util.ts';
import { resolveBudget } from '../budget.ts';
import { resolveMaintenanceSettings } from './settings.ts';
import { due } from './due.ts';
import { measurePressure, measureSizes, sizeScanDeferred } from './measure.ts';
import { plannedMaintenance } from './preview.ts';
import { maintenanceLogger } from './log.ts';

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

export async function runMaintenance(trigger: string): Promise<void> {
  let claim: ClaimHandle | undefined;
  try {
    const attempt = tryAcquireClaim({
      root: maintenanceRunClaims(),
      mode: 'exclusive',
      label: 'maintenance',
      details: { trigger },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    claim = attempt.acquired;
  } catch (error) {
    crashLine(error);
    return;
  }
  if (!claim) return;
  let logger: ReturnType<typeof maintenanceLogger> | undefined;
  try {
    const settings = resolveMaintenanceSettings();
    if (!settings || settings.mode === 'off') return;
    const startedAt = Date.now();
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
    logger = maintenanceLogger(settings, `p-${claim.claimId}`, trigger);
    const record = (
      event: MaintenanceRecord['event'],
      level: MaintenanceRecord['level'],
      msg: string,
      fields: Record<string, unknown> = {},
    ) => {
      const entry = logger!.write(event, level, msg, fields);
      if (
        entry &&
        (event === 'maintenance_action' ||
          event === 'maintenance_failure' ||
          (Array.isArray(fields.blocked) && fields.blocked.length > 0))
      )
        state.recent = [...state.recent, entry].slice(-20);
    };
    const failures: string[] = [];
    for (const check of checks) {
      if (check === 'size' && sizeScanDeferred(settings)) {
        record('maintenance_skip', 'debug', 'Size check deferred: host load exceeds maintenance.maxLoadPerCore', {
          target: 'size',
          reason: 'host load exceeds maintenance.maxLoadPerCore',
        });
        state.deferredAt = { ...state.deferredAt, [check]: Date.now() };
        writeState(state);
        continue;
      }
      state.lastAt[check] = Date.now();
      delete state.deferredAt?.[check];
      writeState(state);
      try {
        if (check === 'pressure') {
          state.pressure = measurePressure(settings, state.pressure, state.lastAt[check]!);
          const floor = Math.max(resolveBudget().budget.minFreeDiskMb, resolveBudget().budget.hardFloorDiskMb);
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
        } else {
          state.sizes = measureSizes(state.lastAt[check]!, (target, workspace) => {
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
    let result;
    try {
      result = await plannedMaintenance(state.pressure, state.sizes, settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      record('maintenance_failure', 'error', `Could not plan maintenance: ${message}`, {
        target: 'plan',
        error: message,
      });
      result = { actions: [], blocked: [], skips: [] };
    }
    state.plan = result.actions;
    for (const action of result.actions) {
      const label =
        action.kind === 'would-clear-outputs'
          ? `clear build outputs of ${basename(action.workspace ?? action.target)}`
          : `${action.kind.slice(6).replaceAll('-', ' ')} ${action.target}`;
      record('maintenance_action', 'info', `Would ${label} (${formatBytes(action.bytes)}): ${action.reason}`, {
        action: { ...action, durationMs: 0 },
        ...(action.workspace ? { workspace: action.workspace } : {}),
      });
    }
    for (const skip of result.skips) record('maintenance_skip', 'info', `Kept ${skip.target}: ${skip.reason}`, skip);
    state.lastPass = {
      startedAt,
      durationMs: Date.now() - startedAt,
      trigger,
      mode: 'report',
      freedBytes: 0,
      actions: result.actions.length,
      stopped: 0,
      blocked: [...result.blocked, ...failures],
    };
    record(
      'maintenance_pass',
      state.lastPass.blocked.length ? 'warn' : 'info',
      `Report-only pass: ${result.actions.length} planned actions${state.lastPass.blocked.length ? `; ${state.lastPass.blocked.join('; ')}` : ''}`,
      { ...state.lastPass },
    );
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
    releaseClaim(claim);
  }
}

function crashLine(error: unknown): void {
  try {
    mkdirSync(maintenanceDir(), { recursive: true });
    appendFileSync(maintenanceChildLogFile(), `${String(error).replaceAll('\n', ' ')}\n`);
  } catch {}
}

if (
  ['maintenance-run.mjs', 'run.ts'].includes(basename(process.argv[1] ?? '')) &&
  /maintenance(?:-run|[\\/]run)/.test(process.argv[1] ?? '')
) {
  if (!relaunchWithLogFile(process.argv.slice(2))) await runMaintenance(process.argv[2] ?? 'command');
}
