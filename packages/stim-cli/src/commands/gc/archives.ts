import chalk from 'chalk';
import { readArchives, type ArchivedWorkspace } from '@stim-cli/core/state';
import { deleteSelectedArchives, sweepArchiveStaging, type ArchiveStaging } from '../../archive.ts';
import { formatBytes } from '../../fs-util.ts';
import { recordGcResult } from './results.ts';

export interface ArchiveSelection {
  records: { id: string; kinds: string[]; bytes: number; expires: ArchivedWorkspace['expires']; willDelete: boolean }[];
  staging: ArchiveStaging[];
  unknownId: string | null;
  knownIds: string[];
  kind: 'logs' | 'recordings' | 'agentActions' | null;
}

export function collectArchives(scope: string, olderThan: number | null, now: number): ArchiveSelection {
  const wanted = scope.trim().toLowerCase();
  const records = readArchives();
  const id = wanted.startsWith('archived:') ? scope.trim().slice('archived:'.length) : null;
  const kind =
    wanted === 'archived-logs'
      ? 'logs'
      : wanted === 'archived-recordings'
        ? 'recordings'
        : wanted === 'archived-agent'
          ? 'agentActions'
          : null;
  const match = id !== null ? records.find((record) => record.id.toLowerCase() === id.toLowerCase()) : null;
  return {
    records: records
      .filter((record) => id === null || record.id === match?.id)
      .map((record) => ({
        id: record.id,
        kinds: kind
          ? [kind]
          : ['logs', 'recordings', 'agentActions', 'record'].filter(
              (key) => record.bytes[key as keyof typeof record.bytes] > 0,
            ),
        bytes: kind ? record.bytes[kind] : record.bytes.total,
        expires: record.expires,
        willDelete:
          (id === null && olderThan !== null ? now - Date.parse(record.removedAt) >= olderThan * 86_400_000 : true) &&
          (!kind || record.bytes[kind] > 0),
      })),
    staging: sweepArchiveStaging(false),
    unknownId: id !== null && !match ? id : null,
    knownIds: records.map((record) => record.id),
    kind,
  };
}

export function archiveLines(selection: ArchiveSelection): string[] {
  return [
    `Archived workspaces (${selection.records.length}):`,
    ...selection.records.map(
      (record) =>
        `  ${record.id}: ${record.kinds.join(', ')}, ${formatBytes(record.bytes)}, expires ${JSON.stringify(record.expires)}${record.willDelete ? '' : ' (kept)'}`,
    ),
    ...selection.staging.map(
      (entry) =>
        `  ${entry.path}: ${entry.kept ? `kept: ${entry.reason}` : 'abandoned staging'}${entry.removeCommand ? `; ${entry.removeCommand}` : ''}`,
    ),
  ];
}

export function deleteArchives(selection: ArchiveSelection | undefined): number {
  if (!selection) return 0;
  let failures = 0;
  for (const record of selection.records.filter((entry) => entry.willDelete)) {
    try {
      deleteSelectedArchives([record.id], selection.kind);
      recordGcResult('archive', 'done', record.id, { id: record.id, bytes: record.bytes });
    } catch (error) {
      failures++;
      recordGcResult('archive', 'failed', record.id, { id: record.id, detail: (error as Error).message });
      console.error(`Could not delete ${record.id}: ${(error as Error).message}`);
    }
  }
  try {
    const remaining = new Set(sweepArchiveStaging(true).map((entry) => entry.path));
    for (const entry of selection.staging) {
      if (!entry.kept && !remaining.has(entry.path))
        recordGcResult('archive', 'done', 'archive staging', { id: entry.path });
    }
  } catch (error) {
    failures++;
    console.error(`Could not clear archive staging: ${(error as Error).message}`);
  }
  return failures;
}

export function archiveRefusal(
  selection: ArchiveSelection | undefined,
): { code: string; message: string; remedy: string } | null {
  if (selection?.unknownId === undefined || selection.unknownId === null) return null;
  process.exitCode = 1;
  const message = `Unknown archive "${selection.unknownId}".`;
  const remedy = `Known archive ids: ${selection.knownIds.join(', ') || '(none)'}`;
  console.error(chalk.red(message));
  console.error(chalk.dim(remedy));
  console.error(chalk.red('failed: STIM_BAD_ARG'));
  return { code: 'STIM_BAD_ARG', message, remedy };
}

export function archiveWorkPending(selection: ArchiveSelection | undefined, otherWork: boolean): boolean {
  return (
    otherWork ||
    Boolean(selection?.records.some((record) => record.willDelete) || selection?.staging.some((entry) => !entry.kept))
  );
}
