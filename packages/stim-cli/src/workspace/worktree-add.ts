import type { ChildProcess } from 'node:child_process';
import type { StimContext } from '@stim-cli/core';
import { isPathPrefix } from '@stim-cli/core/state';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { clonePairs, describeCloneFailure } from '../clone.ts';
import { runOperationFile } from '../engine/operation-exec.ts';
import { getExecutor } from '../exec.ts';
import { cloneAsCheckout, readCheckout } from './clone-as-checkout.ts';
import { fenceDeclaredSpawns } from '../engine/spawn-claims.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
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

/**
 * The reason the source checkout `root` cannot be cloned into a new worktree at `target`, or null when it can: its
 * index is one a copy would carry wrongly, or a clone of one tracked file beside `target` fails, with cow-clone's
 * reason.
 */
export async function cloneSource(root: string, target: string, operation: StimContext): Promise<string | null> {
  // Git for Windows takes a junction for a directory (compat/mingw.c file_attr_to_st_mode; entry.c remove_subtree
  // has no mount-point check), and a clone keeps each junction's target, which leads into the source checkout.
  // @ref LLP 0029#on-windows-only-the-warm-clones -- git never writes in a tree that holds cloned junctions
  if (process.platform === 'win32') return 'on Windows git would write through the junctions a clone keeps';
  // git 2.41 release notes: --attr-source, which reads .gitattributes from a commit, is new in that version.
  const [major = 0, minor = 0] = ((await gitAsync(root, ['version'], gitOptions(operation))).match(/\d+/g) ?? []).map(
    Number,
  );
  if (major < 2 || (major === 2 && minor < 41)) return 'cloning a checkout needs git 2.41 or later';
  const gitDir = (await gitAsync(root, ['rev-parse', '--absolute-git-dir'], gitOptions(operation))).trim();
  // gitformat-index(5): a split index keeps most entries in a sharedindex.<hash> file beside the index.
  if ((await readdir(gitDir)).some((name) => name.startsWith('sharedindex.')))
    return 'the source checkout uses a split index';
  const records = (await gitAsync(root, ['ls-files', '-v', '-z'], gitOptions(operation))).split('\0');
  // git-ls-files(1): -v prints a lowercase tag for assume-unchanged and S for skip-worktree. git reset --hard keeps
  // both bits, so a copied index would leave the source's hidden edits and sparse checkout in the new worktree.
  if (records.some((record) => /^[a-zS] /.test(record)))
    return 'the source checkout has files marked assume-unchanged or skip-worktree';
  let sample: string | undefined;
  for (const record of records) {
    const path = join(root, record.slice(2));
    const found = record ? await lstat(path).catch(() => null) : null;
    if (found?.isFile() && found.size > 0) {
      sample = path;
      break;
    }
  }
  if (!sample) return 'the source checkout has no tracked file to clone';
  let parent = dirname(target);
  while (!(await stat(parent).catch(() => null)) && dirname(parent) !== parent) parent = dirname(parent);
  const probe = join(parent, `.stim-clone-${randomUUID()}`);
  try {
    const [failure] = await clonePairs(operation, [[sample, probe]]);
    return failure ? describeCloneFailure(failure) : null;
  } finally {
    await rm(probe, { force: true }).catch(async (error: NodeJS.ErrnoException) => {
      if (process.platform !== 'darwin' || error.code !== 'EPERM') throw error;
      // chflags(1): clonefile(2) copies the uchg flag, and a file that has it cannot be removed until it is cleared.
      await runOperationFile(operation, getExecutor(), '/usr/bin/chflags', ['nouchg', probe], { timeoutMs: 10_000 });
      await rm(probe, { force: true });
    });
  }
}

/**
 * Fills `target`, a worktree made with `git worktree add --no-checkout`, from the source checkout `root`: one
 * clone per top-level entry, or per child where the entry holds a skipped directory, and one for the
 * index. Git then reads every tracked file to refresh that index, writes only the ones that differ from the target
 * commit and removes what is neither tracked nor ignored there. Submodule paths end empty, as `git worktree add`
 * leaves them.
 */
