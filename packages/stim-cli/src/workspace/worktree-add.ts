import type { ChildProcess } from 'node:child_process';
import type { StimContext } from '@stim-cli/core';
import { isPathPrefix } from '@stim-cli/core/state';
import { lstatSync, rmSync } from 'node:fs';
import { mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { clonefileHelper } from '../clonefile.ts';
import { runOperationFile } from '../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { getExecutor } from '../exec.ts';
import { removeTemporaryEntryAsync } from '../temporary.ts';
import { cloneStat, readIndex, writeIndex } from './git-index.ts';
import type { FileStat, IndexEntry } from './git-index.ts';
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

function parentOf(path: Buffer): Buffer {
  return path.subarray(0, Math.max(path.lastIndexOf(0x2f), 0));
}

function directoryIdentity(found: FileStat | null): string | null {
  return found && (found.mode & 0o170000n) === 0o040000n ? `${found.ino} ${found.ctimeNs}` : null;
}

const CONVERSION_ATTRIBUTES = ['eol', 'ident', 'filter', 'working-tree-encoding'];
const ENTRIES_PER_ABORT_CHECK = 1024;

/**
 * For each entry, whether a checkout of the commit at `target` writes the entry's blob byte for byte and the file
 * the entry describes has that many bytes, so an unchanged file is what git would write there today.
 * @ref LLP 0029#the-copied-index-gets-the-clones-stat-data -- a clone is kept only where checkout would write the same bytes
 */
async function writtenAsStored(
  entries: readonly IndexEntry[],
  target: string,
  operation: StimContext,
): Promise<boolean[]> {
  const read = gitOptions(operation);
  // git convert.c output_eol and text_eol_is_crlf: without an eol attribute a checkout writes CRLF only under
  // core.autocrlf=true or core.eol=crlf.
  const [autocrlf, eol] = await Promise.all([
    gitAsync(target, ['config', '--default=false', '--get', 'core.autocrlf'], read),
    gitAsync(target, ['config', '--default=lf', '--get', 'core.eol'], read),
  ]);
  if (
    !['false', 'no', 'off', '0'].includes(autocrlf.trim().toLowerCase()) ||
    !['lf', 'native'].includes(eol.trim().toLowerCase())
  )
    throw new Error('core.autocrlf or core.eol converts line endings at checkout');
  const paths = entries.map((entry) => entry.path.toString());
  // git-check-attr(1): --source reads .gitattributes from that commit instead of the working tree, which is what a
  // checkout of it applies. Each path comes back once per attribute, in the order asked.
  const [attributes, sizes] = await Promise.all([
    gitAsync(target, ['check-attr', '-z', '--stdin', '--source=HEAD', ...CONVERSION_ATTRIBUTES], {
      ...read,
      input: paths.map((path) => `${path}\0`).join(''),
    }),
    gitAsync(target, ['cat-file', '--batch-check=%(objectsize)'], {
      ...read,
      input: entries.map((entry) => `${entry.oid}\n`).join(''),
    }),
  ]);
  const values = attributes.split('\0');
  const stored = sizes.split('\n');
  if (values.length < entries.length * CONVERSION_ATTRIBUTES.length * 3 || stored.length < entries.length)
    throw new Error('git did not answer for every index entry');
  return entries.map((entry, n) => {
    const [endOfLine, ...others] = CONVERSION_ATTRIBUTES.map(
      (_, attribute) => values[(n * CONVERSION_ATTRIBUTES.length + attribute) * 3 + 2],
    );
    return (
      Buffer.from(paths[n] ?? '').equals(entry.path) &&
      ['unspecified', 'unset', 'lf'].includes(endOfLine ?? '') &&
      others.every((value) => value === 'unspecified' || value === 'unset') &&
      Number(stored[n]) % 2 ** 32 === entry.stat.size
    );
  });
}

/**
 * Reads `bytes`, the index of the source checkout `root`, before the checkout is cloned, and returns what makes the
 * index for the clone at `target` afterwards: an entry whose file git would write the same today, and whose source
 * file is unchanged, gets its clone's stat data, and every other entry is left for `git reset --hard` to write.
 * Throws for an index this does not copy.
 * @ref LLP 0029#the-copied-index-gets-the-clones-stat-data -- only what the source checkout proves is trusted
 */
async function indexForClone(
  bytes: Buffer,
  mtimeSec: number,
  root: string,
  target: string,
  operation: StimContext,
): Promise<() => Buffer> {
  const index = readIndex(bytes);
  // gitformat-index(5): an extension whose signature does not start with A to Z is one a reader must understand:
  // "link", the split index whose entries live in a second file, and "sdir", the sparse index.
  if (
    !index ||
    index.extensions.some(({ signature }) => !/^[A-Z]/.test(signature)) ||
    index.entries.some((entry) => entry.assumeUnchanged || entry.skipWorktree)
  )
    throw new Error('the source index is not one that can be copied');
  const stored = await writtenAsStored(index.entries, target, operation);
  const before = new Map<string, string | null>();
  for (const entry of index.entries)
    for (let parent = parentOf(entry.path); parent.length; parent = parentOf(parent)) {
      const key = parent.toString('latin1');
      if (before.has(key)) break;
      before.set(key, directoryIdentity(look(root, parent)));
    }
  return () => {
    const unmoved = new Map<string, boolean>();
    // git checks a tracked path with has_symlink_leading_path when it refreshes, but reset --hard only calls lstat,
    // which follows a symbolic link that replaced a parent directory to a file that still matches. rename(2) leaves
    // the stat data of what a moved directory holds as it was, so a directory moved away and back shows only in
    // its own change time.
    const inPlace = (path: Buffer): boolean => {
      const parent = parentOf(path);
      if (!parent.length) return true;
      const key = parent.toString('latin1');
      let same = unmoved.get(key);
      if (same === undefined) {
        const was = before.get(key);
        same =
          inPlace(parent) &&
          was !== null &&
          was === directoryIdentity(look(root, parent)) &&
          directoryIdentity(look(target, parent)) !== null;
        unmoved.set(key, same);
      }
      return same;
    };
    // gitattributes(5): a checkout reads .gitattributes from the index and, for a directory whose file the index
    // does not list, from the working tree, where the clone put the source's untracked one.
    const listed = new Set(index.entries.map((entry) => entry.path.toString('latin1')));
    for (const key of ['', ...before.keys()]) {
      const attributes = Buffer.from(key ? `${key}/.gitattributes` : '.gitattributes', 'latin1');
      if (!listed.has(attributes.toString('latin1')) && inPlace(attributes))
        rmSync(Buffer.concat([Buffer.from(`${target}/`), attributes]), { force: true });
    }
    const stats = index.entries.map((entry, n) => {
      if (n % ENTRIES_PER_ABORT_CHECK === 0) operation.signal.throwIfAborted();
      return stored[n] && inPlace(entry.path)
        ? cloneStat(entry, look(root, entry.path), look(target, entry.path), mtimeSec)
        : null;
    });
    // The untracked cache, the fsmonitor bitmap and the entry offset tables describe the source's worktree or bytes.
    return writeIndex(bytes, index, stats, (signature) => ['TREE', 'REUC'].includes(signature));
  };
}

/**
 * Fills `target`, a worktree made with `git worktree add --no-checkout`, from the source checkout `root`: one
 * clonefile(2) call per top-level entry, or per child where the entry holds a skipped directory. The source's index
 * is copied with the clones' stat data, so git writes only the files that differ from the target commit or that it
 * cannot take from the source as they are, and removes what is neither tracked nor ignored there. Submodule paths end empty,
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
  if (format !== 'sha1') throw new Error(`a ${format} index is not copied`);
  const copyIndex = await indexForClone(source, sourceMtimeSec, root, target, operation);
  const pairs = whole.map((rel) => [join(root, rel), join(target, rel)]);
  // execve(2) fails with E2BIG past ARG_MAX, which a monorepo cloned child by child reaches in one call.
  for (let at = 0; at < pairs.length; at += CLONES_PER_CALL)
    await runOperationFile(operation, getExecutor(), helper, pairs.slice(at, at + CLONES_PER_CALL).flat(), {
      timeoutMs: 'unbounded',
      cwd: target,
    });
  await writeFile(join(await gitDir(target), 'index'), copyIndex());
  // @ref LLP 0029#the-copied-index-gets-the-clones-stat-data -- reset writes every file whose entry has no stat data
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
