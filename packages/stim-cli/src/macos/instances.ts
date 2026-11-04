import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { hostedAppAttempt, type MacosProcess } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { inspectProcessIdentity, processStartMicros, captureProcessToken } from '../process-identity.ts';
import { macosDir } from './state.ts';
import type { StimContext } from '@stim-cli/core';
import { runOperationFile } from '../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';

const BUNDLE_EXECUTABLE = /^[^/]+\.app\/Contents\/MacOS\/[^/]+$/;

function bundleDirs(root: string): string[] {
  const dir = macosDir(root);
  if (process.platform !== 'darwin' || !existsSync(dir)) return [];
  return [...new Set([dir, realpathSync(dir)])];
}

function isBundleExecutable(path: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => path.startsWith(`${dir}/`) && BUNDLE_EXECUTABLE.test(path.slice(dir.length + 1)));
}

/** Pids from `ps -axww -o pid=,comm=` output whose command names a bundle executable inside `dirs`. */
function bundleCandidates(psOutput: string, dirs: readonly string[]): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match && isBundleExecutable(match[2]!, dirs)) pids.push(Number(match[1]));
  }
  return pids;
}

/** Whether `lsof -Fn -d txt` output for one process names a bundle executable inside `dirs`. */
function lsofNamesBundleExecutable(lsofOutput: string, dirs: readonly string[]): boolean {
  return lsofOutput.split('\n').some((line) => line.startsWith('n') && isBundleExecutable(line.slice(1), dirs));
}

function candidatePids(dirs: readonly string[]): number[] {
  if (!dirs.length) return [];
  const listed = getExecutor().runFile('ps', ['-axww', '-o', 'pid=,comm='], { timeoutMs: 10_000 });
  return bundleCandidates(listed, dirs).filter((pid) => pid !== process.pid);
}

/** Pids that claim to run an app bundle from the workspace's macOS directory. `ps` reports argv[0], so this is a lead. */
export function bundleInstancePids(root: string): number[] {
  return candidatePids(bundleDirs(root));
}

export async function bundleInstancePidsAsync(
  root: string,
  signal?: AbortSignal,
  operation?: StimContext,
): Promise<number[]> {
  signal?.throwIfAborted();
  const dirs = bundleDirs(root);
  if (!dirs.length) return [];
  const listed = await runOperationFile(operation, getExecutor(), 'ps', ['-axww', '-o', 'pid=,comm='], {
    timeoutMs: 10_000,
    killSignal: 'SIGKILL',
    signal,
    cwd: operation?.cwd,
  });
  return bundleCandidates(listed, dirs).filter((pid) => pid !== process.pid);
}

function unverified(pid: number, why: string): Error {
  return Object.assign(new Error(`Cannot verify macOS app pid ${pid}: ${why}; no signal was sent.`), {
    code: 'STIM_MACOS_OWNER_UNVERIFIED',
  });
}

function bundleRecord(pid: number): MacosProcess | null {
  const processToken = captureProcessToken(pid);
  const start = processStartMicros(pid);
  if (!processToken || start.status !== 'running') {
    if (start.status === 'gone') return null;
    throw unverified(pid, 'its identity cannot be captured');
  }
  return { pid, processToken, startedAtMicros: start.startedAtMicros };
}

function failedBundleListing(record: MacosProcess, error: unknown): string | null {
  if (['gone', 'different'].includes(inspectProcessIdentity(record))) return null;
  const open = String((error as { stdout?: unknown }).stdout ?? '');
  if (!open.trim()) throw unverified(record.pid, `lsof failed (${(error as Error).message.split('\n')[0]})`);
  return open;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
}

function processRows(psOutput: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
  }
  return rows;
}

async function listProcesses(operation?: StimContext): Promise<ProcessRow[]> {
  return processRows(
    await runOperationFile(operation, getExecutor(), 'ps', ['-axo', 'pid=,ppid=,pgid='], {
      cwd: operation?.cwd,
      timeoutMs: 10_000,
      killSignal: 'SIGKILL',
    }),
  );
}

/**
 * The commands a verified live `owners` process started: its direct children, and the members of every process
 * group such a child leads, which holds the child's own helpers such as a server's `adb track-devices` client. It
 * stops there: a daemon that calls setsid, such as the machine-wide adb server, leads a group of its own and is not
 * the owner's to end. Nothing is listed under an owner that is this process, pid 1 or an ancestor, and no group
 * that holds one of them is walked. A process whose identity cannot be captured is skipped with a warning and never signalled.
 * It must run before the owners are signalled, because a child whose parent exits is reparented and no longer
 * reachable by its parent.
 */
