import { readdirSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, isAbsolute, join, relative } from 'path';
import chalk from 'chalk';
import { getConfigDir } from '../../workspace/config.ts';
import { formatBytes } from '../../fs-util.ts';
import { pruneCache, type CacheDescriptor } from '../../cache/caches.ts';
import { canonicalPath } from './paths.ts';

export interface GcCache extends CacheDescriptor {
  machineGlobal?: string | null;
  willEmpty?: boolean;
  emptySkipped?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function cacheSweepIsScoped() {
  return Boolean(process.env.STIM_HOME);
}

function isInsideConfigDir(dir: string) {
  const root = canonicalPath(getConfigDir());
  const target = canonicalPath(dir);
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function machineGlobalReason(cache: CacheDescriptor): string | null {
  if (!cacheSweepIsScoped()) return null;
  if (cache.source === 'registered') return null;
  if (isInsideConfigDir(cache.dir)) return null;
  return `STIM_HOME scopes this config, but ${cache.dir} is outside it and therefore machine-global`;
}

const EVERY_CACHE = 'all';
const WORKSPACE_OUTPUTS = 'workspaces';

export function includesWorkspaceOutputs(name: string | null | undefined): boolean {
  const wanted = name?.trim().toLowerCase();
  return !wanted || wanted === EVERY_CACHE || wanted === WORKSPACE_OUTPUTS;
}

export function selectCaches(caches: CacheDescriptor[], name: string | null | undefined): CacheDescriptor[] {
  if (!name) return caches;
  const wanted = name.trim().toLowerCase();
  if (wanted === EVERY_CACHE) return caches;
  if (wanted === WORKSPACE_OUTPUTS) return [];
  return caches.filter((c) => c.name.toLowerCase().includes(wanted) || c.dir.toLowerCase().includes(wanted));
}

export function planCacheEmptying(caches: CacheDescriptor[], all: boolean): GcCache[] {
  const annotated = caches.map((c) => Object.assign({}, c, { machineGlobal: machineGlobalReason(c) }));
  if (!all) return annotated;
  return annotated.map((c) => {
    if (c.prune === 'report-only') {
      return Object.assign({}, c, {
        willEmpty: false,
        emptySkipped: 'report-only shared cache; Stim never deletes it',
      });
    }
    if (c.machineGlobal) {
      return Object.assign({}, c, { willEmpty: false, emptySkipped: c.machineGlobal });
    }
    if (!ownsItsDirectory(c)) {
      return Object.assign({}, c, {
        willEmpty: false,
        emptySkipped: `${c.dir} is not a directory this cache owns`,
      });
    }
    return Object.assign({}, c, { willEmpty: true, emptySkipped: null });
  });
}

// Metro file maps share os.tmpdir() with other processes and do not own that directory.
function ownsItsDirectory(cache: CacheDescriptor): boolean {
  if (Array.isArray(cache.files)) return false;
  const dir = canonicalPath(cache.dir);
  if (dirname(dir) === dir) return false;
  return ![homedir(), tmpdir(), getConfigDir()].map(canonicalPath).includes(dir);
}

function emptyCache(cache: CacheDescriptor): {
  removed: number;
  bytes: number;
  skipped: string | null;
  failed?: number;
} {
  if (cache.prune === 'report-only') {
    return { removed: 0, bytes: 0, skipped: 'report-only shared cache; Stim never deletes it' };
  }
  if (cache.prune !== 'atomic') {
    return pruneCache(cache, { olderThanDays: 0, now: Date.now() + DAY_MS });
  }

  let names: string[];
  try {
    names = readdirSync(cache.dir);
  } catch (e) {
    return { removed: 0, bytes: 0, skipped: `could not read ${cache.dir}: ${(e as Error).message}` };
  }
  let removed = 0;
  let failed = 0;
  for (const name of names) {
    try {
      rmSync(join(cache.dir, name), { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, bytes: failed ? 0 : (cache.bytes ?? 0), failed, skipped: null };
}

function reportFailures(cache: CacheDescriptor, failed: number | undefined): void {
  if (!failed) return;
  console.log(
    chalk.red(`${cache.name}: ${failed} entr${failed === 1 ? 'y' : 'ies'} in ${cache.dir} could not be removed`),
  );
  process.exitCode = 1;
}

export function trimCaches(caches: GcCache[], olderThan: number): void {
  let cacheBytes = 0;
  for (const c of caches) {
    if (c.machineGlobal) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${c.machineGlobal}`));
      continue;
    }
    const r = pruneCache(c, { olderThanDays: olderThan });
    if (r.skipped) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${r.skipped}`));
    } else if (r.removed) {
      cacheBytes += r.bytes;
      console.log(
        chalk.green(`Trimmed ${c.name}: ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'} (${formatBytes(r.bytes)})`),
      );
    } else if (!r.failed) {
      console.log(chalk.dim(`${c.name}: nothing older than ${olderThan}d`));
    }
    reportFailures(c, r.failed);
  }

  if (cacheBytes) {
    console.log(
      chalk.dim(
        `Trimmed ${formatBytes(cacheBytes)} of shared cache. The next build that wanted those entries pays to rebuild them.`,
      ),
    );
  }
}

export function emptyCaches(caches: GcCache[]): void {
  let cacheBytes = 0;
  for (const c of caches) {
    if (!c.willEmpty) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${c.emptySkipped}`));
      continue;
    }
    const r = emptyCache(c);
    if (r.skipped) {
      console.log(chalk.yellow(`Left ${c.name} alone: ${r.skipped}`));
    } else if (r.removed) {
      cacheBytes += r.bytes;
      console.log(
        chalk.green(`Emptied ${c.name}: ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'} (${formatBytes(r.bytes)})`),
      );
    } else if (!r.failed) {
      console.log(chalk.dim(`${c.name}: already empty`));
    }
    reportFailures(c, r.failed);
  }
  if (cacheBytes) {
    console.log(
      chalk.dim(
        `Emptied ${formatBytes(cacheBytes)} of shared cache. Every build that wanted any of it now pays to rebuild it.`,
      ),
    );
  }
}
