import type { StimContext } from '@stim-cli/core';
import { isJsonObject } from '@stim-cli/core/state';
import { discoverCaches, sizeCaches } from '../../cache/caches.ts';
import { canonicalPath } from './paths.ts';
import { emptyCaches, planCacheEmptying } from './caches.ts';
import { archiveRefusal, collectArchives, deleteArchives, type ArchiveKind } from './archives.ts';
import { collectGcMemory, GRADLE_DAEMONS_KIND, reclaimMemory, WATCHMAN_KIND } from './memory.ts';
import {
  clearWorkspaceOutputs,
  collectOrphanedWorkspaces,
  collectWorkspaceOutputs,
  isInsideWorkspaces,
} from './workspaces.ts';
import { collectProjectRecords } from './records.ts';
import { loadConfig } from '../../workspace/config.ts';
import { workspaceDir } from '../../workspace/paths.ts';
import { listMountedVolumes } from '../../fs-util.ts';
import { createGcResults, type GcOutput, type GcResult } from './results.ts';
import { stageItemTrash } from '../../workspace/item-trash.ts';
import { openGcLog } from './log.ts';

/**
 * One item Stim Desktop deletes as its own queue unit: a registered shared cache emptied whole, the
 * build outputs of idle workspaces, one archived workspace or one kind of its content, or a helper daemon's memory.
 */
export type GcItem =
  | { kind: 'cache'; dir: string }
  | { kind: 'workspace-outputs' }
  | { kind: 'archive'; id: string; part?: ArchiveKind }
  | { kind: 'watchman' }
  | { kind: 'gradle-daemons' };

const GC_ITEM_KINDS: readonly GcItem['kind'][] = [
  'cache',
  'workspace-outputs',
  'archive',
  'watchman',
  'gradle-daemons',
];
const ARCHIVE_PARTS: readonly ArchiveKind[] = ['logs', 'recordings', 'agentActions'];

export interface GcItemRequest {
  item: GcItem;
  client: 'desktop';
}

export function validGcItem(item: unknown): item is GcItem {
  if (!isJsonObject(item) || !GC_ITEM_KINDS.some((kind) => kind === item.kind)) return false;
  const keys = Object.keys(item);
  const only = (...allowed: string[]) => keys.every((key) => key === 'kind' || allowed.includes(key));
  if (item.kind === 'cache')
    return only('dir') && typeof item.dir === 'string' && item.dir.length > 0 && item.dir.length <= 4096;
  if (item.kind === 'archive')
    return (
      only('id', 'part') &&
      typeof item.id === 'string' &&
      /^[\w.-]{1,200}$/.test(item.id) &&
      (item.part === undefined || ARCHIVE_PARTS.some((part) => part === item.part))
    );
  return only();
}

export interface GcItemResult {
  results: GcResult[];
  failures: number;
  /** Why the item cannot be deleted at all: an unknown cache or archive. */
  refusal?: { code: string; message: string; remedy: string };
}

/** Deletes one item after resolving it again against what is on disk; never a path the caller made up. */
export async function deleteGcItem(
  item: GcItem,
  operation?: StimContext,
  onStaged?: () => void,
): Promise<GcItemResult> {
  const env = operation?.env ?? process.env;
  const signal = operation?.signal;
  const results = createGcResults(
    onStaged ? openGcLog({ trigger: 'desktop', runId: operation?.runId }).record : undefined,
  );
  let failed = 0;
  const output: GcOutput = { log: () => {}, error: () => {}, record: results.record, fail: () => failed++ };
  let failures = 0;
  switch (item.kind) {
    case 'cache': {
      const dir = canonicalPath(item.dir);
      const caches = discoverCaches(env, operation?.cwd).filter(
        (cache) => !isInsideWorkspaces(cache.dir) && canonicalPath(cache.dir) === dir,
      );
      if (!caches.length)
        return {
          results: [],
          failures: 0,
          refusal: {
            code: 'STIM_BAD_ARG',
            message: `${item.dir} is not a shared cache Stim registered.`,
            remedy: 'Choose a cache from the storage report.',
          },
        };
      failures = await emptyCaches(
        planCacheEmptying(await sizeCaches(caches, operation), true, env),
        output,
        signal,
        operation,
        onStaged
          ? async (path, bytes) => {
              const staged = await stageItemTrash(path, bytes, { kind: 'cache', id: dir }, signal);
              if (staged) onStaged();
              return staged;
            }
          : undefined,
      );
      break;
    }
    case 'workspace-outputs': {
      const config = loadConfig();
      const { orphaned } = await collectOrphanedWorkspaces(Object.keys(config?.projects ?? {}), listMountedVolumes(), {
        measure: false,
        operation,
      });
      const report = await collectWorkspaceOutputs({
        olderThan: null,
        now: Date.now(),
        exclude: [
          ...orphaned.map((entry) => entry.dir),
          ...collectProjectRecords(config).deadProjects.map(workspaceDir),
        ],
        signal,
        operation,
        lighten: true,
      });
      failures = (await clearWorkspaceOutputs(report, { olderThan: null, signal, operation, lighten: true }, output))
        .failures;
      break;
    }
    case 'archive': {
      const selection = await collectArchives({ kind: item.part ?? null, id: item.id }, signal);
      const refusal = archiveRefusal(selection);
      if (refusal) return { results: [], failures: 0, refusal };
      failures = await deleteArchives(
        selection,
        output,
        signal,
        onStaged
          ? async (path, bytes, id, part) => {
              const staged = await stageItemTrash(
                path,
                bytes,
                { kind: 'archive', id, ...(part ? { part } : {}) },
                signal,
              );
              if (staged) onStaged();
              return staged;
            }
          : undefined,
      );
      break;
    }
    case 'watchman':
    case 'gradle-daemons': {
      const kind = item.kind === 'watchman' ? WATCHMAN_KIND : GRADLE_DAEMONS_KIND;
      const report = await collectGcMemory(
        { watchman: kind === WATCHMAN_KIND, gradle: kind === GRADLE_DAEMONS_KIND },
        env,
        operation,
      );
      failures = await reclaimMemory(kind, report, output, operation);
      break;
    }
  }
  return { results: results.take(), failures: Math.max(failures, failed) };
}
