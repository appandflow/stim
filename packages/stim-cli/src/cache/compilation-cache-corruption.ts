import { mkdirSync } from 'node:fs';
import { maintenanceDir } from '@stim-cli/core/state';
import { emptyCaches, planCacheEmptying } from '../commands/gc/caches.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import type { GcResult } from '../commands/gc/results.ts';
import { discoverCaches } from './caches.ts';
import type { CompilationCacheCorruption } from '../engine/xcode.ts';
import { maintenanceLogger } from '../maintenance/log.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';

export const COMPILATION_CACHE_CORRUPT = 'STIM_COMPILATION_CACHE_CORRUPT';

async function emptyCompilationCache(dir: string): Promise<string | null> {
  const results: GcResult[] = [];
  const cache = discoverCaches().find((candidate) => canonicalPath(candidate.dir) === canonicalPath(dir));
  if (cache?.source !== 'registered' || cache.prune !== 'atomic')
    return `${dir} is not a registered cache Stim empties whole`;
  const [planned] = planCacheEmptying([cache], true);
  await emptyCaches(planned ? [planned] : [], {
    log: () => {},
    error: () => {},
    record: (kind, status, label, { id = null, bytes = null, detail = null } = {}) => {
      results.push({ kind, status, label, id, bytes, detail });
    },
    fail: () => {},
  });
  const refused = results.find((result) => result.status !== 'done');
  return refused ? (refused.detail ?? `could not empty ${dir}`) : null;
}

function recordInMaintenanceLog(workspace: string, msg: string, fields: Record<string, unknown>, cleared: boolean) {
  try {
    mkdirSync(maintenanceDir(), { recursive: true });
    const logger = maintenanceLogger(resolveMaintenanceSettings(), `build-${process.pid}`, 'ios build');
    try {
      logger.write(cleared ? 'maintenance_action' : 'maintenance_failure', cleared ? 'info' : 'warn', msg, {
        ...fields,
        workspace,
      });
    } finally {
      logger.close();
    }
  } catch {}
}

/**
 * Empties the shared compilation cache a failed build reported corrupt, through the path `gc --delete --cache` uses,
 * unless another build may be using it. It never retries the build; the result is the refusal to print.
 */
export async function clearCorruptCompilationCache(
  corruption: CompilationCacheCorruption,
  workspace: string,
): Promise<{ code: typeof COMPILATION_CACHE_CORRUPT; message: string; remedy: string }> {
  const { dir, line } = corruption;
  let blocked: string | null;
  try {
    blocked = await emptyCompilationCache(dir);
  } catch (error) {
    blocked = error instanceof Error ? error.message : String(error);
  }
  const fields = { target: dir, category: 'compilation-cache', reason: line, ...(blocked ? { blocked } : {}) };
  if (blocked) {
    const message = `The shared compilation cache at ${dir} is corrupt (the compiler reported: ${line}). Stim did not empty it: ${blocked}.`;
    recordInMaintenanceLog(workspace, message, fields, false);
    return {
      code: COMPILATION_CACHE_CORRUPT,
      message,
      remedy:
        'Once the reason above is resolved, run `stim gc --delete --cache "compilation cache"`, then run the same command again.',
    };
  }
  const message = `The shared compilation cache at ${dir} was corrupt (the compiler reported: ${line}). Stim emptied it.`;
  recordInMaintenanceLog(workspace, message, fields, true);
  return {
    code: COMPILATION_CACHE_CORRUPT,
    message,
    remedy: 'Run the same command again. Its build starts with an empty compilation cache.',
  };
}
