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
 * Whether the worktree's HEAD is merged into `target`. The signals, all local git:
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
export function mergeState(path: string, { ref, name }: DefaultBranch): MergeState {
  const git = (args: string[], input?: string): string =>
    getExecutor().runFile('git', ['--literal-pathspecs', '-C', path, ...args], { timeoutMs: GIT_TIMEOUT_MS, input });
  const patch = (args: string[]): string =>
    getExecutor().runFile('git', ['--literal-pathspecs', '-C', path, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
      untrimmed: true,
    });
  const patchIds = (text: string): string[] =>
    text
      ? git(['patch-id', '--verbatim'], text)
          .split('\n')
          .flatMap((line) => line.split(' ')[0] || [])
      : [];
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
      return { merged: true, into: name, head, coversUnpushed: false };
    }
    const files = git(['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean);
    if (!files.length) return notMerged(`no net change beyond ${name}`);
    const log = (range: string, pathspec: string[] = []) =>
      patch(['log', '-p', '--no-merges', ...diffOptions, '--format=commit %H', range, '--', ...pathspec]);
    const upstream = new Set(patchIds(log(`${base}..${ref}`, files)));
    const patchEquivalent = (): MergeState => ({
      merged: true,
      into: name,
      head,
      coversUnpushed: upstreamGone(path, branch),
    });
    const squash = patchIds(patch(['diff', ...diffOptions, base, head]));
    if (squash.length === 1 && upstream.has(squash[0]!)) return patchEquivalent();
    if (!git(['rev-list', '--merges', `${base}..${head}`])) {
      const own = patchIds(log(`${base}..${head}`));
      if (own.length && own.every((id) => upstream.has(id))) return patchEquivalent();
    }
    return notMerged(`not merged into ${name}`);
  } catch (error) {
    return { merged: false, unknown: true, detail: `merge state unknown: ${failure(error)}` };
  }
}
