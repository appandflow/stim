import { readArchivesAsync, type ArchivedWorkspace } from '@stim-cli/core/state';
import { deleteSelectedArchives, sweepArchiveStaging, type ArchiveStaging } from '../../archive.ts';
import { formatBytes } from '../../fs-util.ts';
import { parseArchiveSelector } from './archive-selector.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';

import type { ArchiveKind } from './archive-selector.ts';

export interface ArchiveSelection {
  records: { id: string; kinds: string[]; bytes: number; expires: ArchivedWorkspace['expires']; willDelete: boolean }[];
  staging: ArchiveStaging[];
  unknownId: string | null;
  knownIds: string[];
  kind: ArchiveKind | null;
}

async function stagingOrNone(signal?: AbortSignal): Promise<ArchiveStaging[]> {
  try {
    return await sweepArchiveStaging(false, 5000, signal);
  } catch {
    signal?.throwIfAborted();
    return [];
  }
}

export async function collectArchives(
  scope: string,
  olderThan: number | null,
  now: number,
  signal?: AbortSignal,
): Promise<ArchiveSelection> {
  signal?.throwIfAborted();
  const records = await readArchivesAsync(signal);
  const { kind, id } = parseArchiveSelector(scope) ?? { kind: null, id: null };
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
    staging: await stagingOrNone(signal),
    unknownId: id !== null && !match ? id : null,
    knownIds: records.map((record) => record.id),
    kind,
  };
}

export function archiveLines(selection: ArchiveSelection | undefined): string[] {
  if (!selection) return [];
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

export async function deleteArchives(
  selection: ArchiveSelection | undefined,
  output: GcOutput = GC_OUTPUT,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  if (!selection) return 0;
  let failures = 0;
  for (const record of selection.records.filter((entry) => entry.willDelete)) {
    signal?.throwIfAborted();
    try {
      await deleteSelectedArchives([record.id], selection.kind, signal);
      output.record('archive', 'done', record.id, { id: record.id, bytes: record.bytes });
    } catch (error) {
      signal?.throwIfAborted();
      failures++;
      output.record('archive', 'failed', record.id, { id: record.id, detail: (error as Error).message });
      output.error(`Could not delete ${record.id}: ${(error as Error).message}`);
    }
  }
  try {
    const remaining = new Set((await sweepArchiveStaging(true, 5000, signal)).map((entry) => entry.path));
    for (const entry of selection.staging) {
      if (!entry.kept && !remaining.has(entry.path))
        output.record('archive', 'done', 'archive staging', { id: entry.path });
    }
  } catch (error) {
    signal?.throwIfAborted();
    failures++;
    output.error(`Could not clear archive staging: ${(error as Error).message}`);
  }
  return failures;
}

export function archiveRefusal(
  selection: ArchiveSelection | undefined,
): { code: string; message: string; remedy: string } | null {
  if (selection?.unknownId === undefined || selection.unknownId === null) return null;
  const message = `Unknown archive "${selection.unknownId}".`;
  const remedy = `Known archive ids: ${selection.knownIds.join(', ') || '(none)'}`;
  return { code: 'STIM_BAD_ARG', message, remedy };
}

export function archiveWorkPending(selection: ArchiveSelection | undefined, otherWork: boolean): boolean {
  return (
    otherWork ||
    Boolean(selection?.records.some((record) => record.willDelete) || selection?.staging.some((entry) => !entry.kept))
  );
}
