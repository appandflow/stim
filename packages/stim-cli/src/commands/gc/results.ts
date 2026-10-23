type GcResultKind =
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
  | 'trash'
  | 'watchmanRoot'
  | 'watchman'
  | 'gradleDaemon'
  | 'gradleVersion'
  | 'kotlinDaemon'
  | 'devServer'
  | 'workspaceLogs'
  | 'ledgerEntry'
  | 'easLedgerEntry';

type GcResultStatus = 'done' | 'kept' | 'failed';

export interface GcResult {
  kind: GcResultKind;
  status: GcResultStatus;
  label: string;
  id: string | null;
  bytes: number | null;
  detail: string | null;
}

interface GcResults {
  record(
    kind: GcResultKind,
    status: GcResultStatus,
    label: string,
    options?: { id?: string | null; bytes?: number | null; detail?: string | null },
  ): void;
  take(): GcResult[];
}

export function createGcResults(observe?: (result: GcResult) => void): GcResults {
  const results: GcResult[] = [];
  return {
    record(
      kind: GcResultKind,
      status: GcResultStatus,
      label: string,
      {
        id = null,
        bytes = null,
        detail = null,
      }: { id?: string | null; bytes?: number | null; detail?: string | null } = {},
    ): void {
      const result = { kind, status, label, id, bytes, detail };
      results.push(result);
      observe?.(result);
    },
    take(): GcResult[] {
      return results.splice(0);
    },
  };
}

const detachedResults = createGcResults();
export const recordGcResult: GcResults['record'] = detachedResults.record;
export const takeGcResults: GcResults['take'] = detachedResults.take;

/** Where `stim gc`'s helpers print each line, record each result and report a failure; the budget passes its own. */
export interface GcOutput {
  log: (line: string) => void;
  error: (line: string) => void;
  record: typeof recordGcResult;
  fail: () => void;
}

export const GC_OUTPUT: GcOutput = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  record: recordGcResult,
  fail: () => {
    process.exitCode = 1;
  },
};
