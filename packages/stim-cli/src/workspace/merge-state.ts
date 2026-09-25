import { statSync } from 'node:fs';
import { getExecutor } from '../exec.ts';

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_FRESH_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const REMOTE_PREFIX = 'refs/remotes/origin/';

export interface DefaultBranch {
  ref: string;
  name: string;
}

export type MergeState =
  | { merged: true; into: string; head: string; coversUnpushed: boolean; mergedAt: number }
  | { merged: false; unknown: boolean; detail: string; timedOut?: true };

function failure(error: unknown): string {
  const { stderr, message } = error as { stderr?: unknown; message?: string };
  const text = String(stderr ?? '').trim() || String(message ?? error);
  return text.split('\n')[0] ?? text;
}

function fetchedRecently(repo: string, now: number): boolean {
  const path = getExecutor()
    .runFileQuiet('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'])
    ?.trim();
  try {
    return Boolean(path) && now - statSync(path!).mtimeMs < FETCH_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * Fetches the default branch that `origin/HEAD` names into its remote-tracking ref, bounded by a timeout and never
 * prompting for credentials. It skips the fetch when the checkout fetched anything in the last 10 minutes.
 */
export function fetchDefaultBranch(repo: string, now: number = Date.now()): DefaultBranch | { error: string } {
  const exec = getExecutor();
  const ref = exec.runFileQuiet('git', ['-C', repo, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])?.trim();
  if (!ref?.startsWith(REMOTE_PREFIX)) {
    return { error: `origin/HEAD is not set; run \`git -C ${repo} remote set-head origin --auto\`` };
  }
  const branch = ref.slice(REMOTE_PREFIX.length);
  if (fetchedRecently(repo, now)) return { ref, name: `origin/${branch}` };
  try {
    exec.runFile(
      'git',
      [
        '-C',
        repo,
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-recurse-submodules',
        'origin',
        `+refs/heads/${branch}:${ref}`,
      ],
      { timeoutMs: FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } },
    );
  } catch (error) {
    return { error: `git fetch origin ${branch} failed: ${failure(error)}` };
  }
  return { ref, name: `origin/${branch}` };
}

function notMerged(detail: string): MergeState {
  return { merged: false, unknown: false, detail };
}

function currentBranch(path: string): string | null {
  const ref = getExecutor().runFileQuiet('git', ['-C', path, 'symbolic-ref', '--quiet', 'HEAD'])?.trim();
  return ref?.startsWith('refs/heads/') ? ref : null;
}

function upstreamGone(path: string, branch: string | null): boolean {
  if (!branch) return false;
  const track = getExecutor().runFileQuiet('git', [
    '-C',
    path,
    'for-each-ref',
    '--format=%(upstream)%00%(upstream:track)',
    branch,
  ]);
  const [upstream, state] = (track ?? '').trim().split('\0');
  return Boolean(upstream) && state === '[gone]';
}

function committedOn(path: string, branch: string | null, head: string): boolean {
  if (!branch) return false;
  const exec = getExecutor();
  const entries = exec.runFileQuiet('git', ['-C', path, 'reflog', 'show', '--format=%H %gs', branch]) ?? '';
  return entries.split('\n').some((entry) => {
    const [sha = '', ...subject] = entry.split(' ');
    return (
      /^(commit|cherry-pick|rebase|revert)\b/.test(subject.join(' ')) &&
      exec.runFileQuiet('git', ['-C', path, 'merge-base', '--is-ancestor', sha, head]) !== null
    );
  });
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
 * Anything git cannot answer is unknown, never merged. `coversUnpushed` is true for a patch-equivalent HEAD whose
 * upstream branch was deleted: its commits exist only locally, but their change is on the default branch.
 */
export function mergeState(
  path: string,
  { ref, name }: DefaultBranch,
  { timeoutMs = GIT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): MergeState {
  const git = (args: string[], input?: string): string =>
    getExecutor().runFile('git', ['--literal-pathspecs', '-C', path, ...args], { timeoutMs, input });
  const patch = (args: string[]): string =>
    getExecutor().runFile('git', ['--literal-pathspecs', '-C', path, ...args], { timeoutMs, untrimmed: true });
  const patchIdCommits = (text: string): Map<string, string> =>
    new Map(
      text
        ? git(['patch-id', '--verbatim'], text)
            .split('\n')
            .flatMap((line) => {
              const [id, commit] = line.split(' ');
              return id && commit ? [[id, commit] as const] : [];
            })
        : [],
    );
  const patchIds = (text: string): string[] => [...patchIdCommits(text).keys()];
  const committedAt = (commits: string[]): number => {
    const times = commits.length
      ? git(['show', '-s', '--format=%ct', ...commits])
          .split('\n')
          .map(Number)
      : [];
    if (!times.length || !times.every(Number.isFinite)) throw new Error(`no committer date for ${commits.join(' ')}`);
    return Math.max(...times) * 1000;
  };
  const diffOptions = ['--no-color', '--no-ext-diff'];
  const noOwnCommits = notMerged(`no commits of its own beyond ${name}`);
  try {
    const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const base = git(['merge-base', head, ref]);
    const branch = currentBranch(path);
    if (base === head) {
      const mainline =
        git(['rev-parse', ref]) === head ||
        git(['rev-list', '--first-parent', '--parents', `${head}..${ref}`])
          .split('\n')
          .some((line) => line.split(' ')[1] === head);
      if (mainline || !committedOn(path, branch, head)) return noOwnCommits;
      const descendants = new Set(git(['rev-list', '--ancestry-path', `${head}..${ref}`]).split('\n'));
      const landed = git(['rev-list', '--first-parent', '--reverse', `${head}..${ref}`])
        .split('\n')
        .find((commit) => descendants.has(commit));
      if (!landed) throw new Error(`no commit on ${name} merges ${head}`);
      return { merged: true, into: name, head, coversUnpushed: false, mergedAt: committedAt([landed]) };
    }
    const files = git(['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean);
    if (!files.length) return notMerged(`no net change beyond ${name}`);
    const log = (range: string, pathspec: string[] = []) =>
      patch(['log', '-p', '--no-merges', ...diffOptions, '--format=commit %H', range, '--', ...pathspec]);
    const upstream = patchIdCommits(log(`${base}..${ref}`, files));
    const patchEquivalent = (ids: string[]): MergeState => ({
      merged: true,
      into: name,
      head,
      coversUnpushed: upstreamGone(path, branch),
      mergedAt: committedAt(ids.map((id) => upstream.get(id)!)),
    });
    const squash = patchIds(patch(['diff', ...diffOptions, base, head]));
    if (squash.length === 1 && upstream.has(squash[0]!)) return patchEquivalent(squash);
    if (!git(['rev-list', '--merges', `${base}..${head}`])) {
      const own = patchIds(log(`${base}..${head}`));
      if (own.length && own.every((id) => upstream.has(id))) return patchEquivalent(own);
    }
    return notMerged(`not merged into ${name}`);
  } catch (error) {
    const timedOut = (error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT' ? { timedOut: true as const } : {};
    return { merged: false, unknown: true, detail: `merge state unknown: ${failure(error)}`, ...timedOut };
  }
}
