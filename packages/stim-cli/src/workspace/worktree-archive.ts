import { randomUUID } from 'node:crypto';
import type { StimContext } from '@stim-cli/core';
import { quotedPath } from '@stim-cli/core';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { worktreeArchiveRoot } from '@stim-cli/core/state';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { enforceArchiveRetention, worktreeArchiveBytes, worktreeArchiveLimits } from '../archive.ts';
import { readVolumeSpaceAsync, resolveBudget } from '../budget.ts';
import { getExecutor, type ExecOptions } from '../exec.ts';
import { gitAsync, gitQuietAsync } from './git.ts';
import { childEnvironment } from './git-read.ts';

const WATCHMAN_COOKIE = /(?:^|\/)\.watchman-cookie-[^/]*$/;
const ARCHIVE_TIMEOUT_MS = 10 * 60_000;

export interface WorktreeArchive {
  dir: string;
  /** When the archive started; a change to an archived file after it means the archive is stale. */
  at: number;
  tracked: string[];
  untracked: string[];
  /** Shell commands that recreate the worktree at its HEAD with these changes. */
  restore: string[];
  bundled: boolean;
  /** Held until the removal that needs the archive ends; retention never deletes an archive with a live claim. */
  claim: ClaimHandle;
}

interface Changes {
  tracked: string[];
  untracked: string[];
}

function execution(
  operation?: StimContext,
): Pick<ExecOptions, 'env' | 'omitEnv' | 'signal' | 'declareFor' | 'killSignal'> {
  return {
    ...(operation ? childEnvironment(operation.env) : {}),
    signal: operation?.signal,
    declareFor: operation,
    killSignal: 'SIGKILL',
  };
}

function nulList(text: string): string[] {
  return text.split('\0').filter(Boolean);
}

