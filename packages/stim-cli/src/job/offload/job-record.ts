import type { Readable } from 'node:stream';
import { createDebugLog, type DebugLog } from '@stim-cli/core/state';
import { getExecutor } from '../../exec.ts';

const TREE_TIMEOUT_MS = 1500;
const MAX_TREE_ROWS = 40;
const STDERR_KEEP_CHARS = 8192;
const STDERR_LINES = 20;
const MAX_STDERR_LINE = 300;

export type CancelReason =
  | 'client-cancel'
  | 'connection-closed'
  | 'job-stopped'
  | 'bad-request'
  | 'timeout'
  | 'identity-unavailable'
  | 'group-outlived-worker';

/** The offload job's records in the worker's `logs/debug/server.ndjson`: paths and command names stay out of the service log. */
export const jobLog: DebugLog = createDebugLog('server');

/**
 * The processes of process group `pgid` (pid, parent, elapsed time as `ps` prints it, command name), at most
 * MAX_TREE_ROWS of them, or null off process-group platforms or when `ps` does not answer within TREE_TIMEOUT_MS.
 */
export function groupProcesses(
  pgid: number | undefined,
): { processes: { pid: number; ppid: number; elapsed: string; command: string }[]; omitted: number } | null {
  if (pgid === undefined || process.platform === 'win32') return null;
  const listing = getExecutor().runFileQuiet('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,comm='], {
    timeoutMs: TREE_TIMEOUT_MS,
  });
  if (listing === null) return null;
  const rows = listing.split('\n').flatMap((line) => {
    const [, pid = '', ppid = '', group = '', elapsed = '', command = ''] =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line) ?? [];
    return group && Number(group) === pgid ? [{ pid: Number(pid), ppid: Number(ppid), elapsed, command }] : [];
  });
  return { processes: rows.slice(0, MAX_TREE_ROWS), omitted: Math.max(0, rows.length - MAX_TREE_ROWS) };
}

/** Drains `stream` and returns a reader of its last STDERR_LINES non-empty lines. */
export function keepTail(stream: Readable | null): () => string[] {
  let tail = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_KEEP_CHARS);
  });
  stream?.on('error', () => {});
  return () =>
    tail
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-STDERR_LINES)
      .map((line) => (line.length > MAX_STDERR_LINE ? `...${line.slice(-MAX_STDERR_LINE)}` : line));
}

const token = (value: unknown): string =>
  String(value)
    .replace(/[^\x21-\x7e]+/g, '_')
    .slice(0, 80);

/** One service-log line (stimd passes the job's stderr to it): ids, codes, signals and durations, never paths or output. */
export function serviceLine(event: string, fields: Record<string, string | number | boolean | null>): void {
  const text = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${token(value)}`)
    .join(' ');
  console.error(`${new Date().toISOString()} stim-server: build job ${event} ${text}`);
}
