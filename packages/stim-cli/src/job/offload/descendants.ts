import { captureProcessIdentity, inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { getExecutor } from '../../exec.ts';

const LISTING_TIMEOUT_MS = 10_000;

interface Row {
  pid: number;
  ppid: number;
  pgid: number;
}

/** pid, parent and process group of every process, from procps and BSD `ps` alike; null when `ps` cannot list them. */
function processTable(): Row[] | null {
  const listing = getExecutor().runFileQuiet('ps', ['-axo', 'pid=,ppid=,pgid='], { timeoutMs: LISTING_TIMEOUT_MS });
  if (listing === null) return null;
  return listing.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), pgid: Number(row[3]) }] : [];
  });
}

/** The descendants of `group`'s members and of `roots` that are outside `group`, `roots` excluded. */
function outside(table: Row[], group: number, roots: Iterable<number>): Map<number, Row> {
  const children = new Map<number, Row[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const start = new Set([...table.filter((row) => row.pgid === group).map((row) => row.pid), ...roots]);
  const found = new Map<number, Row>();
  const queue = [...start];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift())
    for (const row of children.get(pid) ?? [])
      if (!start.has(row.pid) && !found.has(row.pid)) {
        found.set(row.pid, row);
        queue.push(row.pid);
      }
  for (const [pid, row] of found) if (row.pgid === group) found.delete(pid);
  return found;
}

export interface ForeignDescendants {
  readonly unknown: boolean;
  find(): void;
  signal(signal: NodeJS.Signals): void;
  gone(): boolean;
}

/**
 * The processes an offloaded build started outside the worker's process group `group`, such as an Xcode build
 * service and its script phases, which run in process groups of their own. `find` walks the process tree down from the
 * group's members and the processes already recorded, and records each new one by its identity: it is captured, then
 * kept only when a second listing still shows it below the same roots, so a pid reused between the listing and the
 * capture is never recorded. `signal` sends to a recorded process only while its identity reads `same`. `gone` is true
 * once every recorded identity reads `gone` or `different`. `unknown` turns true, and stays true, when a listing fails,
 * an identity cannot be read, or a captured process left the tree before the second listing: then what the build
 * started cannot be proven gone.
 *
 * What this cannot see: a process that left the tree (its parent exited) before the first `find`.
 */
export function foreignDescendants(group: number): ForeignDescendants {
  const recorded = new Map<number, { pid: number; processToken: string }>();
  let unknown = false;
  return {
    get unknown(): boolean {
      return unknown;
    },
    find(): void {
      const before = processTable();
      if (!before) return void (unknown = true);
      const captured = new Map<number, string>();
      for (const pid of outside(before, group, recorded.keys()).keys()) {
        const identity = captureProcessIdentity(pid);
        if (identity.ok) captured.set(pid, identity.token);
        else if (identity.code !== 'NOT_FOUND') unknown = true;
      }
      if (captured.size === 0) return;
      const after = processTable();
      if (!after) return void (unknown = true);
      const below = outside(after, group, recorded.keys());
      for (const [pid, processToken] of captured) {
        if (below.has(pid)) recorded.set(pid, { pid, processToken });
        else if (inspectProcessIdentity({ pid, processToken }) === 'same') unknown = true;
      }
    },
    signal(signal: NodeJS.Signals): void {
      for (const record of recorded.values())
        if (inspectProcessIdentity(record) === 'same')
          try {
            process.kill(record.pid, signal);
          } catch {}
    },
    gone(): boolean {
      return [...recorded.values()].every((record) => {
        const status = inspectProcessIdentity(record);
        return status === 'gone' || status === 'different';
      });
    },
  };
}
