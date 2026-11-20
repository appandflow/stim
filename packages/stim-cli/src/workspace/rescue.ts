import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { workspaceId } from '@stim-cli/core';
import { readRescuedCopies, rescuedRoot, type RescuedCopy, type RescuedItem } from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import { answered } from './bounded-read.ts';
import { isKeypairName } from './cargo-target.ts';
import { absent } from './scan-rules.ts';

const RESCUE_CAP_BYTES = 50 * 1024 * 1024;
const RESCUE_KEEP_MS = 30 * 24 * 60 * 60_000;
const RESCUE_MS = 30_000;
const MAX_RESCUE_ENTRIES = 1_000_000;

// @ref LLP 0002#rescue-copies -- what cleanup cannot restore is copied aside before the delete
/**
 * Copies what deleting `deleting` inside the checkout `root` would lose for good, before it is deleted, into a new
 * folder under the rescue store, with a `manifest.json`: every file of a `.pnpm_patches` in `trees` that holds a
 * `pnpm patch` edit folder, and every `*-keypair.json` in any letter case in `targets`, at their paths relative to
 * `root`. Without `act` it only checks. Returns why the delete must not go ahead, or null. It copies only plain files:
 * a link where a protected file is, a linked `.pnpm_patches`, another volume than `deleting`'s, a rescue store inside
 * `deleting` or reached through a link, more than RESCUE_CAP_BYTES, more than MAX_RESCUE_ENTRIES entries, or a read or
 * copy that fails or does not finish within RESCUE_MS keeps the folder.
 */
export async function rescueBeforeDelete(
  root: string,
  deleting: string,
  { trees, targets }: { trees: readonly string[]; targets: readonly string[] },
  { act, signal }: { act: boolean; signal?: AbortSignal | undefined },
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
  const found: { source: string; size: number }[] = [];
  let checkout = root;
  let store = '';
  try {
    checkout = (await real(root)) ?? root;
    const doomed = (await real(deleting)) ?? deleting;
    store = join((await real(dirname(rescuedRoot()))) ?? dirname(rescuedRoot()), basename(rescuedRoot()));
    if (store === doomed || store.startsWith(`${doomed}${sep}`))
      throw new Error(`the rescue store ${store} lies inside ${doomed}`);
    const dev = (await bounded(doomed, () => lstat(doomed))).dev;
    let entries = 0;
    const walk = async (top: string, protectedName: (name: string) => boolean) => {
      const queue = [top];
      for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
        const here = dir;
        if ((await bounded(here, () => lstat(here))).dev !== dev) throw new Error(`${here} is on another volume`);
        for (const entry of await bounded(here, () => readdir(here, { withFileTypes: true }))) {
          if (++entries > MAX_RESCUE_ENTRIES)
            throw new Error(`more than ${MAX_RESCUE_ENTRIES} entries to look through`);
          const source = join(here, entry.name);
          const rel = relative(checkout, source);
          if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${source} is outside ${checkout}`);
          if (entry.isDirectory()) queue.push(source);
          else if (!protectedName(entry.name)) continue;
          else if (!entry.isFile()) throw new Error(`${source} is not a plain file`);
          else found.push({ source, size: (await bounded(source, () => lstat(source))).size });
        }
      }
    };
    const resolve = async (paths: readonly string[]) => {
      const resolved = new Set<string>();
      for (const path of paths) {
        const canonical = await real(path);
        if (canonical) resolved.add(canonical);
      }
      return resolved;
    };
    for (const tree of await resolve(trees)) {
      const patches = join(tree, '.pnpm_patches');
      const stat = await bounded(patches, () => lstat(patches)).catch((error: unknown) => {
        if (absent(error)) return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw new Error(`${patches} is a link`);
      if (!stat?.isDirectory()) continue;
      const listed = await bounded(patches, () => readdir(patches, { withFileTypes: true }));
      if (listed.some((entry) => entry.isDirectory())) await walk(patches, () => true);
    }
    for (const target of await resolve(targets)) await walk(target, isKeypairName);
    if (deadline - performance.now() <= 0) throw new Error(`it took over ${RESCUE_MS / 1000} s`);
  } catch (error) {
    signal?.throwIfAborted();
    return `its pnpm patches and Solana keypairs cannot be checked to copy aside: ${message(error)}`;
  }
  const bytes = found.reduce((sum, item) => sum + item.size, 0);
  if (bytes > RESCUE_CAP_BYTES)
    return `its pnpm patches and Solana keypairs hold over ${RESCUE_CAP_BYTES / 1024 / 1024} MB, more than cleanup copies aside`;
  if (!found.length || !act) return null;
  let dir: string | null = null;
  try {
    const realDirectory = async (path: string) => {
      const stat = await bounded(path, () => lstat(path)).catch((error: unknown) => {
        if (absent(error)) return null;
        throw error;
      });
      if (!stat) await bounded(path, () => mkdir(path, { mode: 0o700 }));
      else if (!stat.isDirectory()) throw new Error(`${path} is not a real directory`);
    };
    const workspace = join(store, workspaceId(checkout));
    await realDirectory(store);
    await realDirectory(workspace);
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-`;
    dir = await bounded(workspace, () => mkdtemp(join(workspace, stamp)));
    const into = dir;
    const items: RescuedItem[] = [];
    for (const { source, size } of found) {
      const copy = join(into, relative(checkout, source));
      await bounded(copy, async () => {
        await mkdir(dirname(copy), { recursive: true });
        await copyFile(source, copy, constants.COPYFILE_EXCL);
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

/**
 * Removes the rescued copies older than RESCUE_KEEP_MS at `now`, each only when it resolves to its own folder in the
 * rescue store under the canonical Stim home, so a linked store or workspace folder leads to no removal outside it.
 */
export async function expireRescued(now: number): Promise<void> {
  const store = join(await realpath(dirname(rescuedRoot())), basename(rescuedRoot()));
  for (const copy of readRescuedCopies()) {
    if (now - copy.at <= RESCUE_KEEP_MS) continue;
    const resolved = await realpath(copy.dir).catch(() => null);
    if (resolved === join(store, basename(dirname(copy.dir)), basename(copy.dir)))
      await rm(resolved, { recursive: true, force: true });
  }
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