export async function cloneCheckout({
  root,
  target,
  skipped,
  operation,
}: {
  root: string;
  target: string;
  /** Directories of `root` the warm will not carry, which are never cloned: deleting a large one costs more than a checkout. */
  skipped: ReadonlySet<string>;
  operation: StimContext;
}): Promise<void> {
  const read = gitOptions(operation);
  const write = gitOptions(operation, true);
  const nested = await nestedWorktreePaths(root, {
    env: operation.env,
    signal: operation.signal,
    declareFor: operation,
  });
  const whole: string[] = [];
  const plan = async (rel: string): Promise<void> => {
    if (skipped.has(rel)) return;
    if (![...skipped].some((entry) => entry.startsWith(`${rel}/`))) return void whole.push(rel);
    await mkdir(join(target, rel));
    for (const name of await readdir(join(root, rel))) await plan(`${rel}/${name}`);
  };
  for (const name of await readdir(root))
    if (name !== '.git' && !overlapsNestedWorktree(name, nested)) await plan(name);
  const gitDir = async (dir: string) => (await gitAsync(dir, ['rev-parse', '--absolute-git-dir'], read)).trim();
  const index = join(await gitDir(target), 'index');
  await rm(index, { force: true });
  const [indexFailure] = await clonePairs(operation, [[join(await gitDir(root), 'index'), index]]);
  if (indexFailure) throw new Error(describeCloneFailure(indexFailure));
  // git check-attr reads the index, and ioctl(FICLONE) on Linux fills a destination that already exists, so the index
  // is cloned before the checkout reads start beside the other clones.
  // A claim records one declared child at a time; the fence keeps it pending while any of these overlapping ones runs.
  const fence = fenceDeclaredSpawns(operation);
  const [cloned, checkout] = await Promise.allSettled([
    clonePairs(
      operation,
      whole.map((rel) => [join(root, rel), join(target, rel)] as const),
    ),
    readCheckout(target, operation),
  ]);
  await fence.finish(
    [cloned, checkout]
      .flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      .find((reason) => reason instanceof Error && 'reportCleanup' in reason),
  );
  if (cloned.status === 'rejected') throw cloned.reason;
  const failure = cloned.value.find((result) => result !== null);
  if (failure) throw new Error(describeCloneFailure(failure));
  if (checkout.status === 'rejected') throw checkout.reason;
  // @ref LLP 0029#the-index-is-refreshed-before-the-reset -- reset rewrites every file whose stat data it cannot trust
  await cloneAsCheckout(target, checkout.value, operation);
  // git(1): --attr-source reads .gitattributes from that commit instead of the working tree, where the clone put the
  // source checkout's files, untracked ones included. git-config(1): under core.checkStat=minimal a clone matches
  // its source's entry by size and whole-second time, and git-update-index(1): the copied index's fsmonitor bitmap
  // marks files git then never reads.
  const asACheckout = ['--attr-source=HEAD', '-c', 'core.checkStat=default', '-c', 'core.fsmonitor=false'];
  await gitAsync(target, [...asACheckout, 'update-index', '-q', '--unmerged', '--refresh'], write);
  await gitAsync(target, [...asACheckout, '-c', 'submodule.recurse=false', 'reset', '-q', '--hard'], write);
  for (const record of (await gitAsync(target, ['ls-files', '--stage', '-z'], read)).split('\0')) {
    if (!record.startsWith('160000 ')) continue;
    const path = record.slice(record.indexOf('\t') + 1);
    await removeInside(target, path, operation.signal);
    await mkdir(join(target, path), { recursive: true });
  }
  // git-clean(1): only a second -f removes an untracked directory that holds a git repository.
  await gitAsync(target, ['clean', '-q', '-ffd'], write);
}

/** Passes what a git child prints on to the operation's stderr as it comes, as git shows a hook's output. */
export function showOutput(operation: StimContext): (child: ChildProcess) => void {
  return (child) => {
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk: Buffer) => operation.output('stderr', String(chunk)));
  };
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
    { ...gitOptions(operation, true), onSpawn: showOutput(operation) },
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
