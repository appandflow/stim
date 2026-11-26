import type { StimContext } from '@stim-cli/core';
import { isPathPrefix } from '@stim-cli/core/state';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { clonefileHelper } from '../clonefile.ts';
import { runOperationFile } from '../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { getExecutor } from '../exec.ts';
import { removeTemporaryEntryAsync } from '../temporary.ts';
import { childEnvironment } from './git-read.ts';
import { gitAsync } from './git.ts';
import { nestedWorktreePaths, overlapsNestedWorktree } from './worktree.ts';

function gitOptions(operation: StimContext, write = false): NonNullable<Parameters<typeof gitAsync>[2]> {
  return {
    ...childEnvironment(operation.env),
    signal: operation.signal,
    declareFor: operation,
    timeoutMs: 'unbounded',
    untrimmed: true,
    write,
  };
}

/** An interruption or an unresolved child cleanup, which no fallback may swallow. */
export function endsOperation(error: unknown, operation: StimContext): boolean {
  return (
    operation.signal.aborted ||
    error instanceof WorkspaceProcessCleanupError ||
    (error instanceof Error && 'reportCleanup' in error)
  );
}

async function removeInside(target: string, rel: string, signal: AbortSignal): Promise<void> {
  const path = join(target, rel);
  const parent = await realpath(dirname(path)).catch(() => null);
  if (parent && isPathPrefix(target, parent)) await removeTemporaryEntryAsync(join(parent, basename(path)), signal);
}

/** The clone helper when `root` can be cloned into a new worktree at `target`, or the reason it cannot. */
export async function cloneSource(
  root: string,
  target: string,
  operation: StimContext,
): Promise<{ helper: string } | { reason: string }> {
  if (process.platform !== 'darwin') return { reason: 'cloning a checkout needs macOS' };
  let parent = dirname(target);
  while (!(await stat(parent).catch(() => null)) && dirname(parent) !== parent) parent = dirname(parent);
  if ((await stat(parent)).dev !== (await stat(root)).dev)
    return { reason: 'the new worktree is on another volume than the source checkout' };
  const helper = await clonefileHelper(operation);
  if (!helper) return { reason: 'the clone helper needs the Xcode Command Line Tools' };
  const records = (await gitAsync(root, ['ls-files', '-v', '-z'], gitOptions(operation))).split('\0');
  // git-ls-files(1): -v prints a lowercase tag for assume-unchanged and S for skip-worktree. git reset --hard keeps
  // both bits, so a copied index would leave the source's hidden edits and sparse checkout in the new worktree.
  if (records.some((record) => /^[a-zS] /.test(record)))
    return { reason: 'the source checkout has files marked assume-unchanged or skip-worktree' };
  return { helper };
}

/**
 * Fills `target`, a worktree made with `git worktree add --no-checkout`, from the source checkout `root`: one
 * clonefile(2) call per top-level entry and one for the index, then git writes only the tracked files that differ
 * from the target commit and removes what is neither tracked nor ignored there. Submodule paths end empty, as
 * `git worktree add` leaves them.
 */
export async function cloneCheckout({
  root,
  target,
  helper,
  operation,
}: {
  root: string;
  target: string;
  helper: string;
  operation: StimContext;
}): Promise<void> {
  const read = gitOptions(operation);
  const write = gitOptions(operation, true);
  const nested = await nestedWorktreePaths(root, {
    env: operation.env,
    signal: operation.signal,
    declareFor: operation,
  });
  const names = (await readdir(root)).filter((name) => name !== '.git' && !overlapsNestedWorktree(name, nested));
  const gitDir = async (dir: string) => (await gitAsync(dir, ['rev-parse', '--absolute-git-dir'], read)).trim();
  const index = join(await gitDir(target), 'index');
  await rm(index, { force: true });
  await runOperationFile(
    operation,
    getExecutor(),
    helper,
    [...names.flatMap((name) => [join(root, name), join(target, name)]), join(await gitDir(root), 'index'), index],
    { timeoutMs: 'unbounded', cwd: target },
  );
  // git-config(1): core.checkStat=minimal compares only size and whole-second mtime, which a clone keeps; the inode
  // and ctime it changes would otherwise make reset rewrite every tracked file. The cloned index keeps its own mtime,
  // so git still rereads a file changed in the second the source index was written.
  await gitAsync(
    target,
    ['-c', 'core.checkStat=minimal', '-c', 'submodule.recurse=false', 'reset', '-q', '--hard'],
    write,
  );
  for (const record of (await gitAsync(target, ['ls-files', '--stage', '-z'], read)).split('\0')) {
    if (!record.startsWith('160000 ')) continue;
    const path = record.slice(record.indexOf('\t') + 1);
    await removeInside(target, path, operation.signal);
    await mkdir(join(target, path), { recursive: true });
  }
  // git-clean(1): only a second -f removes an untracked directory that holds a git repository.
  await gitAsync(target, ['clean', '-q', '-ffd'], write);
}

/**
 * Runs `post-checkout` in the cloned worktree `target`, as `git worktree add` does after its checkout, and returns
 * the failure of a hook that fails.
 */
export async function runPostCheckout(target: string, head: string, operation: StimContext): Promise<string | null> {
  // git-worktree(1) runs post-checkout with the null object as the previous HEAD; --no-checkout skipped it.
  return gitAsync(
    target,
    ['hook', 'run', '--ignore-missing', 'post-checkout', '--', '0'.repeat(head.length), head, '1'],
    gitOptions(operation, true),
  ).then(
    () => null,
    (error: unknown) => {
      if (endsOperation(error, operation)) throw error;
      return error instanceof Error ? error.message : String(error);
    },
  );
}

/**
 * Removes every ignored entry of `target` outside `carried`, so a cloned worktree holds only what a warm carries.
 * @ref LLP 0029#the-result-equals-git-worktree-add-then-warm -- also after a warm that refused or was interrupted
 */
export async function pruneUncarried(
  target: string,
  carried: readonly string[],
  operation: StimContext,
  signal: AbortSignal,
): Promise<void> {
  const prune = async (rel: string): Promise<void> => {
    if (carried.some((kept) => rel === kept || rel.startsWith(`${kept}/`))) return;
    if (!carried.some((kept) => kept.startsWith(`${rel}/`))) return removeInside(target, rel, signal);
    for (const name of await readdir(join(target, rel))) await prune(`${rel}/${name}`);
  };
  const ignored = await gitAsync(
    target,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    { ...gitOptions(operation), signal },
  );
  for (const entry of ignored.split('\0').filter(Boolean)) await prune(entry.replace(/\/$/, ''));
}

/** Undoes a `git worktree add` this process ran: the worktree, its git directory and the branch that call created. */
export async function discardWorktree({
  cwd,
  target,
  gitDir,
  created,
  git,
}: {
  cwd: string;
  target: string;
  /** Empty when it is not known. */
  gitDir: string;
  created: { ref: string; sha: string } | null;
  /** Options for one git call, with a signal of its own: an interrupted operation still cleans up. */
  git: () => Parameters<typeof gitAsync>[2];
}): Promise<void> {
  await gitAsync(cwd, ['worktree', 'remove', '--force', '--', target], git()).catch(async () => {
    // git-worktree(1) refuses to remove a working tree that holds a submodule, which a cloned checkout can.
    await removeTemporaryEntryAsync(target);
    if (gitDir) await removeTemporaryEntryAsync(gitDir);
  });
  if (created) await gitAsync(cwd, ['update-ref', '-d', created.ref, created.sha], git());
}
