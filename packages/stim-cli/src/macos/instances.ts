import { existsSync, realpathSync } from 'node:fs';
import type { MacosProcess } from '@stim-cli/core/state';
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
export function bundleCandidates(psOutput: string, dirs: readonly string[]): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match && isBundleExecutable(match[2]!, dirs)) pids.push(Number(match[1]));
  }
  return pids;
}

/** Whether `lsof -Fn -d txt` output for one process names a bundle executable inside `dirs`. */
export function lsofNamesBundleExecutable(lsofOutput: string, dirs: readonly string[]): boolean {
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

/** Verifies owned bundle instances without blocking on process and executable probes. */
export async function runningBundleInstancesAsync(root: string, operation?: StimContext): Promise<MacosProcess[]> {
  operation?.signal.throwIfAborted();
  const dirs = bundleDirs(root);
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
