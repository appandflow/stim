import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { decideIdleStop } from '../policy/idle.ts';
import { ARTIFACT_DIRS, existingBuildDirsAsync } from './regenerable-dirs.ts';
import { discoveredEvidence, SKIPPED_WHERE_IGNORED } from './discovered-activity.ts';
import type { DiscoveredReads } from './discovered-reads.ts';
import { gitQuietAsync } from './git.ts';
import { hiddenEditHold } from './hidden-edits.ts';
import { checkDependencyEdits, dependencyEditsHold } from './dependency-edits.ts';
import { absent } from './scan-rules.ts';

const MAX_IGNORED_FILES = 200;
const MAX_COMPARED_BYTES = 16 * 1024 * 1024;

const outputNamed = (name: string) => name === 'node_modules' || SKIPPED_WHERE_IGNORED.has(name);

/** Whether `rel` is an `ios/Pods` folder, at the checkout root or below, as `apps/mobile/ios/Pods` in a monorepo. */
const podsFolder = (rel: string) => rel === 'ios/Pods' || rel.endsWith('/ios/Pods');

/** Whether `rel` is one of `folders`, checkout-relative, or lies inside one. */
const inFolder = (rel: string, folders: readonly string[]) =>
  folders.some((folder) => rel === folder || rel.startsWith(`${folder}/`));

/** Whether git reported the whole folder ignored and it is a dependency or build-output folder the stages recognise. */
const regenerableFolder = (rel: string, folders: readonly string[]) =>
  outputNamed(rel.split('/').at(-1) ?? '') || podsFolder(rel) || inFolder(rel, folders);

/** Whether the ignored entry `rel` is a `node_modules` that is a symbolic link, as some package managers and tools make. */
const linkedNodeModules = async (path: string, rel: string): Promise<boolean> =>
  rel.split('/').at(-1) === 'node_modules' &&
  ((await lstat(join(path, rel)).catch(() => null))?.isSymbolicLink() ?? false);

async function sameAsMain(path: string, main: string, rel: string, budget: { bytes: number }): Promise<boolean | null> {
  const mine = await lstat(join(path, rel));
  const theirs = await lstat(join(main, rel)).catch(() => null);
  if (!theirs) return false;
  if (mine.isSymbolicLink() || theirs.isSymbolicLink())
    return (
      mine.isSymbolicLink() &&
      theirs.isSymbolicLink() &&
      (await readlink(join(path, rel))) === (await readlink(join(main, rel)))
    );
  if (!mine.isFile() || !theirs.isFile() || mine.size !== theirs.size) return false;
  budget.bytes += mine.size;
  if (budget.bytes > MAX_COMPARED_BYTES) return null;
  return (await readFile(join(path, rel))).equals(await readFile(join(main, rel)));
}

/**
 * Why removing the worktree would lose a git-ignored file git cannot recover, or null: every ignored path outside the
 * regenerable folders (a directory git reports ignored whose name is node_modules or build output, or a folder the stages recognise) must exist, byte for byte, at the same place in the repository's main checkout. More than
 * MAX_IGNORED_FILES files, more than MAX_COMPARED_BYTES to compare, or anything unreadable keeps the worktree.
 */
