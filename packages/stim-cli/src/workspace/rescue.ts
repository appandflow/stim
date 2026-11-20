import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
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
 * Copies what deleting `trees` and `targets` inside the checkout `root` would lose for good into a new folder under
 * `rescuedRoot()`, with a `manifest.json`: every file of a `.pnpm_patches` that holds a `pnpm patch` edit folder, and
 * every `*-keypair.json` in any letter case in a target, at their paths relative to `root`. Links are copied as links
 * and never followed. Without `act` it only finds them. Returns why the delete must not go ahead, or null: more than
 * RESCUE_CAP_BYTES to copy, another volume, more than MAX_RESCUE_ENTRIES entries, or a read or copy that fails or
 * does not finish within RESCUE_MS.
 */
export async function rescueBeforeDelete(
  root: string,
  { trees, targets }: { trees: readonly string[]; targets: readonly string[] },
  { act, signal }: { act: boolean; signal?: AbortSignal | undefined },
): Promise<string | null> {
  const started = performance.now();
  const bounded = <T>(label: string, start: () => Promise<T>) =>
    answered(label, start, Math.max(1, RESCUE_MS - (performance.now() - started)), signal);
  const found: { source: string; size: number; link: string | null }[] = [];
  let entries = 0;
  const walk = async (top: string, keep: (name: string) => boolean) => {
    const dev = (await bounded(top, () => lstat(top))).dev;
    const queue = [top];
    for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
      const here = dir;
      if ((await bounded(here, () => lstat(here))).dev !== dev) throw new Error(`${here} is on another volume`);
      for (const entry of await bounded(here, () => readdir(here, { withFileTypes: true }))) {
        if (++entries > MAX_RESCUE_ENTRIES) throw new Error(`more than ${MAX_RESCUE_ENTRIES} entries to look through`);
        const source = join(here, entry.name);
        const rel = relative(root, source);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${source} is outside ${root}`);
        if (entry.isDirectory()) queue.push(source);
        else if (keep(entry.name))
          found.push(
            entry.isSymbolicLink()
              ? { source, size: 0, link: await bounded(source, () => readlink(source)) }
              : { source, size: (await bounded(source, () => lstat(source))).size, link: null },
          );
      }
    }
  };
  try {
    for (const tree of trees) {
      const patches = join(tree, '.pnpm_patches');
      const stat = await bounded(patches, () => lstat(patches)).catch((error: unknown) => {
        if (absent(error)) return null;
        throw error;
      });
      if (!stat?.isDirectory()) continue;
      const listed = await bounded(patches, () => readdir(patches, { withFileTypes: true }));
      if (listed.some((entry) => entry.isDirectory())) await walk(patches, () => true);
    }
    for (const target of targets) await walk(target, isKeypairName);
  } catch (error) {
    signal?.throwIfAborted();
    return `its pnpm patches and Solana keypairs cannot be found to copy aside: ${error instanceof Error ? error.message : String(error)}`;
  }
  const bytes = found.reduce((sum, item) => sum + item.size, 0);
  if (bytes > RESCUE_CAP_BYTES)
    return `its pnpm patches and Solana keypairs hold over ${RESCUE_CAP_BYTES / 1024 / 1024} MB, more than cleanup copies aside`;
  if (!found.length || !act) return null;
  const dir = join(rescuedRoot(), workspaceId(root), new Date().toISOString().replace(/[:.]/g, '-'));
  try {
    const items: RescuedItem[] = [];
    for (const { source, size, link } of found) {
      const copy = join(dir, relative(root, source));
      await bounded(copy, async () => {
        await mkdir(dirname(copy), { recursive: true });
        await (link === null ? copyFile(source, copy, constants.COPYFILE_EXCL) : symlink(link, copy));
      });
      items.push({ source, copy, size, link });
    }
    const manifest = JSON.stringify({ from: root, at: Date.now(), items }, null, 2);
    await bounded(dir, () => writeFile(join(dir, 'manifest.json'), manifest));
  } catch (error) {
    signal?.throwIfAborted();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return `its pnpm patches and Solana keypairs could not be copied to ${dir}: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

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
