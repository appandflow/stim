import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { captureProcessIdentity, childExitedWithin } from '@stim-cli/core/process-identity';
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
import { openDeleteSession, type DeleteSession } from '../delete-child.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { gitAsync } from './git.ts';
import { childEnvironment } from './git-read.ts';

export const TRASH_MANIFEST = 'trash.json';
export const TRASH_ENTRY_PREFIX = 'remove-';
const TRASH_ENTRIES = 'entries';
export const TRASH_CLAIMS = 'claims';
const LIST_TIMEOUT_MS = 30_000;
const DELETE_NICENESS = '10';

export interface TrashManifest {
  worktree: string;
  createdAt: string;
  kind?: 'warm';
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

async function openTrash(
  worktree: string,
  options: TrashOptions,
  kind?: TrashManifest['kind'],
): Promise<WorktreeTrash | null> {
  if ((options.platform ?? process.platform) === 'win32') return null;
  const root = trashRoot();
  let dir: string | null = null;
  let claim: ClaimHandle | null = null;
  try {
    await mkdir(root, { recursive: true });
    if (filesystemDevice(root) !== filesystemDevice(worktree)) return null;
    dir = await mkdtemp(join(root, TRASH_ENTRY_PREFIX));
    claim =
      tryAcquireClaim({ root: join(dir, TRASH_CLAIMS), mode: 'exclusive', label: 'worktree trash' }).acquired ?? null;
    if (!claim) throw new Error('the trash entry claim was not acquired');
    const manifest: TrashManifest = { worktree, createdAt: new Date().toISOString(), ...(kind ? { kind } : {}) };
    await writeFile(join(dir, TRASH_MANIFEST), `${JSON.stringify(manifest)}\n`);
    await mkdir(join(dir, TRASH_ENTRIES));
  } catch (error) {
    if (claim) releaseClaim(claim);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    rethrowCancellation(error, options.signal);
    return null;
  }
  return { dir, worktree, moved: [], claim };
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
  const trash = await openTrash(worktree, options);
  if (!trash) return null;
  for (const from of listed) {
    const to = String(trash.moved.length);
    try {
      await rename(join(worktree, from), join(trash.dir, TRASH_ENTRIES, to));
      trash.moved.push({ from, to });
    } catch {}
  }
  if (trash.moved.length) return trash;
  await discardTrash(trash);
  return null;
}

/**
 * A trash entry that takes directories out of a live worktree while it warms, so the delete runs in the background.
 * `take` is false, with the directory untouched, when the entry cannot be opened or the rename fails; the caller
 * deletes it in place. gc deletes a crashed entry whatever the state of the worktree.
 */
export function warmTrash(worktree: string, options: TrashOptions = {}) {
  let trash: WorktreeTrash | null | undefined;
  return {
    async take(path: string): Promise<boolean> {
      if (trash === undefined) trash = await openTrash(worktree, options, 'warm');
      if (!trash) return false;
      const to = String(trash.moved.length);
      try {
        await rename(path, join(trash.dir, TRASH_ENTRIES, to));
      } catch {
        return false;
      }
      trash.moved.push({ from: path, to });
      return true;
    },
    async dispose(operation?: StimContext): Promise<void> {
      if (!trash) return;
      if (trash.moved.length) await disposeTrash(trash, operation);
      else await discardTrash(trash);
    },
  };
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
 * Deletes one trash entry through `session` while `claim` holds it, each step leaving a state gc finishes: everything but
 * the claims and the manifest, then the manifest, then the claim, then the emptied entry. Only `dev`, the trash root's
 * device, is deleted from. Throws, with the claim still held, when a step fails.
 */
export async function deleteTrashEntry(
  dir: string,
  claim: ClaimHandle,
  session: DeleteSession,
  options: { dev: number; signal?: AbortSignal },
): Promise<void> {
  for (const name of await readdir(dir)) {
    if (name === TRASH_CLAIMS || name === TRASH_MANIFEST) continue;
    const outcome = await session.rm(join(dir, name), claim, options);
    if ('cancelled' in outcome) options.signal?.throwIfAborted();
    if ('done' in outcome && !outcome.done.left.length) continue;
    throw new Error(
      'kept' in outcome
        ? outcome.kept
        : 'failed' in outcome
          ? outcome.failed.message
          : 'done' in outcome
            ? `${outcome.done.left[0]} is on another device or was filled again`
            : 'the delete was cancelled',
    );
  }
  await unlink(join(dir, TRASH_MANIFEST)).catch(ignoreMissing);
  releaseClaim(claim);
  await rmdir(dir).catch((error: unknown) => {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  });
}

function ignoreMissing(error: unknown): void {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

async function deleteInBackground(trash: WorktreeTrash): Promise<'background' | 'deleted' | 'left'> {
  try {
    markClaimChildPending(trash.claim);
    const child = getExecutor().spawn(
      'nice',
      [
        '-n',
        DELETE_NICENESS,
        'sh',
        '-c',
        'rm -rf -- "$1" && rm -rf -- "$2"',
        '--',
        join(trash.dir, TRASH_ENTRIES),
        trash.dir,
      ],
      { cwd: dirname(trash.dir), detached: true, stdio: 'ignore' },
    );
    child.on?.('error', () => {});
    child.unref?.();
    const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
    if (captured?.ok === false && captured.code === 'NOT_FOUND') {
      const release = () => {
        clearClaimChild(trash.claim);
        releaseClaim(trash.claim);
      };
      if (!(await childExitedWithin(child))) {
        const again = child.pid === undefined ? null : captureProcessIdentity(child.pid);
        if (again?.ok && child.pid !== undefined) {
          setClaimChild(trash.claim, { pid: child.pid, processToken: again.token });
          return 'background';
        }
        if (child.exitCode === null && child.signalCode === null) return 'background';
      }
      release();
      return existsSync(trash.dir) ? 'left' : 'deleted';
    }
    if (!captured?.ok || child.pid === undefined) throw new Error('the trash deletion process was not recorded');
    setClaimChild(trash.claim, { pid: child.pid, processToken: captured.token });
    return 'background';
  } catch {
    try {
      clearClaimChild(trash.claim);
    } catch {}
    releaseClaim(trash.claim);
    return 'left';
  }
}

/**
 * Deletes the trash entry once its trees are out of the way. A CLI command starts a detached, low-priority `rm` recorded
 * as the claim's child, so gc reports the entry as in use until `rm` exits. Inside a bounded report, such as the
 * programmatic API, every child is stopped when the report settles, so the entry is deleted before returning.
 * `left` means the entry waits for gc with its claim released.
 */
export async function disposeTrash(
  trash: WorktreeTrash,
  operation?: StimContext,
): Promise<'background' | 'deleted' | 'left'> {
  if (!getExecutor().reportSignal?.()) return deleteInBackground(trash);
  let session: DeleteSession | undefined;
  let retained = false;
  try {
    const { dev } = await lstat(trashRoot());
    session = await openDeleteSession(operation?.signal);
    await deleteTrashEntry(trash.dir, trash.claim, session, { dev, signal: operation?.signal });
    return 'deleted';
  } catch (error) {
    retained = error instanceof WorkspaceProcessCleanupError;
    rethrowCancellation(error, operation?.signal);
    return 'left';
  } finally {
    await session?.close();
    if (!retained) releaseClaim(trash.claim);
  }
}
