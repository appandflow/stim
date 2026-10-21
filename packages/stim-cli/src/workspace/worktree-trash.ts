import { lstat, mkdir, mkdtemp, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { captureProcessIdentity } from '@stim-cli/core/process-identity';
import { trashRoot } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import {
  clearClaimChild,
  markClaimChildPending,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '../ownership-claim.ts';
import { filesystemDevice } from '../temporary.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { gitAsync } from './git.ts';
import { childEnvironment } from './git-read.ts';

export const TRASH_MANIFEST = 'trash.json';
export const TRASH_ENTRIES = 'entries';
export const TRASH_CLAIMS = 'claims';
const LIST_TIMEOUT_MS = 30_000;
const DELETE_NICENESS = '10';

export interface TrashManifest {
  worktree: string;
  createdAt: string;
}

export interface WorktreeTrash {
  dir: string;
  worktree: string;
  moved: { from: string; to: string }[];
  claim: ClaimHandle;
}

interface TrashOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  declareFor?: StimContext;
  platform?: NodeJS.Platform;
}

function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
    throw error;
  signal?.throwIfAborted();
}

async function isPlainDirectory(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function ignoredDirectories(worktree: string, options: TrashOptions): Promise<string[]> {
  const out = await gitAsync(
    worktree,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z'],
    {
      ...(options.env ? childEnvironment(options.env) : {}),
      signal: options.signal,
      declareFor: options.declareFor,
      timeoutMs: LIST_TIMEOUT_MS,
      untrimmed: true,
    },
  );
  const found: string[] = [];
  for (const entry of out.split('\0')) {
    if (!entry.endsWith('/')) continue;
    const rel = entry.slice(0, -1);
    const parts = rel.split('/');
    let plain = true;
    for (let depth = 1; depth <= parts.length && plain; depth++) {
      plain = await isPlainDirectory(join(worktree, ...parts.slice(0, depth)));
    }
    if (plain) found.push(rel);
  }
  return found;
}

/**
 * Moves the worktree's ignored directories, which `git worktree remove` would delete, into a new entry under
 * `$STIM_HOME/trash` held by an exclusive ownership claim. Null, with nothing moved, when the trash is on another
 * filesystem, the platform is Windows, git cannot list the entries, or the claim cannot be taken. A directory that
 * does not rename stays in the worktree for git to delete.
 */
export async function moveIgnoredTreesToTrash(
  worktree: string,
  options: TrashOptions = {},
): Promise<WorktreeTrash | null> {
  if ((options.platform ?? process.platform) === 'win32') return null;
  let listed: string[];
  try {
    listed = await ignoredDirectories(worktree, options);
  } catch (error) {
    rethrowCancellation(error, options.signal);
    return null;
  }
  if (!listed.length) return null;
  const root = trashRoot();
  let dir: string | null = null;
  let claim: ClaimHandle | null = null;
  const entries = listed.map((from, index) => ({ from, to: String(index) }));
  try {
    await mkdir(root, { recursive: true });
    if (filesystemDevice(root) !== filesystemDevice(worktree)) return null;
    dir = await mkdtemp(join(root, 'remove-'));
    claim =
      tryAcquireClaim({ root: join(dir, TRASH_CLAIMS), mode: 'exclusive', label: 'worktree trash' }).acquired ?? null;
    if (!claim) throw new Error('the trash entry claim was not acquired');
    const manifest: TrashManifest = { worktree, createdAt: new Date().toISOString() };
    await writeFile(join(dir, TRASH_MANIFEST), `${JSON.stringify(manifest)}\n`);
    await mkdir(join(dir, TRASH_ENTRIES));
  } catch (error) {
    if (claim) releaseClaim(claim);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    rethrowCancellation(error, options.signal);
    return null;
  }
  const moved: WorktreeTrash['moved'] = [];
  for (const entry of entries) {
    try {
      await rename(join(worktree, entry.from), join(dir, TRASH_ENTRIES, entry.to));
      moved.push(entry);
    } catch {}
  }
  const trash = { dir, worktree, moved, claim };
  if (moved.length) return trash;
  await discardTrash(trash);
  return null;
}

async function discardTrash(trash: WorktreeTrash): Promise<void> {
  await rmdir(join(trash.dir, TRASH_ENTRIES)).catch(() => {});
  await rm(join(trash.dir, TRASH_MANIFEST), { force: true }).catch(() => {});
  releaseClaim(trash.claim);
  await rmdir(trash.dir).catch(() => {});
}

/** Moves every tree back into the worktree. Returns the relative paths that stay in the trash for gc. */
export async function restoreTrashedTrees(trash: WorktreeTrash): Promise<string[]> {
  const kept: string[] = [];
  for (const entry of trash.moved.toReversed()) {
    const target = join(trash.worktree, entry.from);
    try {
      if ((await lstat(target).catch(() => null)) || !(await isPlainDirectory(dirname(target)))) {
        kept.push(entry.from);
        continue;
      }
      await rename(join(trash.dir, TRASH_ENTRIES, entry.to), target);
    } catch {
      kept.push(entry.from);
    }
  }
  if (kept.length) releaseClaim(trash.claim);
  else await discardTrash(trash);
  return kept;
}

/**
 * Deletes the trash entry in a detached, low-priority `rm` recorded as the claim's child, so gc reports the entry as
 * in use until `rm` exits and then deletes whatever it left. False when `rm` cannot start or be recorded: the claim
 * is then released and the entry waits for gc.
 */
export function deleteTrashInBackground(trash: WorktreeTrash): boolean {
  try {
    markClaimChildPending(trash.claim);
    const child = getExecutor().spawn(
      'nice',
      ['-n', DELETE_NICENESS, 'rm', '-rf', '--', join(trash.dir, TRASH_ENTRIES), trash.dir],
      { detached: true, stdio: 'ignore' },
    );
    child.on?.('error', () => {});
    child.unref?.();
    const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
    if (!captured?.ok || child.pid === undefined) throw new Error('the trash deletion process was not recorded');
    setClaimChild(trash.claim, { pid: child.pid, processToken: captured.token });
    return true;
  } catch {
    try {
      clearClaimChild(trash.claim);
    } catch {}
    releaseClaim(trash.claim);
    return false;
  }
}
