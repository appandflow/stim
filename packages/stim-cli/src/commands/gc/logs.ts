import { open, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import { LOG_ROTATE_BYTES, rotatedLogPath, withDirLockTransaction, type StimContext } from '@stim-cli/core';
import { formatBytes, isOnMountedVolume, listMountedVolumes } from '../../fs-util.ts';
import { readCollectors } from '../../collector/state.ts';
import { workspaceInUseAsync, withIdleWorkspace } from '../../workspace/in-use.ts';
import { listWorkspaceDirs } from './workspaces.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';

const CAPPED_LOGS: readonly string[] = ['metro.ndjson', 'client.ndjson', 'device.ndjson'];

const TRIM_ABOVE_BYTES = 2 * LOG_ROTATE_BYTES;

export type WorkspaceLogsKeptCode = 'unresolved' | 'in-use' | 'collector';

export interface WorkspaceLogs {
  dir: string;
  projectRoot: string | null;
  bytes: number;
  trimBytes: number;
  willTrim: boolean;
  keptCode: WorkspaceLogsKeptCode | null;
  keptReason: string | null;
}

async function fileSize(path: string, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  try {
    const metadata = await stat(path);
    signal?.throwIfAborted();
    return metadata.isFile() ? metadata.size : 0;
  } catch {
    signal?.throwIfAborted();
    return 0;
  }
}

function cappedFiles(logsDir: string): { file: string; log: string }[] {
  return CAPPED_LOGS.flatMap((name) => {
    const log = join(logsDir, name);
    return [
      { file: log, log },
      { file: rotatedLogPath(log), log },
    ];
  });
}

function trimmable(size: number): number {
  return size > TRIM_ABOVE_BYTES ? size - LOG_ROTATE_BYTES : 0;
}

async function excess(logsDir: string, signal?: AbortSignal): Promise<number> {
  let bytes = 0;
  for (const { file } of cappedFiles(logsDir)) bytes += trimmable(await fileSize(file, signal));
  return bytes;
}

function collectorReason(root: string): string | null {
  const platforms = Object.keys(readCollectors(root));
  return platforms.length ? `a device log collector is recorded for ${platforms.join(', ')}` : null;
}

export async function collectWorkspaceLogs({
  exclude = [],
  operation,
}: { exclude?: readonly string[]; operation?: StimContext } = {}): Promise<WorkspaceLogs[]> {
  const signal = operation?.signal;
  signal?.throwIfAborted();
  const mountedVolumes = listMountedVolumes();
  const entries: WorkspaceLogs[] = [];
  for (const { dir, projectRoot, problem } of listWorkspaceDirs()) {
    signal?.throwIfAborted();
    if (exclude.includes(dir)) continue;
    if (projectRoot !== null && !isOnMountedVolume(projectRoot, mountedVolumes)) continue;
    const logsDir = join(dir, 'logs');
    let names: string[];
    try {
      names = await readdir(logsDir);
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    let bytes = 0;
    for (const name of names) bytes += await fileSize(join(logsDir, name), signal);
    if (bytes === 0) continue;
    const trimBytes = await excess(logsDir, signal);
    let keptCode: WorkspaceLogsKeptCode | null = null;
    let keptReason: string | null = null;
    if (trimBytes > 0) {
      if (projectRoot === null) {
        keptCode = 'unresolved';
        keptReason = `workspace directory not resolved: ${problem ?? 'unknown project root'}`;
      } else {
        const inUse = await workspaceInUseAsync(projectRoot, {}, signal, operation);
        const collector = collectorReason(projectRoot);
        if (inUse.length) {
          keptCode = 'in-use';
          keptReason = `in use: ${inUse.join('; ')}`;
        } else if (collector) {
          keptCode = 'collector';
          keptReason = collector;
        }
      }
    }
    entries.push({
      dir,
      projectRoot,
      bytes,
      trimBytes,
      willTrim: trimBytes > 0 && keptCode === null,
      keptCode,
      keptReason,
    });
  }
  signal?.throwIfAborted();
  return entries;
}

async function trimToNewest(
  { file, log }: { file: string; log: string },
  maxBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  if (!trimmable(await fileSize(file, signal))) return 0;
  return withDirLockTransaction(
    `${log}.lock`,
    async () => {
      signal?.throwIfAborted();
      const { size, atime, mtime } = await stat(file);
      signal?.throwIfAborted();
      if (!trimmable(size)) return 0;
      const tail = Buffer.alloc(maxBytes);
      const fd = await open(file, 'r');
      try {
        signal?.throwIfAborted();
        await fd.read(tail, 0, maxBytes, size - maxBytes);
      } finally {
        await fd.close();
      }
      signal?.throwIfAborted();
      const newline = tail.indexOf(10);
      const kept = newline === -1 ? Buffer.alloc(0) : tail.subarray(newline + 1);
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await writeFile(tmp, kept, { signal });
        await utimes(tmp, atime, mtime);
        signal?.throwIfAborted();
        await rename(tmp, file);
      } finally {
        await rm(tmp, { force: true });
      }
      return size - kept.length;
    },
    { signal },
  );
}

export async function trimWorkspaceLogs(
  entries: readonly WorkspaceLogs[],
  output: GcOutput = GC_OUTPUT,
  operation?: StimContext,
): Promise<number> {
  const signal = operation?.signal;
  signal?.throwIfAborted();
  let failures = 0;
  let trimmed = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    const root = entry.projectRoot;
    if (!entry.willTrim || root === null) {
      if (entry.keptReason) output.log(chalk.dim(`Kept the logs of ${root ?? entry.dir}: ${entry.keptReason}`));
      continue;
    }
    let run;
    try {
      run = await withIdleWorkspace(
        root,
        async () => {
          const collector = collectorReason(root);
          if (collector) return { kept: collector, bytes: 0 };
          let bytes = 0;
          for (const capped of cappedFiles(join(entry.dir, 'logs'))) {
            signal?.throwIfAborted();
            bytes += await trimToNewest(capped, LOG_ROTATE_BYTES, signal);
          }
          return { kept: null, bytes };
        },
        { purpose: 'gc', operation },
      );
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      signal?.throwIfAborted();
      failures++;
      output.log(chalk.red(`Could not trim the logs of ${root}: ${(error as Error)?.message || String(error)}`));
      output.record('workspaceLogs', 'failed', root, {
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!run.ran || run.value.kept) {
      const kept = run.ran ? run.value.kept : `in use: ${run.reasons.join('; ')}`;
      output.log(chalk.yellow(`Kept the logs of ${root}: ${kept}`));
      output.record('workspaceLogs', 'kept', root, { detail: kept });
      continue;
    }
    trimmed += run.value.bytes;
    output.log(chalk.green(`Trimmed the logs of ${root} (${formatBytes(run.value.bytes)})`));
    output.record('workspaceLogs', 'done', root, { bytes: run.value.bytes });
  }
  signal?.throwIfAborted();
  if (trimmed) output.log(chalk.dim(`Trimmed ${formatBytes(trimmed)} of workspace logs.`));
  return failures;
}