export async function ignoredFilesHold(path: string, main: string, signal?: AbortSignal): Promise<string | null> {
  const listed = await gitQuietAsync(
    path,
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    {
      signal,
    },
  );
  if (listed === null) return 'git cannot list its ignored files';
  const folders = [
    ...ARTIFACT_DIRS.dependencies.filter((folder) => !podsFolder(folder)),
    ...(await existingBuildDirsAsync(path)).map((dir) => relative(path, dir)),
  ];
  const budget = { bytes: 0 };
  let files = 0;
  const unreadable = 'its ignored files cannot be compared with the main checkout';
  const check = async (rel: string): Promise<string | null> => {
    signal?.throwIfAborted();
    if (++files > MAX_IGNORED_FILES)
      return `it has more than ${MAX_IGNORED_FILES} git-ignored files to compare with the main checkout`;
    try {
      const same = await sameAsMain(path, main, rel, budget);
      if (same === null)
        return `its git-ignored files are over ${MAX_COMPARED_BYTES / 1024 / 1024} MB to compare with the main checkout`;
      return same ? null : `its git-ignored file ${rel} is not in the main checkout, or differs`;
    } catch {
      signal?.throwIfAborted();
      return unreadable;
    }
  };
  const walk = async (rel: string): Promise<string | null> => {
    let names: string[];
    try {
      names = await readdir(join(path, rel));
    } catch {
      signal?.throwIfAborted();
      return unreadable;
    }
    for (const name of names) {
      signal?.throwIfAborted();
      const child = join(rel, name);
      const stat = await lstat(join(path, child)).catch(() => null);
      if (!stat) return unreadable;
      const directory = stat.isDirectory() && !stat.isSymbolicLink();
      if (directory && podsFolder(child)) {
        // @ref LLP 0002#edits-inside-dependency-folders -- git lists only the ignored parent, so check the Pods here
        const edits = await checkDependencyEdits(join(path, child), {
          level: 'high',
          worktree: path,
          readOnly: true,
          signal,
        });
        if ('keep' in edits) return `its ${child}: ${edits.keep}`;
        continue;
      }
      if (directory && regenerableFolder(child, folders)) continue;
      if (stat.isSymbolicLink() && name === 'node_modules') continue;
      const hold = directory ? await walk(child) : await check(child);
      if (hold) return hold;
    }
    return null;
  };
  for (const entry of listed.split('\0').filter(Boolean)) {
    const rel = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (
      entry.endsWith('/')
        ? regenerableFolder(rel, folders)
        : inFolder(dirname(rel), folders) || (await linkedNodeModules(path, rel))
    )
      continue;
    const hold = entry.endsWith('/') ? await walk(rel) : await check(rel);
    if (hold) return hold;
  }
  return null;
}

/** The nearest folder above `path` that holds a `.git` entry, or null; a level that cannot be read throws. */
async function enclosingCheckout(path: string): Promise<string | null> {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir))
    try {
      await lstat(join(dir, '.git'));
      return dir;
    } catch (error) {
      if (!absent(error)) throw error;
    }
  return null;
}

// @ref LLP 0004#removing-a-discovered-worktree-needs-more-evidence -- no Stim record of its files
/**
 * What stops Stim removing a discovered linked worktree, or null: it must have had no activity for `idleMs` by the full
 * evidence (source writes including git-ignored files, last commit, git writes, a completed scan), nothing running from
 * it and no agent session in it, and no git-ignored file that the main checkout lacks. It holds at every pressure level.
 */
export async function discoveredRemovalHold(
  path: string,
  {
    main,
    idleMs,
    reads,
    reduceOnly,
    operation,
  }: { main: string | null; idleMs: number; reads: DiscoveredReads; reduceOnly: boolean; operation?: StimContext },
): Promise<string | null> {
  if (reduceOnly)
    return 'it was found in a tool folder or by the full scan, so Stim reduces its outputs and never removes it';
  let owner: string | null;
  try {
    owner = await enclosingCheckout(path);
  } catch {
    return 'the checkout that holds it cannot be read';
  }
  const toolFolder = (checkout: string | null) =>
    checkout && (path === checkout || path.startsWith(`${checkout}${sep}`))
      ? relative(checkout, path)
          .split(sep)
          .find((name) => name.startsWith('.') && name !== '.worktrees')
      : undefined;
  const inOwner = toolFolder(owner);
  const folder = inOwner ?? toolFolder(main);
  if (folder)
    return `it is managed by another tool (inside ${folder} of ${inOwner && owner !== main ? owner : 'its main checkout'})`;
  if (!(idleMs > 0)) return 'idle.dormantDays is 0, so its idleness cannot be established';
  const now = Date.now();
  const decision = decideIdleStop(await discoveredEvidence(path, { now, idleMs, reads, operation }), {
    idleMs,
    now,
    setting: 'idle.dormantDays',
  });
  if (!decision.stop) return decision.reason;
  if (!main) return 'its main checkout is unknown, so its git-ignored files cannot be compared';
  return (
    (await hiddenEditHold(path, operation?.signal)) ??
    (await ignoredFilesHold(path, main, operation?.signal)) ??
    (await dependencyEditsHold(path, operation?.signal))
  );
}
