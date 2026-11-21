import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { workspaceId } from '@stim-cli/core';
import { readRescuedCopies, rescuedRoot, type RescuedCopy, type RescuedItem } from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import { answered } from './bounded-read.ts';
import { isKeypairName } from './cargo-target.ts';
import { absent } from './scan-rules.ts';

const RESCUE_KEEP_MS = 30 * 24 * 60 * 60_000;
const RESCUE_MS = 30_000;

// @ref LLP 0002#rescue-copies -- what cleanup cannot restore is copied aside before the delete
/**
 * Copies what a delete inside the checkout `root` would lose for good into a new folder under the rescue store, with a
 * `manifest.json`, at their paths relative to `root`: every file of the `.pnpm_patches` of each node_modules in
 * `trees`, and with `whole`, of every node_modules in `root`, plus every `*-keypair.json` in any letter case anywhere in
 * it outside `.git` and node_modules. Links are neither followed nor copied. Returns why the delete must not go ahead,
 * when a read or copy fails or does not finish within RESCUE_MS, or null.
 */
export async function rescueBeforeDelete(
  root: string,
  { trees, whole = false }: { trees: readonly string[]; whole?: boolean },
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline = performance.now() + RESCUE_MS;
  const bounded = <T>(label: string, start: () => Promise<T>) => {
    const left = deadline - performance.now();
    if (left <= 0) throw new Error(`it took over ${RESCUE_MS / 1000} s`);
    return answered(label, start, left, signal);
  };
  const real = (path: string) =>
    bounded(path, () => realpath(path)).catch((error: unknown) => {
      if (absent(error)) return null;
      throw error;
    });
  const found: string[] = [];
  let dir: string | null = null;
  try {
    const checkout = (await real(root)) ?? root;
    const walk = async (top: string, worktree: boolean) => {
      const queue = [top];
      for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
        const here = next;
        for (const entry of await bounded(here, () => readdir(here, { withFileTypes: true }))) {
          const path = join(here, entry.name);
          if (worktree && entry.name === 'node_modules') {
            if (entry.isDirectory()) await patches(path);
          } else if (entry.isDirectory()) {
            if (!worktree || entry.name !== '.git') queue.push(path);
          } else if (entry.isFile() && (!worktree || isKeypairName(entry.name))) found.push(path);
        }
      }
    };
    const patches = async (modules: string) => {
      const patchDir = join(modules, '.pnpm_patches');
      const stat = await bounded(patchDir, () => lstat(patchDir)).catch((error: unknown) => {
        if (absent(error)) return null;
        throw error;
      });
      if (stat?.isDirectory()) await walk(patchDir, false);
    };
    if (whole) await walk(checkout, true);
    for (const tree of trees) {
      const canonical = await real(tree);
      if (canonical?.startsWith(`${checkout}${sep}`)) await patches(canonical);
    }
    if (!found.length) return null;
    const workspace = join(rescuedRoot(), workspaceId(checkout));
    await bounded(workspace, () => mkdir(workspace, { recursive: true, mode: 0o700 }));
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-`;
    dir = await bounded(workspace, () => mkdtemp(join(workspace, stamp)));
    const into = dir;
    const items: RescuedItem[] = [];
    for (const source of found) {
      const copy = join(into, relative(checkout, source));
      const size = await bounded(copy, async () => {
        await mkdir(dirname(copy), { recursive: true });
        await copyFile(source, copy, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        return (await lstat(copy)).size;
      });
      items.push({ source, copy, size });
    }
    const manifest = JSON.stringify({ from: checkout, at: Date.now(), items }, null, 2);
    await bounded(into, () => writeFile(join(into, 'manifest.json'), manifest, { flag: 'wx' }));
    if (deadline - performance.now() <= 0) throw new Error(`it took over ${RESCUE_MS / 1000} s`);
  } catch (error) {
    signal?.throwIfAborted();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    return `its pnpm patches and Solana keypairs could not be copied aside: ${message(error)}`;
  }
  return null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Removes the rescued copies older than RESCUE_KEEP_MS at `now`. */
export async function expireRescued(now: number): Promise<void> {
  for (const copy of readRescuedCopies())
    if (now - copy.at > RESCUE_KEEP_MS) await rm(copy.dir, { recursive: true, force: true });
}

/** The rescued copies made at or after `since`. */
export function rescuedSince(since: number): RescuedCopy[] {
  return readRescuedCopies().filter((copy) => copy.at >= since);
}

/** One doctor note per rescued copy, naming each file's source so an agent can copy it back. */
export function rescuedFindings(now: number): Finding[] {
  return readRescuedCopies().map((copy) => {
    const days = Math.floor((now - copy.at) / 86_400_000);
    return {
      level: 'note',
      title: `Cleanup copied ${copy.items.length} file${copy.items.length === 1 ? '' : 's'} aside before deleting part of ${copy.from}`,
      detail: `${copy.dir}, ${days} day${days === 1 ? '' : 's'} old: ${copy.items.map((item) => item.source).join(', ')}. stim gc removes it ${RESCUE_KEEP_MS / 86_400_000} days after the copy.`,
      fix: `To restore a file, copy it from ${copy.dir} back to its source path; manifest.json there lists each one.`,
    };
  });
}
