import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { daemonClaimRoot } from '@stim-cli/core/state';
import { readRunningProcesses, runningFromReason } from '../workspace/running-from.ts';
import { takeLock } from './locks.ts';
import { BUILD_DIR, readRecords, writeState } from './store.ts';
import { removeTree, scratchName } from './tree.ts';

const SCRATCH_MAX_AGE_MS = 60 * 60_000;

function ownerAlive(name: string): boolean {
  try {
    process.kill(Number(name.split('-')[1]), 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Removes store entries nothing can run: trees other than current, previous, staged and `keep` (the entries live
 * claims name) that no process runs from, scratch directories whose owner is gone or that are an hour old, and
 * `.trash` leftovers. Each goes by rename into `.trash` first, so a half-removed read-only tree never stays in place.
 * Runs under the promotion lock. Where processes cannot be listed (Windows), every tree is kept.
 */
export function collectStore(root: string, keep: Iterable<string> = [], now: number = Date.now()): string[] {
  if (!existsSync(root)) return [];
  const { current, previous, staged, state } = readRecords(root);
  const kept = new Set([current?.dir, previous, staged?.dir, ...keep]);
  const running = readRunningProcesses();
  const trash = join(root, '.trash');
  mkdirSync(trash, { recursive: true });
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
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
  const installed = state.installed.filter((each) => existsSync(join(root, each.dir)));
  if (installed.length !== state.installed.length || removed.length > 0) writeState(root, { ...state, installed });
  return removed;
}

/** The store entries live resident processes run from: `engineDir` in the shared claims of this home's daemon root. */
export function liveEngineDirs(): string[] {
  return readClaimSet(daemonClaimRoot()).live.flatMap(({ mode, details }) =>
    mode === 'shared' && typeof details.engineDir === 'string' ? [details.engineDir] : [],
  );
}

/** `stim gc --delete`: collects an installed store unless a promotion holds its lock. */
export async function collectInstalledStore(root: string): Promise<void> {
  if (!existsSync(join(root, 'current.json'))) return;
  const lock = await takeLock(root, '.lock.sock');
  if (!lock) return;
  try {
    collectStore(root, liveEngineDirs());
  } finally {
    await lock.release();
  }
}
