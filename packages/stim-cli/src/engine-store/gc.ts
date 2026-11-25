import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProcessStart } from '@stim-cli/core/process-identity';
import { readRunningProcesses, runningFromReason } from '../workspace/running-from.ts';
import { keptEntries, readBuildClaims } from './claims.ts';
import { keptJobUses, readJobUses, tarballFiles } from './jobs.ts';
import { takeLock } from './locks.ts';
import { BUILD_DIR, readRecords, writeState } from './store.ts';
import { removeTree, scratchName } from './tree.ts';

const SCRATCH_MAX_AGE_MS = 60 * 60_000;
const NPM_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const ownerAlive = (name: string): boolean => inspectProcessStart(Number(name.split('-')[1])).status !== 'gone';

/**
 * Removes store entries nothing can run: trees `keptEntries` does not keep, nor the three client builds offload jobs
 * used most recently within 24 hours (`keptJobUses`, whose npm tarballs stay too), that no process runs from, scratch
 * directories whose owner is gone or that are an hour old, `.trash` leftovers, and every other `.npm-cache` file once
 * any of them is a week old, so no npm index record outlives its content file. Each entry goes by rename into
 * `.trash` first, so a half-removed read-only tree never stays in place. Runs under the promotion lock, so no fetch
 * writes `.npm-cache` meanwhile. Where processes cannot be listed (Windows), every tree is kept. The build running
 * this module is always kept.
 */
export function collectStore(root: string, now: number = Date.now()): string[] {
  if (!existsSync(root)) return [];
  const self = fileURLToPath(import.meta.url);
  const canonicalRoot = realpathSync(root);
  const records = readRecords(root);
  const { state } = records;
  const kept = keptEntries(records, readBuildClaims(root));
  const jobs = keptJobUses(readJobUses(root), now);
  for (const { build } of jobs) kept.add(build);
  const running = readRunningProcesses();
  const trash = join(root, '.trash');
  mkdirSync(trash, { recursive: true });
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (self.startsWith(join(canonicalRoot, name) + sep)) continue;
    const path = join(root, name);
    const deletable = BUILD_DIR.test(name)
      ? !kept.has(name) && runningFromReason(path, running) === null
      : name.startsWith('.tmp-') && (!ownerAlive(name) || now - statSync(path).mtimeMs > SCRATCH_MAX_AGE_MS);
    if (!deletable) continue;
    chmodSync(path, statSync(path).mode | 0o200);
    renameSync(path, join(trash, `${name}${scratchName()}`));
    removed.push(name);
  }
  for (const name of readdirSync(trash)) removeTree(join(trash, name));
  const cache = join(root, '.npm-cache');
  const versions = new Set(jobs.flatMap(({ version }) => (version ? [version] : [])));
  trimNpmCache(cache, now, tarballFiles(cache, versions));
  const installed = state.installed.filter((each) => existsSync(join(root, each.dir)));
  if (installed.length !== state.installed.length || removed.length > 0) writeState(root, { ...state, installed });
  return removed;
}

function trimNpmCache(cache: string, now: number, keep: ReadonlySet<string>): void {
  if (!existsSync(cache)) return;
  const files = readdirSync(cache, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !keep.has(path));
  if (files.some((path) => now - statSync(path).mtimeMs > NPM_CACHE_MAX_AGE_MS)) {
    for (const path of files) rmSync(path, { force: true });
  }
}

/** `stim gc`: collects an installed store unless a promotion holds its lock. */
export async function collectInstalledStore(root: string): Promise<void> {
  if (!existsSync(join(root, 'current.json'))) return;
  const lock = await takeLock(root, '.lock.sock');
  if (!lock) return;
  try {
    collectStore(root);
  } finally {
    await lock.release();
  }
}