async function changesOf(path: string, operation?: StimContext): Promise<Changes> {
  const read = { ...execution(operation), untrimmed: true, timeoutMs: 60_000 };
  const tracked = nulList(await gitAsync(path, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'], read));
  const untracked = nulList(
    await gitAsync(path, ['ls-files', '-z', '--others', '--exclude-standard', '--'], read),
  ).filter((file) => !WATCHMAN_COOKIE.test(file));
  return { tracked: tracked.toSorted(), untracked: untracked.toSorted() };
}

/**
 * Paths whose staged content differs from the working tree. `git diff HEAD` saves only the working tree, so a staged
 * version that the working tree no longer holds would be lost.
 */
async function stagedOnly(path: string, operation?: StimContext): Promise<string[]> {
  const read = { ...execution(operation), untrimmed: true, timeoutMs: 60_000 };
  const staged = new Set(
    nulList(await gitAsync(path, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--'], read)),
  );
  return nulList(await gitAsync(path, ['diff', '--name-only', '--no-renames', '-z', '--'], read)).filter((file) =>
    staged.has(file),
  );
}

async function headSizes(path: string, files: readonly string[], operation?: StimContext): Promise<number> {
  if (!files.length) return 0;
  if (files.some((file) => file.includes('\n'))) throw new Error('a changed path contains a newline');
  const out = await gitAsync(path, ['cat-file', '--batch-check=%(objectsize)'], {
    ...execution(operation),
    timeoutMs: 60_000,
    input: `${files.map((file) => `HEAD:${file}`).join('\n')}\n`,
  });
  return out.split('\n').reduce((sum, line) => sum + (/^\d+$/.test(line.trim()) ? Number(line.trim()) : 0), 0);
}

async function changedAt(file: string, deleted: 'skip' | 'parent'): Promise<number | null> {
  for (let current = file; ; current = dirname(current)) {
    try {
      const { mtimeMs, ctimeMs } = await lstat(current);
      return Math.max(mtimeMs, ctimeMs);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      if (deleted === 'skip' || dirname(current) === current) return null;
    }
  }
}

/** With `parent`, a deleted file counts its nearest existing parent directory's change, since unlinking changes it. */
async function newestChange(
  path: string,
  changes: Changes,
  deleted: 'skip' | 'parent' = 'skip',
): Promise<number | null> {
  let newest: number | null = null;
  for (const file of [...changes.tracked, ...changes.untracked]) {
    const changed = await changedAt(join(path, file), deleted);
    if (changed !== null && (newest === null || changed > newest)) newest = changed;
  }
  return newest;
}

/**
 * Plans a bundle of HEAD's commits that the default branch lacks, all of HEAD's history without `origin/HEAD`, so the
 * restore can recreate HEAD after its branch is deleted and git collects the commits; null when the default branch
 * already contains HEAD. `bytes` is their size on disk.
 */
async function headBundlePlan(
  path: string,
  head: string,
  operation?: StimContext,
): Promise<{ exclude: string[]; bytes: number } | null> {
  const run = { ...execution(operation), timeoutMs: ARCHIVE_TIMEOUT_MS };
  const base = (await gitQuietAsync(path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], run))?.trim();
  if (base && (await gitQuietAsync(path, ['merge-base', '--is-ancestor', head, base], run)) !== null) return null;
  const exclude = base ? [`^${base}`] : [];
  const bytes = Number(await gitAsync(path, ['rev-list', '--disk-usage', '--objects', 'HEAD', ...exclude], run));
  if (!Number.isFinite(bytes)) throw new Error('git did not report the size of the commits to bundle');
  return { exclude, bytes };
}

async function bundleHead(
  path: string,
  plan: { exclude: string[] },
  dir: string,
  operation?: StimContext,
): Promise<string> {
  const run = { ...execution(operation), timeoutMs: ARCHIVE_TIMEOUT_MS };
  const bundle = join(dir, 'head.bundle');
  await gitAsync(path, ['bundle', 'create', bundle, 'HEAD', ...plan.exclude], run);
  await chmod(bundle, 0o600);
  await gitAsync(path, ['bundle', 'verify', bundle], run);
  return bundle;
}

/**
 * When a worktree's uncommitted or untracked, non-ignored files last changed, a deleted file by its nearest existing
 * parent directory: null when it has none, and `unreadable` when git or the files cannot be read. git records no time
 * for these edits, so the idle checks read the files themselves.
 */
export async function uncommittedActivityOf(
  path: string,
  operation?: StimContext,
): Promise<{ at: number; basis: string } | null | 'unreadable'> {
  try {
    const at = await newestChange(path, await changesOf(path, operation), 'parent');
    return at === null ? null : { at, basis: 'an uncommitted file change' };
  } catch (error) {
    operation?.signal.throwIfAborted();
    if (error instanceof Error && 'reportCleanup' in error) throw error;
    return 'unreadable';
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'worktree';
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace('.', '-');
}

/**
 * Why the archive no longer describes the worktree, or null when it still does: the same changed and untracked files,
 * none modified since the archive started, and the patch still reverses cleanly against the working tree.
 */
export async function worktreeArchiveMismatch(
  path: string,
  archive: WorktreeArchive,
  operation?: StimContext,
): Promise<string | null> {
  if (archive.tracked.length) {
    try {
      await gitAsync(path, ['apply', '--check', '-R', join(archive.dir, 'tracked.patch')], {
        ...execution(operation),
        timeoutMs: ARCHIVE_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof Error && 'reportCleanup' in error) throw error;
      operation?.signal.throwIfAborted();
      return `the archived patch does not reverse against the worktree: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`;
    }
  }
  const staged = await stagedOnly(path, operation);
  if (staged.length) return `the staged content of ${staged.join(', ')} differs from its working tree`;
  const now = await changesOf(path, operation);
  if (!sameList(now.tracked, archive.tracked) || !sameList(now.untracked, archive.untracked)) {
    return 'its uncommitted or untracked files changed while they were archived';
  }
  const newest = await newestChange(path, now);
  if (newest !== null && newest >= archive.at) return 'an uncommitted file changed while it was archived';
  for (const file of [
    ...(archive.bundled ? ['head.bundle'] : []),
    ...(archive.tracked.length ? ['tracked.patch'] : []),
    ...(archive.untracked.length ? ['untracked.tar'] : []),
  ]) {
    if (!(await lstat(join(archive.dir, file)).catch(() => null))) return `its archive lost ${file}`;
  }
  return null;
}

/**
 * Saves a worktree's uncommitted work under `$STIM_HOME/archive/worktrees/<repository>/<branch-or-dir>-<timestamp>/`:
 * `tracked.patch` (`git diff --binary HEAD`, staged and unstaged changes together), `untracked.tar` (untracked files
 * git does not ignore) and `manifest.json` naming the branch, HEAD, pull request, files and restore commands. Ignored
 * files are not saved. Throws, leaving no archive, when archives are disabled or limited to 0, the files exceed
 * `archive.maxTotalGb` or the disk floor, an untracked nested repository is present, a staged version differs from
 * the working tree, or the written archive does not verify.
 */
export async function archiveWorktreeChanges({
  path,
  repository,
  branch,
  head,
  pullRequest,
  operation,
}: {
  path: string;
  repository: string;
  branch: string | null;
  head: string;
  pullRequest: { number: number; url: string; state: string } | null;
  operation?: StimContext;
}): Promise<WorktreeArchive> {
  const limits = worktreeArchiveLimits(path, operation?.env);
  if ('refusal' in limits) throw new Error(limits.refusal);
  const at = Date.now();
  const changes = await changesOf(path, operation);
  const nested = changes.untracked.find((file) => file.endsWith('/'));
  if (nested) throw new Error(`${nested} is an untracked nested repository`);
  const staged = await stagedOnly(path, operation);
  if (staged.length) throw new Error(`the staged content of ${staged.join(', ')} differs from its working tree`);
  if (!changes.tracked.length && !changes.untracked.length) throw new Error('git reported no change it could save');
  const retention = async (): Promise<void> => {
    try {
      await enforceArchiveRetention(undefined, operation);
    } catch (error) {
      if (error instanceof Error && 'reportCleanup' in error) throw error;
      operation?.signal.throwIfAborted();
    }
  };
  await retention();
  const existing = await worktreeArchiveBytes(operation?.signal);
  let bytes = 0;
  for (const file of changes.untracked) bytes += (await lstat(join(path, file))).size;
  let tracked = await headSizes(path, changes.tracked, operation);
  for (const file of changes.tracked) tracked += (await lstat(join(path, file)).catch(() => null))?.size ?? 0;
  const plan = await headBundlePlan(path, head, operation);
  if (existing + bytes + (plan?.bytes ?? 0) > limits.maxBytes) {
    throw new Error(
      `its untracked files and unmerged commits (${bytes + (plan?.bytes ?? 0)} bytes) do not fit in archive.maxTotalGb beside the other archives`,
    );
  }
  const [volume] = await readVolumeSpaceAsync([worktreeArchiveRoot()], operation?.signal);
  const floorMb = resolveBudget({ env: operation?.env }).budget.hardFloorDiskMb;
  const neededMb = (bytes + 2 * tracked + 2 * (plan?.bytes ?? 0)) / 1024 ** 2;
  if (!volume || volume.freeMb - neededMb < floorMb) {
    throw new Error(
      volume
        ? `writing it would leave less free disk than budget.hardFloorDiskGb on ${volume.volume}`
        : 'free disk for it could not be read',
    );
  }
  const dir = join(
    worktreeArchiveRoot(),
    safeName(basename(repository)),
    `${safeName(branch?.replace(/^refs\/heads\//, '') ?? basename(path))}-${stamp(at)}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  const attempt = tryAcquireClaim({ root: `${dir}.claims`, mode: 'exclusive', label: 'worktree archive' });
  const claim = attempt.acquired;
  if (!claim) {
    releaseClaim(attempt.pending);
    throw new Error('its archive claim is held');
  }
  let created = false;
  const restore = [`git -C ${quotedPath(repository)} worktree add --detach ${quotedPath(path)} ${head}`];
  try {
    await mkdir(dir, { mode: 0o700 });
    created = true;
    const bundle = plan ? await bundleHead(path, plan, dir, operation) : null;
    if (bundle) restore.unshift(`git -C ${quotedPath(repository)} bundle unbundle ${quotedPath(bundle)}`);
    if (changes.tracked.length) {
      const patch = join(dir, 'tracked.patch');
      await gitAsync(
        path,
        [
          'diff',
          '--binary',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--no-relative',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          `--output=${patch}`,
          'HEAD',
          '--',
        ],
        { ...execution(operation), timeoutMs: ARCHIVE_TIMEOUT_MS },
      );
      await chmod(patch, 0o600);
      restore.push(`git -C ${quotedPath(path)} apply ${quotedPath(patch)}`);
    }
    if (changes.untracked.length) {
      const tarball = join(dir, 'untracked.tar');
      const exec = { ...execution(operation), cwd: path, timeoutMs: ARCHIVE_TIMEOUT_MS };
      await getExecutor().runFileAsync('tar', ['-cf', tarball, '--null', '-T', '-'], {
        ...exec,
        input: `${changes.untracked.join('\0')}\0`,
      });
      await chmod(tarball, 0o600);
      const listed = (await getExecutor().runFileAsync('tar', ['-tf', tarball], { ...exec, untrimmed: true }))
        .split('\n')
        .filter(Boolean)
        .toSorted();
      if (!sameList(listed, changes.untracked)) throw new Error('the untracked tarball does not list every file');
      restore.push(`tar -xf ${quotedPath(tarball)} -C ${quotedPath(path)}`);
    }
    const archive: WorktreeArchive = { dir, at, ...changes, restore, bundled: bundle !== null, claim };
    const mismatch = await worktreeArchiveMismatch(path, archive, operation);
    if (mismatch) throw new Error(mismatch);
    const manifest = {
      version: 1,
      createdAt: new Date(at).toISOString(),
      worktree: path,
      repository,
      branch,
      head,
      pullRequest,
      headBundle: bundle ? 'head.bundle' : null,
      trackedPatch: changes.tracked.length ? 'tracked.patch' : null,
      untrackedTarball: changes.untracked.length ? 'untracked.tar' : null,
      tracked: changes.tracked,
      untracked: changes.untracked,
      restore,
    };
    const tmp = join(dir, '.manifest.json.tmp');
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, join(dir, 'manifest.json'));
    const total = await worktreeArchiveBytes(operation?.signal);
    if (total > limits.maxBytes) {
      throw new Error(
        `the archive (${total - existing} bytes) does not fit in archive.maxTotalGb beside the other archives`,
      );
    }
    const [after] = await readVolumeSpaceAsync([dir], operation?.signal);
    if (!after || after.freeMb < floorMb) {
      throw new Error(`it left less free disk than budget.hardFloorDiskGb on ${after?.volume ?? 'its volume'}`);
    }
    await retention();
    if (!(await lstat(join(dir, 'manifest.json')).catch(() => null))) throw new Error('archive retention removed it');
    return archive;
  } catch (error) {
    try {
      if (created) await rm(dir, { recursive: true, force: true });
    } finally {
      releaseClaim(claim);
    }
    throw error;
  }
}

/** Deletes an archive whose worktree was kept intact, so a retried removal does not pile up copies. */
export async function discardWorktreeArchive(archive: WorktreeArchive): Promise<void> {
  await rm(archive.dir, { recursive: true, force: true });
  releaseWorktreeArchive(archive);
}

/** Lets retention manage the archive once the removal that needed it has ended. */
export function releaseWorktreeArchive(archive: WorktreeArchive): void {
  releaseClaim(archive.claim);
}
