import type { ChildProcess } from 'node:child_process';
import type { StimContext } from '@stim-cli/core';
import { isPathPrefix } from '@stim-cli/core/state';
import { lstatSync } from 'node:fs';
import { mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { clonefileHelper } from '../clonefile.ts';
import { runOperationFile } from '../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { getExecutor } from '../exec.ts';
import { removeTemporaryEntryAsync } from '../temporary.ts';
import { cloneStat, readIndex, writeIndex } from './git-index.ts';
import type { FileStat } from './git-index.ts';
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

const CLONES_PER_CALL = 256;

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
  const gitDir = (await gitAsync(root, ['rev-parse', '--absolute-git-dir'], gitOptions(operation))).trim();
  // gitformat-index(5): a split index keeps most entries in a sharedindex.<hash> file beside the index.
  if ((await readdir(gitDir)).some((name) => name.startsWith('sharedindex.')))
    return { reason: 'the source checkout uses a split index' };
  const records = (await gitAsync(root, ['ls-files', '-v', '-z'], gitOptions(operation))).split('\0');
  // git-ls-files(1): -v prints a lowercase tag for assume-unchanged and S for skip-worktree. git reset --hard keeps
  // both bits, so a copied index would leave the source's hidden edits and sparse checkout in the new worktree.
  if (records.some((record) => /^[a-zS] /.test(record)))
    return { reason: 'the source checkout has files marked assume-unchanged or skip-worktree' };
  return { helper };
}

function look(base: string, path: Buffer): FileStat | null {
  try {
    return lstatSync(Buffer.concat([Buffer.from(`${base}/`), path]), { bigint: true, throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

/**
 * The index for `target`, whose files are clones of the source checkout `root`, from `bytes`, the source's index as
 * it was before the clone: an entry whose source file is unchanged gets its clone's stat data, and every other
 * entry is left for git to read, `unproven` of them outside submodules. Null when the index is in a format this does not write.
 * @ref LLP 0029#the-copied-index-gets-the-clones-stat-data -- only what the source checkout proves is trusted
 */
function clonedIndex(
  bytes: Buffer,
  mtimeSec: number,
  root: string,
  target: string,
): { bytes: Buffer; unproven: number } | null {
  const index = readIndex(bytes);
  if (!index) return null;
  // gitformat-index(5): an extension whose signature does not start with A to Z is one a reader must understand.
  // "link" is the split index, whose entries live in a second file, and "sdir" the sparse index.
  const required = index.extensions.map(({ signature }) => signature).filter((signature) => !/^[A-Z]/.test(signature));
  if (
    required.some((signature) => signature === 'link' || signature === 'sdir') ||
    index.entries.some((entry) => entry.assumeUnchanged || entry.skipWorktree)
  )
    throw new Error('the source index changed to one that cannot be copied');
  if (required.length) return null;
  const directories = new Map<string, boolean>();
  // git checks a tracked path with has_symlink_leading_path when it refreshes, but reset --hard only calls lstat,
  // which follows a symbolic link that replaced a parent directory to a file that still matches.
  const realDirectory = (path: Buffer): boolean => {
    const slash = path.lastIndexOf(0x2f);
    if (slash < 0) return true;
    const parent = path.subarray(0, slash);
    const key = parent.toString('latin1');
    let real = directories.get(key);
    if (real === undefined) {
      real =
        realDirectory(parent) &&
        [root, target].every((base) => ((look(base, parent)?.mode ?? 0n) & 0o170000n) === 0o040000n);
      directories.set(key, real);
    }
    return real;
  };
  let unproven = 0;
  const stats = index.entries.map((entry) => {
    const proven = realDirectory(entry.path)
      ? cloneStat(entry, look(root, entry.path), look(target, entry.path), mtimeSec)
      : null;
    if (!proven && (entry.mode & 0o170000) !== 0o160000) unproven += 1;
    return proven;
  });
  // The untracked cache, the fsmonitor bitmap and the entry offset tables describe the source's worktree or bytes.
  return { bytes: writeIndex(bytes, index, stats, (signature) => ['TREE', 'REUC'].includes(signature)), unproven };
}

/**
 * Fills `target`, a worktree made with `git worktree add --no-checkout`, from the source checkout `root`: one
 * clonefile(2) call per top-level entry, or per child where the entry holds a skipped directory. The source's index
 * is copied with the clones' stat data, so git reads only the files the source had changed, writes the ones that
 * differ from the target commit and removes what is neither tracked nor ignored there. Submodule paths end empty,
 * as `git worktree add` leaves them.
 */
export async function cloneCheckout({
  root,
  target,
  helper,
  skipped,
  operation,
}: {
  root: string;
  target: string;
  helper: string;
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
  const format = (await gitAsync(root, ['rev-parse', '--show-object-format'], read)).trim();
  const handle = await open(join(await gitDir(root), 'index'), 'r');
  let source: Buffer;
  let sourceMtimeSec: number;
  try {
    sourceMtimeSec = Number((await handle.stat({ bigint: true })).mtimeNs / 1_000_000_000n);
    source = await handle.readFile();
  } finally {
    await handle.close();
  }
  const pairs = whole.map((rel) => [join(root, rel), join(target, rel)]);
  // execve(2) fails with E2BIG past ARG_MAX, which a monorepo cloned child by child reaches in one call.
  for (let at = 0; at < pairs.length; at += CLONES_PER_CALL)
    await runOperationFile(operation, getExecutor(), helper, pairs.slice(at, at + CLONES_PER_CALL).flat(), {
      timeoutMs: 'unbounded',
      cwd: target,
    });
  const cloned = format === 'sha1' ? clonedIndex(source, sourceMtimeSec, root, target) : null;
  await writeFile(join(await gitDir(target), 'index'), cloned?.bytes ?? source);
  // @ref LLP 0029#the-copied-index-gets-the-clones-stat-data -- reset rewrites every file whose stat data it cannot trust
  if (!cloned || cloned.unproven) await gitAsync(target, ['update-index', '-q', '--unmerged', '--refresh'], write);
  await gitAsync(target, ['-c', 'submodule.recurse=false', 'reset', '-q', '--hard'], write);
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
