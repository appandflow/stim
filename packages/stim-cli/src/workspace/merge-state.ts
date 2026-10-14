import { statSync } from 'node:fs';
import { isTimeoutError, type ExecOptions } from '../exec.ts';
import { git as runGit, gitAsync, gitQuiet, gitQuietAsync } from './git.ts';

const FETCH_TIMEOUT_MS = 30_000;
/** How old a fetch or a cached lookup can be and still count as fresh. */
export const FETCH_FRESH_MS: number = 10 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const REMOTE_PREFIX = 'refs/remotes/origin/';
// Beyond this many commits of its own ahead of the merge base, the patch-id comparison below is
// too slow to be worth attempting (stim#1815 saw one at ~20,800).
const MAX_MERGE_STATE_COMMITS = 2000;

export interface DefaultBranch {
  ref: string;
  name: string;
}

export type MergeState =
  | { merged: true; into: string; head: string; coversUnpushed: boolean; mergedAt: number }
  | { merged: false; unknown: boolean; detail: string; timedOut?: true; noOwnCommits?: true };

function failure(error: unknown): string {
  const { stderr, message } = error as { stderr?: unknown; message?: string };
  const text = String(stderr ?? '').trim() || String(message ?? error);
  return text.split('\n')[0] ?? text;
}

/** When the checkout last fetched anything, from the mtime of its `FETCH_HEAD`, or null when it never did. */
export function lastFetchedAt(repo: string): number | null {
  return fetchTime(gitQuiet(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD']));
}

function fetchTime(path: string | null): number | null {
  path = path?.trim() ?? null;
  try {
    return path ? statSync(path).mtimeMs : null;
  } catch {
    return null;
  }
}

function fetchedRecently(repo: string, now: number): boolean {
  const at = lastFetchedAt(repo);
  return at !== null && now - at < FETCH_FRESH_MS;
}

/** The default branch that `origin/HEAD` names, as its existing remote-tracking ref, without fetching. */
export function localDefaultBranch(repo: string): DefaultBranch | { error: string } {
  return defaultBranch(repo, gitQuiet(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']));
}

function defaultBranch(repo: string, ref: string | null): DefaultBranch | { error: string } {
  ref = ref?.trim() ?? null;
  if (!ref?.startsWith(REMOTE_PREFIX)) {
    return { error: `origin/HEAD is not set; run \`git -C ${repo} remote set-head origin --auto\`` };
  }
  return { ref, name: `origin/${ref.slice(REMOTE_PREFIX.length)}` };
}

/**
 * Fetches the default branch that `origin/HEAD` names into its remote-tracking ref, bounded by a timeout and never
 * prompting for credentials. It skips the fetch when the checkout fetched anything in the last 10 minutes.
 */
export function fetchDefaultBranch(repo: string, now: number = Date.now()): DefaultBranch | { error: string } {
  const target = localDefaultBranch(repo);
  if ('error' in target || fetchedRecently(repo, now)) return target;
  const branch = target.ref.slice(REMOTE_PREFIX.length);
  try {
    runGit(
      repo,
      ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', `+refs/heads/${branch}:${target.ref}`],
      { write: true, timeoutMs: FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } },
    );
  } catch (error) {
    return { error: `git fetch origin ${branch} failed: ${failure(error)}` };
  }
  return target;
}

function notMerged(detail: string): MergeState {
  return { merged: false, unknown: false, detail };
}

interface GitRead {
  args: string[];
  options?: Partial<ExecOptions>;
}

type Reads<T> = Generator<GitRead, T, string>;

function* git(args: string[], input?: string): Reads<string> {
  return yield { args: ['--literal-pathspecs', ...args], options: { input } };
}
function* patch(args: string[], input?: string): Reads<string> {
  return yield { args: ['--literal-pathspecs', ...args], options: { input, untrimmed: true } };
}
function* probe(args: string[]): Reads<string | null> {
  try {
    return yield { args };
  } catch (error) {
    if (isTimeoutError(error)) throw error;
    return null;
  }
}
function* patchIdCommits(text: string): Reads<Map<string, string>> {
  const output = text ? yield* git(['patch-id', '--verbatim'], text) : '';
  return new Map(
    output.split('\n').flatMap((line) => {
      const [id, commit] = line.split(' ');
      return id && commit ? [[id, commit] as const] : [];
    }),
  );
}
function* patchIds(text: string): Reads<string[]> {
  return [...(yield* patchIdCommits(text)).keys()];
}
function* committedAt(commits: string[]): Reads<number> {
  const times = commits.length
    ? (yield* git(['log', '--no-walk', '--stdin', '--format=%ct'], commits.join('\n'))).split('\n').map(Number)
    : [];
  if (!times.length || !times.every(Number.isFinite)) throw new Error(`no committer date for ${commits.join(' ')}`);
  return Math.max(...times) * 1000;
}

function* currentBranch(): Reads<string | null> {
  const ref = (yield* probe(['symbolic-ref', '--quiet', 'HEAD']))?.trim();
  return ref?.startsWith('refs/heads/') ? ref : null;
}

function* upstreamGone(branch: string | null): Reads<boolean> {
  if (!branch) return false;
  const track = yield* probe(['for-each-ref', '--format=%(upstream)%00%(upstream:track)', branch]);
  const [upstream, state] = (track ?? '').trim().split('\0');
  return Boolean(upstream) && state === '[gone]';
}

function* committedOn(branch: string | null, head: string): Reads<boolean> {
  if (!branch) return false;
  const entries = (yield* probe(['reflog', 'show', '--format=%H %gs', branch])) ?? '';
  for (const entry of entries.split('\n')) {
    const [sha = '', ...subject] = entry.split(' ');
    if (
      /^(commit|cherry-pick|rebase|revert)\b/.test(subject.join(' ')) &&
      (yield* probe(['merge-base', '--is-ancestor', sha, head])) !== null
    )
      return true;
  }
  return false;
}

function* mergeStateReads({ ref, name }: DefaultBranch, maxCommits: number): Reads<MergeState> {
  const diffOptions = ['--no-color', '--no-ext-diff'];
  const noOwnCommits: MergeState = {
    merged: false,
    unknown: false,
    detail: `no commits of its own beyond ${name}`,
    noOwnCommits: true,
  };
  try {
    const head = yield* git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const base = yield* git(['merge-base', head, ref]);
    const branch = yield* currentBranch();
    if (base === head) {
      const mainline =
        (yield* git(['rev-parse', ref])) === head ||
        (yield* git(['rev-list', '--first-parent', '--parents', `${head}..${ref}`]))
          .split('\n')
          .some((line) => line.split(' ')[1] === head);
      if (mainline || !(yield* committedOn(branch, head))) return noOwnCommits;
      const descendants = new Set((yield* git(['rev-list', '--ancestry-path', `${head}..${ref}`])).split('\n'));
      const landed = (yield* git(['rev-list', '--first-parent', '--reverse', `${head}..${ref}`]))
        .split('\n')
        .find((commit) => descendants.has(commit));
      if (!landed) throw new Error(`no commit on ${name} merges ${head}`);
      return { merged: true, into: name, head, coversUnpushed: false, mergedAt: yield* committedAt([landed]) };
    }
    const aheadCount = Number(yield* git(['rev-list', '--count', `${base}..${head}`]));
    if (aheadCount > maxCommits) {
      return {
        merged: false,
        unknown: true,
        detail: `merge state unknown: ${aheadCount} commits of its own ahead of the merge base with ${name} exceeds the ${maxCommits}-commit limit`,
      };
    }
    const files = (yield* git(['diff', '--name-only', '--no-renames', '-z', base, head])).split('\0').filter(Boolean);
    if (!files.length) return notMerged(`no net change beyond ${name}`);
    // The pathspec goes through stdin, not argv: `files` can be arbitrarily long (stim#1815).
    const log = function* (range: string, pathspec: string[] = []): Reads<string> {
      return yield* patch(
        ['log', '-p', '--no-merges', ...diffOptions, '--format=commit %H', '--stdin'],
        pathspec.length ? `${range}\n--\n${pathspec.join('\n')}\n` : `${range}\n`,
      );
    };
    const upstream = yield* patchIdCommits(yield* log(`${base}..${ref}`, files));
    const patchEquivalent = function* (ids: string[]): Reads<MergeState> {
      return {
        merged: true,
        into: name,
        head,
        coversUnpushed: yield* upstreamGone(branch),
        mergedAt: yield* committedAt(ids.map((id) => upstream.get(id)!)),
      };
    };
    const squash = yield* patchIds(yield* patch(['diff', ...diffOptions, base, head]));
    if (squash.length === 1 && upstream.has(squash[0]!)) return yield* patchEquivalent(squash);
    if (!(yield* git(['rev-list', '--merges', `${base}..${head}`]))) {
      const own = yield* patchIds(yield* log(`${base}..${head}`));
      if (own.length && own.every((id) => upstream.has(id))) return yield* patchEquivalent(own);
    }
    return notMerged(`not merged into ${name}`);
  } catch (error) {
    const timedOut = isTimeoutError(error) ? { timedOut: true as const } : {};
    return { merged: false, unknown: true, detail: `merge state unknown: ${failure(error)}`, ...timedOut };
  }
}

/**
 * Whether the worktree's HEAD is merged into `target`, and when: `mergedAt` is the committer date, in epoch
 * milliseconds, of the commit on `target` that brought the work in, the latest one for a rebase merge.
 * The signals, all local git:
 * - HEAD is an ancestor of the default branch, off its first-parent line, and the branch's reflog shows a commit made
 *   on it that HEAD contains, so a merge commit brought the branch's own work in. A branch with no commit of its own
 *   is not merged.
 * - The branch changes the tree, has no merge commits, and every commit since the merge base has the same
 *   `git patch-id --verbatim` as a commit on the default branch (a rebase merge).
 * - The branch changes the tree and its whole diff since the merge base has the same verbatim patch id as a commit on
 *   the default branch, limited to the files the branch changes (a squash merge).
 * A HEAD the default branch contains with no commit of its own on the branch is not merged and carries
 * `noOwnCommits`. Anything git cannot answer is unknown, never merged. `coversUnpushed` is true for a patch-equivalent HEAD whose
 * upstream branch was deleted: its commits exist only locally, but their change is on the default branch.
 */
export function mergeState(
  path: string,
  target: DefaultBranch,
  {
    timeoutMs = GIT_TIMEOUT_MS,
    maxCommits = MAX_MERGE_STATE_COMMITS,
  }: { timeoutMs?: number; maxCommits?: number } = {},
): MergeState {
  const reads = mergeStateReads(target, maxCommits);
  let step = reads.next();
  while (!step.done) {
    const { args, options } = step.value;
    try {
      step = reads.next(runGit(path, args, { timeoutMs, ...options }));
    } catch (error) {
      step = reads.throw(error);
    }
  }
  return step.value;
}

/** `mergeState` without blocking the event loop during Git reads. */
export async function mergeStateAsync(
  path: string,
  target: DefaultBranch,
  {
    timeoutMs = GIT_TIMEOUT_MS,
    maxCommits = MAX_MERGE_STATE_COMMITS,
  }: { timeoutMs?: number; maxCommits?: number } = {},
): Promise<MergeState> {
  const reads = mergeStateReads(target, maxCommits);
  let step = reads.next();
  while (!step.done) {
    const { args, options } = step.value;
    try {
      step = reads.next(await gitAsync(path, args, { timeoutMs, ...options }));
    } catch (error) {
      step = reads.throw(error);
    }
  }
  return step.value;
}

/** `lastFetchedAt` without blocking the event loop during Git reads. */
export async function lastFetchedAtAsync(repo: string): Promise<number | null> {
  return fetchTime(await gitQuietAsync(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD']));
}

/** `localDefaultBranch` without blocking the event loop during Git reads. */
export async function localDefaultBranchAsync(repo: string): Promise<DefaultBranch | { error: string }> {
  return defaultBranch(repo, await gitQuietAsync(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']));
}

/** `fetchDefaultBranch` without blocking the event loop during Git reads or fetch. */
export async function fetchDefaultBranchAsync(
  repo: string,
  now: number = Date.now(),
): Promise<DefaultBranch | { error: string }> {
  const target = await localDefaultBranchAsync(repo);
  if ('error' in target) return target;
  const at = await lastFetchedAtAsync(repo);
  if (at !== null && now - at < FETCH_FRESH_MS) return target;
  const branch = target.ref.slice(REMOTE_PREFIX.length);
  try {
    await gitAsync(
      repo,
      ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', `+refs/heads/${branch}:${target.ref}`],
      {
        write: true,
        timeoutMs: FETCH_TIMEOUT_MS,
        env: { GIT_TERMINAL_PROMPT: '0' },
      },
    );
  } catch (error) {
    return { error: `git fetch origin ${branch} failed: ${failure(error)}` };
  }
  return target;
}
