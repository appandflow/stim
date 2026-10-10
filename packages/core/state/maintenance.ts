import { readJsonObject, isJsonObject } from './json-file.ts';
import { maintenanceStateFile, maintenanceAttemptFile } from './paths.ts';
import type { NdjsonRecord } from './ndjson.ts';

export type MaintenanceMode = 'off' | 'report' | 'on';
export type MaintenanceCheck = 'pressure' | 'size' | 'worktree' | 'sweep';
export type MaintenanceActionKind =
  | 'would-clear-outputs'
  | 'would-trim-cache'
  | 'would-empty-cache'
  | 'would-shutdown-device'
  | 'would-stop-workspace'
  | 'would-remove-worktree'
  | 'would-remove-orphan'
  | 'would-unregister-cache';

export interface MaintenanceAction {
  kind: MaintenanceActionKind;
  target: string;
  bytes: number;
  reason: string;
  workspace?: string;
  dir?: string;
  olderThanDays?: number;
  check?: 'worktree' | 'sweep' | 'disk';
}

export interface MaintenanceSize {
  name: string;
  dir: string;
  bytes: number;
  measuredAt: number;
  category: 'workspace-outputs' | 'build-cache' | 'metro-cache' | 'compilation-cache' | 'ccache' | 'other';
  workspace?: string;
  idleDays?: number | null;
  blocked?: string;
}

/**
 * A process whose physical footprint, as `top` reports it, is abnormally large. `command` is the one command that
 * safely restarts or stops it, null when Stim knows none; `note` says what that command does.
 */
export interface MemoryCulprit {
  pid: number;
  name: string;
  bytes: number;
  command: string | null;
  note: string | null;
}

export interface MaintenancePressure {
  disk: { volume: string; freeMb: number }[];
  memory: {
    level: 'normal' | 'warning' | 'critical' | null;
    availableBytes: number | null;
    pressured: boolean;
    /** Read only while the level is warning or critical; absent otherwise. */
    culprits?: MemoryCulprit[];
  };
  warningSince: number | null;
}

export interface MaintenancePass {
  startedAt: number;
  durationMs: number;
  trigger: string;
  mode: 'report' | 'on';
  freedBytes: number;
  actions: number;
  stopped: 0;
  blocked: string[];
}

export interface MaintenanceRecord extends NdjsonRecord {
  ts: number;
  src: 'maintenance';
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  event: 'maintenance_pass' | 'maintenance_action' | 'maintenance_skip' | 'maintenance_failure' | 'maintenance_check';
  pass: string;
  trigger: string;
  mode: 'report' | 'on';
}

export interface MaintenanceState {
  version: 1;
  lastAt: Partial<Record<MaintenanceCheck, number>>;
  deferredAt?: Partial<Record<MaintenanceCheck, number>>;
  pressure: MaintenancePressure | null;
  sizes: MaintenanceSize[];
  lastPass: MaintenancePass | null;
  recent: MaintenanceRecord[];
  plan: MaintenanceAction[];
  skipKeys?: string[];
}