export async function startedBy(owners: readonly MacosProcess[], operation?: StimContext): Promise<MacosProcess[]> {
  operation?.signal.throwIfAborted();
  const rows = await listProcesses(operation);
  const parents = new Map(rows.map((row) => [row.pid, row]));
  const protectedPids = new Set([1, process.pid]);
  for (let pid = parents.get(process.pid)?.ppid; pid && !protectedPids.has(pid); pid = parents.get(pid)?.ppid)
    protectedPids.add(pid);
  const protectedGroups = new Set([...protectedPids].flatMap((pid) => parents.get(pid)?.pgid ?? []));
  const live = new Set(
    owners
      .filter((owner) => !protectedPids.has(owner.pid) && inspectProcessIdentity(owner) === 'same')
      .map((owner) => owner.pid),
  );
  if (!live.size) return [];
  const leaders = new Set(
    rows
      .filter((row) => live.has(row.ppid) && row.pgid === row.pid && !protectedGroups.has(row.pgid))
      .map((row) => row.pid),
  );
  const listed = rows.filter(
    (row) => !protectedPids.has(row.pid) && !live.has(row.pid) && (live.has(row.ppid) || leaders.has(row.pgid)),
  );
  const recorded: { row: ProcessRow; record: MacosProcess }[] = [];
  for (const row of listed) {
    const processToken = captureProcessToken(row.pid);
    const start = processStartMicros(row.pid);
    if (processToken && start.status === 'running')
      recorded.push({ row, record: { pid: row.pid, processToken, startedAtMicros: start.startedAtMicros } });
    else if (start.status !== 'gone')
      operation?.output('stderr', `Not ending pid ${row.pid}: its identity cannot be captured.\n`);
  }
  const current = new Map((await listProcesses(operation)).map((row) => [row.pid, row]));
  return recorded
    .filter(({ row }) => {
      const again = current.get(row.pid);
      return again?.ppid === row.ppid && again.pgid === row.pgid;
    })
    .map(({ record }) => record);
}

/** The attempt directories under a hosted session's `apps`, each of which holds one `App.app`. */
export function hostedBundleDirs(area: string): string[] {
  const apps = join(area, 'apps');
  if (process.platform !== 'darwin' || !existsSync(apps)) return [];
  if (realpathSync(apps) !== apps) throw new Error('Hosted app data resolves outside its private area.');
  return readdirSync(apps)
    .filter((attempt) => hostedAppAttempt(attempt))
    .map((attempt) => join(apps, attempt))
    .filter((dir) => lstatSync(dir, { throwIfNoEntry: false })?.isDirectory());
}

/** Verifies owned bundle instances without blocking on process and executable probes. */
export function runningBundleInstancesAsync(root: string, operation?: StimContext): Promise<MacosProcess[]> {
  return runningInstancesInAsync(bundleDirs(root), operation);
}

/** Verifies the running copies of app bundles directly inside `dirs`. */
export async function runningInstancesInAsync(
  dirs: readonly string[],
  operation?: StimContext,
): Promise<MacosProcess[]> {
  operation?.signal.throwIfAborted();
  if (!dirs.length) return [];
  const listing = await runOperationFile(operation, getExecutor(), 'ps', ['-axww', '-o', 'pid=,comm='], {
    cwd: operation?.cwd,
    timeoutMs: 10_000,
    killSignal: 'SIGKILL',
  });
  const instances: MacosProcess[] = [];
  for (const pid of bundleCandidates(listing, dirs).filter((candidate) => candidate !== process.pid)) {
    operation?.signal.throwIfAborted();
    const record = bundleRecord(pid);
    if (!record) continue;
    let open: string;
    try {
      open = await runOperationFile(operation, getExecutor(), 'lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
        cwd: operation?.cwd,
        timeoutMs: 10_000,
        killSignal: 'SIGKILL',
      });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      operation?.signal.throwIfAborted();
      const partial = failedBundleListing(record, error);
      if (partial === null) continue;
      open = partial;
    }
    if (lsofNamesBundleExecutable(open, dirs)) instances.push(record);
  }
  return instances;
}
