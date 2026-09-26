import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { LOG_ROTATE_BYTES, rotatedLogPath } from '@stim-cli/core';
import { withDirLock } from '../../dir-lock.ts';
import { formatBytes, isOnMountedVolume, listMountedVolumes } from '../../fs-util.ts';
import { readCollectors } from '../../collector/state.ts';
import { workspaceInUse, withIdleWorkspace } from '../../workspace/in-use.ts';
import { listWorkspaceDirs } from './workspaces.ts';

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

function fileSize(path: string): number {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
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

function excess(logsDir: string): number {
  return cappedFiles(logsDir).reduce((sum, { file }) => sum + trimmable(fileSize(file)), 0);
}

function collectorReason(root: string): string | null {
  const platforms = Object.keys(readCollectors(root));
  return platforms.length ? `a device log collector is recorded for ${platforms.join(', ')}` : null;
}

export function collectWorkspaceLogs({ exclude = [] }: { exclude?: readonly string[] } = {}): WorkspaceLogs[] {
  const mountedVolumes = listMountedVolumes();
  const entries: WorkspaceLogs[] = [];
  for (const { dir, projectRoot, problem } of listWorkspaceDirs()) {
    if (exclude.includes(dir)) continue;
    if (projectRoot !== null && !isOnMountedVolume(projectRoot, mountedVolumes)) continue;
    const logsDir = join(dir, 'logs');
    let names: string[];
    try {
      names = readdirSync(logsDir);
    } catch {
      continue;
    }
    const bytes = names.reduce((sum, name) => sum + fileSize(join(logsDir, name)), 0);
    if (bytes === 0) continue;
    const trimBytes = excess(logsDir);
    let keptCode: WorkspaceLogsKeptCode | null = null;
    let keptReason: string | null = null;
    if (trimBytes > 0) {
      if (projectRoot === null) {
        keptCode = 'unresolved';
        keptReason = `workspace directory not resolved: ${problem ?? 'unknown project root'}`;
      } else {
        const inUse = workspaceInUse(projectRoot);
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
  return entries;
}

function trimToNewest({ file, log }: { file: string; log: string }, maxBytes: number): number {
  if (!trimmable(fileSize(file))) return 0;
  return withDirLock(`${log}.lock`, () => {
    const { size, atime, mtime } = statSync(file);
    if (!trimmable(size)) return 0;
    const tail = Buffer.alloc(maxBytes);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, tail, 0, maxBytes, size - maxBytes);
    } finally {
      closeSync(fd);
    }
    const newline = tail.indexOf(10);
    const kept = newline === -1 ? Buffer.alloc(0) : tail.subarray(newline + 1);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmp, kept);
      utimesSync(tmp, atime, mtime);
      renameSync(tmp, file);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    return size - kept.length;
  });
}

export async function trimWorkspaceLogs(entries: readonly WorkspaceLogs[]): Promise<number> {
  let failures = 0;
  let trimmed = 0;
  for (const entry of entries) {
    const root = entry.projectRoot;
    if (!entry.willTrim || root === null) {
      if (entry.keptReason) console.log(chalk.dim(`Kept the logs of ${root ?? entry.dir}: ${entry.keptReason}`));
      continue;
    }
    let run;
    try {
      run = await withIdleWorkspace(
        root,
        () => {
          const collector = collectorReason(root);
          if (collector) return { kept: collector, bytes: 0 };
          const bytes = cappedFiles(join(entry.dir, 'logs')).reduce(
            (sum, capped) => sum + trimToNewest(capped, LOG_ROTATE_BYTES),
            0,
          );
          return { kept: null, bytes };
        },
        { purpose: 'gc' },
      );
    } catch (error) {
      failures++;
      console.log(chalk.red(`Could not trim the logs of ${root}: ${(error as Error)?.message || String(error)}`));
      continue;
    }
    if (!run.ran || run.value.kept) {
      const kept = run.ran ? run.value.kept : `in use: ${run.reasons.join('; ')}`;
      console.log(chalk.yellow(`Kept the logs of ${root}: ${kept}`));
      continue;
    }
    trimmed += run.value.bytes;
    console.log(chalk.green(`Trimmed the logs of ${root} (${formatBytes(run.value.bytes)})`));
  }
  if (trimmed) console.log(chalk.dim(`Trimmed ${formatBytes(trimmed)} of workspace logs.`));
  return failures;
}
