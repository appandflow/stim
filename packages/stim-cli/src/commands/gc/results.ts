export type GcResultKind =
  | 'device'
  | 'parkedDevice'
  | 'idleDevice'
  | 'deviceRecord'
  | 'workspaceOutputs'
  | 'workspaceDirectory'
  | 'project'
  | 'buildLock'
  | 'buildSlot'
  | 'deviceLease'
  | 'easSession'
  | 'worktree'
  | 'cache';

export type GcResultStatus = 'done' | 'kept' | 'failed';

export interface GcResult {
  kind: GcResultKind;
  status: GcResultStatus;
  label: string;
  id: string | null;
  bytes: number | null;
  detail: string | null;
}

const results: GcResult[] = [];

export function recordGcResult(
  kind: GcResultKind,
  status: GcResultStatus,
  label: string,
  {
    id = null,
    bytes = null,
    detail = null,
  }: { id?: string | null; bytes?: number | null; detail?: string | null } = {},
): void {
  results.push({ kind, status, label, id, bytes, detail });
}

export function takeGcResults(): GcResult[] {
  return results.splice(0);
}
