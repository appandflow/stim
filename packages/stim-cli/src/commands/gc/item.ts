import type { StimContext } from '@stim-cli/core';
import { discoverCaches, sizeCaches } from '../../cache/caches.ts';
import { canonicalPath } from './paths.ts';
import { emptyCaches, planCacheEmptying } from './caches.ts';
import { archiveRefusal, collectArchives, deleteArchives, type ArchiveKind } from './archives.ts';
import { collectGcMemory, GRADLE_DAEMONS_KIND, reclaimMemory, WATCHMAN_KIND } from './memory.ts';
import { clearWorkspaceOutputs, collectWorkspaceOutputs, isInsideWorkspaces } from './workspaces.ts';
import { createGcResults, type GcOutput, type GcResult } from './results.ts';

/**
 * One item Stim Desktop deletes on its own, outside a maintenance run: a registered shared cache emptied whole, the
 * build outputs of idle workspaces, one archived workspace or one kind of its content, or a helper daemon's memory.
 */
export type GcItem =
  | { kind: 'cache'; dir: string }
  | { kind: 'workspace-outputs' }
  | { kind: 'archive'; id: string; part?: ArchiveKind }
  | { kind: 'watchman' }
  | { kind: 'gradle-daemons' };

export const GC_ITEM_KINDS: readonly GcItem['kind'][] = [
  'cache',
  'workspace-outputs',
  'archive',
  'watchman',
  'gradle-daemons',
];
export const ARCHIVE_PARTS: readonly ArchiveKind[] = ['logs', 'recordings', 'agentActions'];

export interface GcItemResult {
  results: GcResult[];
  failures: number;
  /** Why the item cannot be deleted at all: an unknown cache or archive. */
  refusal?: { code: string; message: string; remedy: string };
}

/** Deletes one item after resolving it again against what is on disk; never a path the caller made up. */
export async function deleteGcItem(item: GcItem, operation?: StimContext): Promise<GcItemResult> {
  const env = operation?.env ?? process.env;
  const signal = operation?.signal;
  const results = createGcResults();
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
      );
      break;
    }
    case 'workspace-outputs': {
      const report = await collectWorkspaceOutputs({
        olderThan: null,
        now: Date.now(),
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
      failures = await deleteArchives(selection, output, signal);
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
