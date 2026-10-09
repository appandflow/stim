import { existsSync, realpathSync } from 'node:fs';
import type { MacosProcess } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { inspectProcessIdentity, processStartMicros, captureProcessToken } from '../process-identity.ts';
import { macosDir } from './state.ts';

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

function unverified(pid: number, why: string): Error {
  return Object.assign(new Error(`Cannot verify macOS app pid ${pid}: ${why}; no signal was sent.`), {
    code: 'STIM_MACOS_OWNER_UNVERIFIED',
  });
}

/**
 * Every running process whose executable is an app bundle Stim built in the workspace's macOS directory, however it
 * was launched. Each identity is captured before its executable is confirmed with lsof.
 */
export function runningBundleInstances(root: string): MacosProcess[] {
  const dirs = bundleDirs(root);
  const instances: MacosProcess[] = [];
  for (const pid of candidatePids(dirs)) {
    const processToken = captureProcessToken(pid);
    const start = processStartMicros(pid);
    if (!processToken || start.status !== 'running') {
      if (start.status === 'gone') continue;
      throw unverified(pid, 'its identity cannot be captured');
    }
    const record = { pid, processToken, startedAtMicros: start.startedAtMicros };
    let open: string;
    try {
      open = getExecutor().runFile('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { timeoutMs: 10_000 });
    } catch (error) {
      if (['gone', 'different'].includes(inspectProcessIdentity(record))) continue;
      open = String((error as { stdout?: unknown }).stdout ?? '');
      if (!open.trim()) throw unverified(pid, `lsof failed (${(error as Error).message.split('\n')[0]})`);
    }
    if (lsofNamesBundleExecutable(open, dirs)) instances.push(record);
  }
  return instances;
}
