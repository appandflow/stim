import { isAbsolute } from 'node:path';
import { executedActionName } from '../../maintenance-kind.ts';
import {
  gcLogFile,
  runId,
  type GcLogOptions,
  type GcLogRecord,
  type GcLogTrigger,
  type MaintenanceAction,
} from '@stim-cli/core/state';
import { loadConfig } from '../../workspace/config.ts';
import { formatBytes } from '../../fs-util.ts';
import { openRetainedLog } from '../../stimd/passes/log.ts';
import { resolveMaintenanceSettings } from '../../stimd/passes/settings.ts';
import type { ActionOutcome } from '../../stimd/passes/act.ts';
import type { GcResult } from './results.ts';

type GcLogItem = Omit<GcResult, 'kind'> & { kind: string };

interface GcLogRun {
  trigger: GcLogTrigger;
  runId?: string;
  via?: string;
  options?: GcLogOptions;
  env?: NodeJS.ProcessEnv;
  holdKept?: boolean;
}

export interface GcLog {
  record(result: GcLogItem): void;
}

const VERBS = { done: 'Cleared', kept: 'Kept', failed: 'Failed to clear' } as const;

function gcLogRecord(run: GcLogRun, result: GcLogItem, ts: number): GcLogRecord {
  const path = [result.id, result.label].find((value) => value !== null && isAbsolute(value)) ?? null;
  const size = result.bytes ? ` (${formatBytes(result.bytes)})` : '';
  const why = result.detail ? `: ${result.detail}` : '';
  return {
    ts,
    src: 'gc',
    level: result.status === 'failed' ? 'error' : 'info',
    msg: `${VERBS[result.status]} ${result.kind} ${result.label}${size}${why}`,
    event: 'gc_item',
    runId: run.runId ?? runId(),
    trigger: run.trigger,
    ...(run.via === undefined ? {} : { via: run.via }),
    ...(run.options === undefined ? {} : { options: run.options }),
    kind: result.kind,
    status: result.status,
    label: result.label,
    id: result.id,
    path,
    bytes: result.bytes,
    detail: result.detail,
  };
}

export function openGcLog(run: GcLogRun): GcLog {
  let failed = false;
  let acted = run.holdKept !== true;
  const held: GcLogRecord[] = [];
  const append = (record: GcLogRecord) => {
    try {
      const writer = openRetainedLog(gcLogFile(), resolveMaintenanceSettings(loadConfig(), run.env));
      try {
        if (!writer.write(record)) throw writer.lastError ?? new Error('write failed');
      } finally {
        writer.close();
      }
    } catch (error) {
      if (failed) return;
      failed = true;
      console.error(`Could not write the gc log ${gcLogFile()}: ${error instanceof Error ? error.message : error}`);
    }
  };
  return {
    record(result) {
      const record = gcLogRecord(run, result, Date.now());
      if (!acted && result.status === 'kept') {
        held.push(record);
        return;
      }
      if (!acted) {
        acted = true;
        for (const earlier of held.splice(0)) append(earlier);
      }
      append(record);
    },
  };
}

const MAINTENANCE_KINDS: Record<string, string> = {
  'clear-outputs': 'workspaceOutputs',
  'trim-cache': 'cache',
  'empty-cache': 'cache',
  'unregister-cache': 'cache',
  'remove-worktree': 'worktree',
  'remove-orphan': 'workspaceDirectory',
  'delete-parked-device': 'parkedDevice',
  'delete-devices': 'device',
  'stop-workspace': 'device',
  'shutdown-device': 'idleDevice',
  'delete-temp-leftovers': 'tempLeftover',
  'delete-status-caches': 'statusCache',
  'delete-process-locks': 'homeEntry',
  'delete-device-lease': 'deviceLease',
  'delete-expired-archives': 'archive',
  'stop-gradle-daemons': 'gradleDaemon',
  'stop-watchman': 'watchman',
  'delete-gradle-version': 'gradleVersion',
  'clear-build-dirs': 'buildDirectory',
  'trim-cargo-target': 'buildDirectory',
  'delete-dependencies': 'dependencies',
  'prune-project': 'project',
  'delete-orphaned-devices': 'device',
  'forget-stale-records': 'ledgerEntry',
  'trim-workspace-logs': 'workspaceLogs',
  'delete-recordings': 'recording',
  'delete-hosted-devices': 'parkedHostedDevice',
  'delete-eas-sessions': 'easSession',
  'delete-archives': 'archive',
  'delete-build-outputs': 'workspaceOutputs',
  'idle-stage': 'devServer',
  'dormant-stage': 'device',
  'delete-trash': 'trash',
  'delete-runtime': 'runtime',
  'delete-unavailable-sim': 'device',
  'clean-tool-cache': 'toolCache',
};

export function maintenanceItem(action: MaintenanceAction, outcome: ActionOutcome): GcLogItem {
  const name = executedActionName(action);
  const done = outcome.status === 'done';
  return {
    kind: MAINTENANCE_KINDS[name] ?? name,
    status: outcome.status,
    label: action.target,
    id: action.dir ?? action.workspace ?? null,
    bytes: done && outcome.bytes ? outcome.bytes : null,
    detail: done ? (outcome.detail ? `${action.reason} (${outcome.detail})` : action.reason) : outcome.detail,
  };
}
