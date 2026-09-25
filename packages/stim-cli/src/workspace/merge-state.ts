import { statSync } from 'node:fs';
import { getExecutor } from '../exec.ts';

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_FRESH_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const REMOTE_PREFIX = 'refs/remotes/origin/';

// `git commit-tree` needs an identity and a date; fixed values keep the
// synthetic squash commit identical across runs, so repeated checks add no
// new objects.
const SQUASH_IDENTITY = {
  GIT_AUTHOR_NAME: 'stim',
  GIT_AUTHOR_EMAIL: 'stim@localhost',
  GIT_AUTHOR_DATE: '1000000000 +0000',
  GIT_COMMITTER_NAME: 'stim',
  GIT_COMMITTER_EMAIL: 'stim@localhost',
  GIT_COMMITTER_DATE: '1000000000 +0000',
};

export interface DefaultBranch {
  ref: string;
  name: string;
}

export type MergeState =
  | { merged: true; into: string; head: string; coversUnpushed: boolean }
  | { merged: false; unknown: boolean; detail: string };

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

function committedOn(path: string, branch: string | null): boolean {
  if (!branch) return false;
  const subjects = getExecutor().runFileQuiet('git', ['-C', path, 'reflog', 'show', '--format=%gs', branch]) ?? '';
  return subjects.split('\n').some((subject) => /^(commit|cherry-pick|rebase|revert)\b/.test(subject));
}

/**
 * Whether the worktree's HEAD is merged into `target`. The signals, all local git:
 * - HEAD is an ancestor of the default branch, off its first-parent line, and the branch's reflog shows a commit made
 *   on it, so a merge commit brought the branch's own work in. A branch with no commit of its own is not merged.
 * - The branch changes the tree, has no merge commits, and every commit since the merge base has a patch-equivalent
 *   commit on the default branch (a rebase merge).
 * - The branch changes the tree and its whole change since the merge base is patch-equivalent to one commit on the
 *   default branch (a squash merge).
 * Patch equivalence is git's patch-id, which ignores whitespace. Anything git cannot answer is unknown, never merged.
 * `coversUnpushed` is true for a patch-equivalent HEAD whose upstream branch was deleted: its commits exist only
 * locally, but their change is on the default branch.
 */
export function mergeState(path: string, { ref, name }: DefaultBranch): MergeState {
  const git = (args: string[], env?: Record<string, string>): string =>
    getExecutor().runFile('git', ['-C', path, ...args], { timeoutMs: GIT_TIMEOUT_MS, env });
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
      if (mainline || !committedOn(path, branch)) return noOwnCommits;
      return { merged: true, into: name, head, coversUnpushed: false };
    }
    const tree = git(['rev-parse', `${head}^{tree}`]);
    if (tree === git(['rev-parse', `${base}^{tree}`])) return notMerged(`no net change beyond ${name}`);
    const equivalent = (tip: string): boolean => {
      const lines = git(['cherry', ref, tip, base]).split('\n').filter(Boolean);
      return lines.length > 0 && lines.every((line) => line.startsWith('- '));
    };
    const patchEquivalent = () => ({
      merged: true as const,
      into: name,
      head,
      coversUnpushed: upstreamGone(path, branch),
    });
    if (!git(['rev-list', '--merges', `${base}..${head}`]) && equivalent(head)) return patchEquivalent();
    const squashed = git(
      ['commit-tree', '--no-gpg-sign', tree, '-p', base, '-m', 'stim gc squash-merge check'],
      SQUASH_IDENTITY,
    );
    if (equivalent(squashed)) return patchEquivalent();
    return notMerged(`not merged into ${name}`);
  } catch (error) {
    return { merged: false, unknown: true, detail: `merge state unknown: ${failure(error)}` };
  }
}