export interface MaintenanceStatus {
  mode: MaintenanceMode;
  invalid?: string;
  claim?: { unresolved: string; removeCommand: string };
  lastChecks: { pressure: number | null; size: number | null; worktree: number | null; sweep: number | null };
  pressure: MaintenancePressure | null;
  sizes: MaintenanceSize[];
  lastPass: MaintenancePass | null;
  running: { startedAt: string; trigger: string } | null;
  recent: MaintenanceRecord[];
  plan: MaintenanceAction[];
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nullableNumber = (value: unknown) => value === null || finite(value);
const strings = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const KINDS: readonly string[] = [
  'would-clear-outputs',
  'would-trim-cache',
  'would-empty-cache',
  'would-shutdown-device',
  'would-stop-workspace',
  'would-remove-worktree',
  'would-remove-orphan',
  'would-unregister-cache',
];

/** Rejects missing, corrupt or unsupported payloads without throwing. */
export function parseMaintenanceState(value: unknown): MaintenanceState | null {
  if (!isJsonObject(value) || value.version !== 1 || !isJsonObject(value.lastAt)) return null;
  if (!Object.values(value.lastAt).every(finite)) return null;
  if (value.skipKeys !== undefined && !strings(value.skipKeys)) return null;
  if (
    value.deferredAt !== undefined &&
    (!isJsonObject(value.deferredAt) || !Object.values(value.deferredAt).every(finite))
  )
    return null;
  if (
    !Array.isArray(value.sizes) ||
    !value.sizes.every(
      (size) =>
        isJsonObject(size) &&
        typeof size.name === 'string' &&
        typeof size.dir === 'string' &&
        finite(size.bytes) &&
        finite(size.measuredAt) &&
        ['workspace-outputs', 'build-cache', 'metro-cache', 'compilation-cache', 'ccache', 'other'].includes(
          String(size.category),
        ) &&
        (size.workspace === undefined || typeof size.workspace === 'string') &&
        (size.blocked === undefined || typeof size.blocked === 'string') &&
        (size.idleDays === undefined || nullableNumber(size.idleDays)),
    )
  )
    return null;
  if (
    !Array.isArray(value.plan) ||
    !value.plan.every(
      (action) =>
        isJsonObject(action) &&
        KINDS.includes(String(action.kind)) &&
        typeof action.target === 'string' &&
        finite(action.bytes) &&
        typeof action.reason === 'string' &&
        (action.workspace === undefined || typeof action.workspace === 'string') &&
        (action.dir === undefined || typeof action.dir === 'string') &&
        (action.olderThanDays === undefined || finite(action.olderThanDays)) &&
        (action.check === undefined || ['worktree', 'sweep', 'disk'].includes(String(action.check))),
    )
  )
    return null;
  if (
    !Array.isArray(value.recent) ||
    !value.recent.every(
      (record) =>
        isJsonObject(record) &&
        record.src === 'maintenance' &&
        finite(record.ts) &&
        typeof record.msg === 'string' &&
        ['debug', 'info', 'warn', 'error'].includes(String(record.level)) &&
        [
          'maintenance_pass',
          'maintenance_action',
          'maintenance_skip',
          'maintenance_failure',
          'maintenance_check',
        ].includes(String(record.event)) &&
        typeof record.pass === 'string' &&
        typeof record.trigger === 'string' &&
        (record.mode === 'report' || record.mode === 'on'),
    )
  )
    return null;
  if (
    value.lastPass !== null &&
    (!isJsonObject(value.lastPass) ||
      !finite(value.lastPass.startedAt) ||
      !finite(value.lastPass.durationMs) ||
      typeof value.lastPass.trigger !== 'string' ||
      (value.lastPass.mode !== 'report' && value.lastPass.mode !== 'on') ||
      !finite(value.lastPass.freedBytes) ||
      value.lastPass.stopped !== 0 ||
      !finite(value.lastPass.actions) ||
      !strings(value.lastPass.blocked))
  )
    return null;
  if (value.pressure !== null) {
    const pressure = value.pressure;
    if (
      !isJsonObject(pressure) ||
      !Array.isArray(pressure.disk) ||
      !pressure.disk.every((disk) => isJsonObject(disk) && typeof disk.volume === 'string' && finite(disk.freeMb)) ||
      !nullableNumber(pressure.warningSince) ||
      !isJsonObject(pressure.memory) ||
      ![null, 'normal', 'warning', 'critical'].includes(pressure.memory.level as string | null) ||
      !nullableNumber(pressure.memory.availableBytes) ||
      typeof pressure.memory.pressured !== 'boolean'
    )
      return null;
  }
  return value as unknown as MaintenanceState;
}

export function readMaintenanceState(): MaintenanceState | null {
  return parseMaintenanceState(readJsonObject(maintenanceStateFile()));
}

export function readMaintenanceAttempt(): number | undefined {
  const value = readJsonObject(maintenanceAttemptFile())?.attemptedAt;
  return finite(value) ? value : undefined;
}
