export type GcResultKind =
  | 'archive'
  | 'device'
  | 'parkedDevice'
  | 'parkedHostedDevice'
  | 'idleDevice'
  | 'deviceRecord'
  | 'workspaceOutputs'
  | 'recording'
  | 'workspaceDirectory'
  | 'project'
  | 'buildLock'
  | 'buildSlot'
  | 'deviceLease'
  | 'easSession'
  | 'worktree'
  | 'cache'
  | 'statusCache'
  | 'tempLeftover'
  | 'watchmanRoot'
  | 'watchman'
  | 'gradleDaemon'
  | 'gradleVersion'
  | 'kotlinDaemon';

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

/** Where `stim gc`'s helpers print each line, record each result and report a failure; the budget passes its own. */
export interface GcOutput {
  log: (line: string) => void;
  record: typeof recordGcResult;
  fail: () => void;
}

export const GC_OUTPUT: GcOutput = {
  log: (line) => console.log(line),
  record: recordGcResult,
  fail: () => {
    process.exitCode = 1;
  },
};
