import { existsSync } from 'fs';
import { rm } from 'node:fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import { listRecordedDevicesAsync, recordedBytes, type RecordedDevice } from '@stim-cli/core/state';
import { formatBytes, isOnMountedVolume, listMountedVolumes } from '../../fs-util.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';
import { listWorkspaceDirs, type WorkspaceDirEntry } from './workspaces.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export type RecordingKeptCode = 'unresolved' | 'retained' | 'recently-recorded';

/**
 * One workspace's device recordings. `withWorkspace` marks recordings of a gone workspace, which the orphaned
 * workspace and dead project sweeps remove with the whole workspace directory.
 */
export interface WorkspaceRecordings {
  dir: string;
  projectRoot: string | null;
  bytes: number;
  deleteBytes: number;
  willDelete: boolean;
  withWorkspace: boolean;
  keptCode: RecordingKeptCode | null;
  keptReason: string | null;
}

export interface RecordingsPlan {
  /** `--cache recordings` or `--cache all` without `--older-than`: delete every resolved workspace's recordings. */
  whole: boolean;
  olderThan: number | null;
  now: number;
}

type RecordingsEntry = WorkspaceDirEntry & { recordings: string; gone: boolean; devices: RecordedDevice[] };

function oldSegments(devices: readonly RecordedDevice[], olderThan: number, now: number) {
  const cutoff = now - olderThan * DAY_MS;
  return devices.flatMap((device) => device.segments).filter((segment) => !segment.open && segment.end < cutoff);
}

function planRecordings(
  entries: readonly RecordingsEntry[],
  { whole, olderThan, now }: RecordingsPlan,
): WorkspaceRecordings[] {
  return entries.map(({ recordings, projectRoot, problem, gone, devices }) => {
    const bytes = recordedBytes(devices);
    const entry = { dir: recordings, projectRoot, bytes, withWorkspace: false };
    const kept = (keptCode: RecordingKeptCode, keptReason: string): WorkspaceRecordings => ({
      ...entry,
      deleteBytes: 0,
      willDelete: false,
      keptCode,
      keptReason,
    });
    const remove = (deleteBytes: number, withWorkspace = false): WorkspaceRecordings => ({
      ...entry,
      withWorkspace,
      deleteBytes,
      willDelete: true,
      keptCode: null,
      keptReason: null,
    });
    if (projectRoot === null) {
      return kept('unresolved', `workspace directory not resolved: ${problem ?? 'unknown project root'}`);
    }
    if (gone) return remove(bytes, true);
    if (whole) return remove(bytes);
    if (olderThan !== null) {
      const old = oldSegments(devices, olderThan, now);
      return old.length
        ? remove(old.reduce((sum, segment) => sum + segment.bytes, 0))
        : kept('recently-recorded', `nothing recorded more than ${olderThan}d ago`);
    }
    return kept(
      'retained',
      'the last 15 minutes of footage per device stay until worktree remove, --cache recordings, --older-than or recording.enabled false',
    );
  });
}

/**
 * The device recordings of every workspace directory. Recordings in `gone` directories, which the orphaned
 * workspace and dead project sweeps remove whole, are listed with them; entries whose project root is on an
 * unmounted volume are left out.
 */
export async function collectRecordings(
  plan: RecordingsPlan,
  gone: readonly string[] = [],
  signal?: AbortSignal,
): Promise<WorkspaceRecordings[]> {
  signal?.throwIfAborted();
  const mountedVolumes = listMountedVolumes();
  const entries: RecordingsEntry[] = [];
  for (const entry of listWorkspaceDirs()) {
    signal?.throwIfAborted();
    if (entry.projectRoot !== null && !isOnMountedVolume(entry.projectRoot, mountedVolumes)) continue;
    const recordings = join(entry.dir, 'recordings');
    if (!existsSync(recordings)) continue;
    entries.push({
      ...entry,
      recordings,
      gone: gone.includes(entry.dir),
      devices: await listRecordedDevicesAsync(recordings, false, signal),
    });
  }
  signal?.throwIfAborted();
  return planRecordings(entries, plan);
}

/** Deletes what `planRecordings` chose, planning again from the files on disk. */
export async function deleteRecordings(
  report: readonly WorkspaceRecordings[],
  plan: RecordingsPlan,
  output: GcOutput = GC_OUTPUT,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  let failures = 0;
  for (const entry of report) {
    signal?.throwIfAborted();
    const label = entry.projectRoot ?? entry.dir;
    if (entry.withWorkspace) continue;
    if (!entry.willDelete) {
      if (entry.keptCode === 'unresolved' || entry.keptCode === 'recently-recorded') {
        output.log(chalk.dim(`Kept the device recordings of ${label}: ${entry.keptReason}`));
        output.record('recording', 'kept', label, { bytes: entry.bytes, detail: entry.keptReason });
      }
      continue;
    }
    try {
      let deleted = 0;
      if (plan.whole) {
        deleted = recordedBytes(await listRecordedDevicesAsync(entry.dir, false, signal));
        signal?.throwIfAborted();
        await rm(entry.dir, { recursive: true, force: true });
      } else if (plan.olderThan !== null) {
        const devices = await listRecordedDevicesAsync(entry.dir, false, signal);
        for (const segment of oldSegments(devices, plan.olderThan, plan.now)) {
          signal?.throwIfAborted();
          await rm(segment.file, { force: true });
          deleted += segment.bytes;
        }
      }
      output.log(chalk.green(`Deleted ${formatBytes(deleted)} of device recordings of ${label}`));
      output.record('recording', 'done', label, { bytes: deleted });
    } catch (error) {
      signal?.throwIfAborted();
      failures++;
      const detail = (error as Error)?.message || String(error);
      output.log(chalk.red(`Could not delete the device recordings of ${label}: ${detail}`));
      output.record('recording', 'failed', label, { bytes: entry.bytes, detail });
    }
  }
  signal?.throwIfAborted();
  return failures;
}

export function recordingLines(recordings: readonly WorkspaceRecordings[]): string[] {
  if (!recordings.length) return [];
  const total = recordings.reduce((sum, entry) => sum + entry.bytes, 0);
  const lines = [`Device recordings (${formatBytes(total)} in ${recordings.length}):`];
  for (const entry of recordings) {
    lines.push(`  ${formatBytes(entry.bytes).padStart(10)}  ${entry.projectRoot ?? entry.dir}`);
    lines.push(
      entry.withWorkspace
        ? '              would be DELETED with its gone workspace directory'
        : entry.willDelete
          ? `              would DELETE ${formatBytes(entry.deleteBytes)}`
          : `              kept: ${entry.keptReason}`,
    );
  }
  return lines;
}
