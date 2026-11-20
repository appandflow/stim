import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
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
import { LINUX_MOUNT_INFO, mountedUnder } from './remover.ts';
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
 * Why the trash entry `dir` must not be deleted from: it is not on `dev`, the trash's device, or on Linux a mount point
 * lies at or under it. Null when neither holds. Checked before the entry's claim is taken, since taking it writes there.
 */
export function trashEntryMisplaced(dir: string, dev: number): string | null {
  let real: string;
  try {
    real = realpathSync(dir);
    if (lstatSync(real).dev !== dev) return `${dir} is not on the volume of the trash`;
  } catch (error) {
    return `${dir} cannot be checked: ${error instanceof Error ? error.message : String(error)}`;
  }
  // @ref LLP 0007#a-delete-child-holds-the-claim-of-the-tree-it-deletes -- never into a bind mount
  return mountedUnder(real, LINUX_MOUNT_INFO);
}

/**
 * Deletes one trash entry through `session` while `claim` holds it, each step leaving a state gc finishes: everything but
 * the claims and the manifest, then the manifest, then the claim, then the emptied entry. Only `dev`, the trash's
 * device, is deleted from. Returns once the entry is gone; throws, with the claim still held until the manifest is gone,
 * when a step fails.
 */
export async function deleteTrashEntry(
  dir: string,
  claim: ClaimHandle,
  session: DeleteSession,
  options: { dev: number; signal?: AbortSignal },
): Promise<void> {
  for (const raw of await readdir(dir, { encoding: 'buffer' })) {
    let name = raw.toString();
    if (name === TRASH_CLAIMS || name === TRASH_MANIFEST) continue;
    if (!Buffer.from(name).equals(raw)) {
      const ascii = `.stim-delete-${randomUUID()}`;
      await rename(Buffer.concat([Buffer.from(`${dir}${sep}`), raw]), join(dir, ascii));
      name = ascii;
    }
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
  const left = (await readdir(dir)).filter((name) => name !== TRASH_CLAIMS && name !== TRASH_MANIFEST);
  if (left.length) throw new Error(`${join(dir, left[0] ?? '')} is still in the entry`);
  await unlink(join(dir, TRASH_MANIFEST)).catch(ignoreMissing);
  await removeClaimStaging(join(dir, TRASH_CLAIMS), options.dev);
  releaseClaim(claim);
  try {
    await rmdir(join(dir, TRASH_CLAIMS));
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : String(error);
    const why = code === 'ENOTEMPTY' || code === 'EEXIST' ? 'it holds files Stim did not write' : code;
    if (code !== 'ENOENT')
      throw new Error(`${join(dir, TRASH_CLAIMS)} could not be removed (${why}), so the entry stays`, { cause: error });
  }
  await rmdir(dir).catch(ignoreMissing);
}

const CLAIM_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STAGED_FILE = new RegExp(`^\\.staging-(?:(?:child|details)-)?${CLAIM_ID}$`);
const STAGED_DIRECTORY = new RegExp(`^\\.staging-(${CLAIM_ID})$`);

const CLAIM_RECORD = new RegExp(`^${CLAIM_ID}\\.(?:claim|child)$`);

const claimRootEntry = (entry: Dirent) =>
  ((entry.name === 'exclusive' || entry.name === 'shared') && entry.isDirectory()) ||
  (STAGED_FILE.test(entry.name) && entry.isFile()) ||
  (STAGED_DIRECTORY.test(entry.name) && entry.isDirectory());

const claimRecord = (entry: Dirent) => CLAIM_RECORD.test(entry.name) && entry.isFile();

/**
 * Why the claim set `root` of a trash entry must not be touched, or null. `root`, `exclusive/` and `shared/`, where they
 * exist, must be real directories on `dev`, the trash's device; with `strict`, for an entry without a manifest, they must
 * also hold only the files and directories the claim code writes. Taking a claim reaps dead records in them, so this runs
 * before it.
 */
export function claimSetKept(root: string, dev: number, strict: boolean): string | null {
  const levels: [string, (entry: Dirent) => boolean][] = [
    [root, claimRootEntry],
    [join(root, 'exclusive'), claimRecord],
    [join(root, 'shared'), claimRecord],
  ];
  for (const [dir, written] of levels) {
    try {
      const stat = lstatSync(dir, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isDirectory() || stat.dev !== dev) return `${dir} is not a directory on the volume of the trash`;
      if (!strict) continue;
      const foreign = readdirSync(dir, { withFileTypes: true }).find((entry) => !written(entry));
      if (foreign) return `${join(dir, foreign.name)} is not a file Stim's claims write`;
    } catch (error) {
      return `${dir} cannot be checked: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return null;
}

/**
 * Removes, from the claim set `root` on device `dev`, the staging files a claim writer left when it crashed: in the shapes
 * `@stim-cli/core/ownership-claim` writes them, without recursing, so anything else stays.
 */
async function removeClaimStaging(root: string, dev: number): Promise<void> {
  for (const name of await readdir(root).catch(() => [])) {
    const path = join(root, name);
    const stat = await lstat(path).catch(() => null);
    if (!stat || stat.dev !== dev) continue;
    if (stat.isFile() && STAGED_FILE.test(name)) await unlink(path).catch(ignoreMissing);
    const id = STAGED_DIRECTORY.exec(name)?.[1];
    if (!stat.isDirectory() || !id) continue;
    const inside = await readdir(path).catch(() => null);
    if (!inside || inside.some((entry) => entry !== `${id}.claim`)) continue;
    if (inside.length) {
      const claimFile = await lstat(join(path, `${id}.claim`)).catch(() => null);
      if (!claimFile?.isFile() || claimFile.dev !== dev) continue;
      await unlink(join(path, `${id}.claim`)).catch(ignoreMissing);
    }
    await rmdir(path).catch(ignoreMissing);
  }
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
    const dev = filesystemDevice(trashRoot());
    const misplaced = trashEntryMisplaced(trash.dir, dev);
    if (misplaced) throw new Error(misplaced);
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
