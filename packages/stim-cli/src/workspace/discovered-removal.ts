import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { decideIdleStop } from '../policy/idle.ts';
import { ARTIFACT_DIRS, existingBuildDirsAsync } from './regenerable-dirs.ts';
import { discoveredEvidence, SKIPPED_WHERE_IGNORED } from './discovered-activity.ts';
import type { DiscoveredReads } from './discovered-reads.ts';
import { gitQuietAsync } from './git.ts';
import { hiddenEditHold } from './hidden-edits.ts';
import { dependencyEditsHold } from './dependency-edits.ts';

const MAX_IGNORED_FILES = 200;
const MAX_COMPARED_BYTES = 16 * 1024 * 1024;

const outputNamed = (name: string) => name === 'node_modules' || SKIPPED_WHERE_IGNORED.has(name);

/** Whether git reported the whole folder ignored and it is a dependency or build-output folder the stages recognise. */
const regenerableFolder = (rel: string, folders: readonly string[]) =>
  outputNamed(rel.split('/').at(-1) ?? '') || folders.some((folder) => rel === folder || rel.startsWith(`${folder}/`));

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
async function ignoredFilesHold(path: string, main: string, signal?: AbortSignal): Promise<string | null> {
  const listed = await gitQuietAsync(
    path,
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    {
      signal,
    },
  );
  if (listed === null) return 'git cannot list its ignored files';
  const folders = [
    ...ARTIFACT_DIRS.dependencies,
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
      if (directory && regenerableFolder(child, folders)) continue;
      const hold = directory ? await walk(child) : await check(child);
      if (hold) return hold;
    }
    return null;
  };
  for (const entry of listed.split('\0').filter(Boolean)) {
    const rel = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    if (entry.endsWith('/') ? regenerableFolder(rel, folders) : folders.some((folder) => rel.startsWith(`${folder}/`)))
      continue;
    const hold = entry.endsWith('/') ? await walk(rel) : await check(rel);
    if (hold) return hold;
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
    operation,
  }: { main: string | null; idleMs: number; reads: DiscoveredReads; operation?: StimContext },
): Promise<string | null> {
  const folder = main ? relative(main, path).split('/')[0] : undefined;
  if (folder?.startsWith('.') && folder !== '.worktrees' && !folder.startsWith('..'))
    return `it is managed by another tool (inside ${folder} of its main checkout)`;
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
