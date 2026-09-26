import { getExecutor } from '../exec.ts';

const GH_TIMEOUT_MS = 20_000;
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
const GH_FIELDS = 'number,state,url,headRefOid,mergedAt,closedAt,isCrossRepository';
const SIGNED_OUT_EXIT = 4;

export interface GhPullRequest {
  number: number;
  state: string;
  url: string;
  headRefOid: string;
  mergedAt: string | null;
  closedAt: string | null;
  isCrossRepository?: boolean;
}

/**
 * The pull request whose head branch is the worktree's branch and whose commits include the worktree's HEAD.
 * `containsHead` is false when the pull request's head is an ancestor of HEAD: HEAD has commits the pull request
 * never had. `endedAt` is when it was merged or closed, in epoch milliseconds, and null while it is open.
 */
export interface PullRequestFact {
  number: number;
  state: 'open' | 'merged' | 'closed';
  url: string;
  head: string;
  containsHead: boolean;
  endedAt: number | null;
}

export type PullRequestLookup = { pullRequest: PullRequestFact | null } | { unavailable: string };

function stateOf(state: string): PullRequestFact['state'] | null {
  if (state === 'OPEN') return 'open';
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return null;
}

function epoch(text: string | null): number | null {
  const at = text ? Date.parse(text) : NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * Picks the pull request that describes `head` among those `gh pr list --head <branch>` returned. One whose head is
 * `head` wins, then one whose head contains `head`, then one whose head `head` contains. An open one wins a tier,
 * then the newest. A pull request unrelated to `head` is from an earlier use of the branch name, and one from a fork
 * only shares the branch name; both are ignored.
 * `isAncestor(a, b)` answers whether commit `a` is an ancestor of commit `b`, and false when git cannot tell.
 */
export function selectPullRequest(
  pulls: readonly GhPullRequest[],
  head: string,
  isAncestor: (ancestor: string, descendant: string) => boolean,
): PullRequestFact | null {
  const known = pulls.flatMap((pull) => {
    const state = stateOf(pull.state);
    return state && pull.headRefOid && !pull.isCrossRepository ? [{ pull, state }] : [];
  });
  const tiers = [
    known.filter(({ pull }) => pull.headRefOid === head),
    known.filter(({ pull }) => pull.headRefOid !== head && isAncestor(head, pull.headRefOid)),
    known.filter(({ pull }) => pull.headRefOid !== head && isAncestor(pull.headRefOid, head)),
  ];
  const tier = tiers.findIndex((entries) => entries.length > 0);
  if (tier < 0) return null;
  const best = tiers[tier]!.toSorted(
    (a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.pull.number - a.pull.number,
  )[0]!;
  const { pull, state } = best;
  return {
    number: pull.number,
    state,
    url: pull.url,
    head: pull.headRefOid,
    containsHead: tier < 2,
    endedAt: state === 'merged' ? epoch(pull.mergedAt) : state === 'closed' ? epoch(pull.closedAt) : null,
  };
}

function firstLine(error: unknown): string {
  const { stderr, message } = error as { stderr?: unknown; message?: string };
  const text = String(stderr ?? '').trim() || String(message ?? error);
  return text.split('\n')[0] ?? text;
}

function ghFailure(error: unknown, command: string): { unavailable: string; sticky: boolean } {
  if ((error as { status?: number }).status === SIGNED_OUT_EXIT) {
    return { unavailable: 'gh is not signed in; run `gh auth login`', sticky: true };
  }
  if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { unavailable: `${command} did not answer within ${GH_TIMEOUT_MS / 1000}s`, sticky: true };
  }
  return { unavailable: `${command} failed: ${firstLine(error)}`, sticky: false };
}

function ancestry(cwd: string): (ancestor: string, descendant: string) => boolean {
  const exec = getExecutor();
  return (ancestor, descendant) =>
    exec.runFileQuiet('git', ['-C', cwd, 'merge-base', '--is-ancestor', ancestor, descendant]) !== null;
}

/**
 * Asks GitHub, through `gh`, which pull requests have `branch` as their head, run from `cwd` so `gh` picks the
 * repository from its remotes. Each call is one fixed `gh pr list` invocation. Once `gh` is missing, signed out or
 * times out, every later lookup through the same function answers `unavailable` without running it again.
 */
export function pullRequestLookup(): (cwd: string, branch: string, head: string) => PullRequestLookup {
  let unavailable: string | null | undefined;
  return (cwd, branch, head) => {
    const exec = getExecutor();
    if (unavailable === undefined) unavailable = exec.findExecutable('gh') ? null : 'gh is not installed';
    if (unavailable) return { unavailable };
    let out: string;
    try {
      out = exec.runFile(
        'gh',
        ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '20', '--json', GH_FIELDS],
        { cwd, timeoutMs: GH_TIMEOUT_MS, env: GH_ENV },
      );
    } catch (error) {
      const failure = ghFailure(error, 'gh pr list');
      if (failure.sticky) unavailable = failure.unavailable;
      return { unavailable: failure.unavailable };
    }
    let pulls: GhPullRequest[];
    try {
      pulls = JSON.parse(out) as GhPullRequest[];
    } catch {
      return { unavailable: 'gh pr list printed no JSON' };
    }
    return { pullRequest: Array.isArray(pulls) ? selectPullRequest(pulls, head, ancestry(cwd)) : null };
  };
}

/** A worktree whose pull request {@link pullRequestLookups} looks up: its path, branch and HEAD commit. */
export interface PullRequestQuery {
  cwd: string;
  branch: string;
  head: string;
}

function branchesQuery(count: number): string {
  const variables = Array.from({ length: count }, (_, i) => `, $b${i}: String!`).join('');
  const fields = Array.from(
    { length: count },
    (_, i) =>
      ` b${i}: pullRequests(headRefName: $b${i}, states: [OPEN, CLOSED, MERGED], first: 20,` +
      ` orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${GH_FIELDS.replaceAll(',', ' ')} } }`,
  ).join('');
  return `query($owner: String!, $repo: String!${variables}) { repository(owner: $owner, name: $repo) {${fields} } }`;
}

/**
 * {@link pullRequestLookup} for every branch of one repository in one fixed `gh api graphql` call run from `repo`,
 * which asks for the same 20 newest pull requests of each head branch that `gh pr list --head` returns. `gh` fills
 * `{owner}` and `{repo}` from the remotes of `repo`; branch names travel as variables. Once `gh` is missing, signed
 * out or times out, every later call through the same function answers `unavailable` without running it again.
 */
export function pullRequestLookups(): (
  repo: string,
  queries: readonly PullRequestQuery[],
) => Promise<PullRequestLookup[]> {
  let unavailable: string | null | undefined;
  return async (repo, queries) => {
    const exec = getExecutor();
    if (unavailable === undefined) unavailable = exec.findExecutable('gh') ? null : 'gh is not installed';
    const all = (lookup: PullRequestLookup) => queries.map(() => lookup);
    if (unavailable) return all({ unavailable });
    if (!queries.length) return [];
    const args = ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}'];
    queries.forEach(({ branch }, i) => args.push('-f', `b${i}=${branch}`));
    args.push('-f', `query=${branchesQuery(queries.length)}`);
    let out: string;
    try {
      out = await exec.runFileAsync('gh', args, { cwd: repo, timeoutMs: GH_TIMEOUT_MS, env: GH_ENV });
    } catch (error) {
      const failure = ghFailure(error, 'gh api graphql');
      if (failure.sticky) unavailable = failure.unavailable;
      return all({ unavailable: failure.unavailable });
    }
    let found: Record<string, { nodes?: unknown } | null> | undefined;
    try {
      found = (JSON.parse(out) as { data?: { repository?: Record<string, { nodes?: unknown } | null> } }).data
        ?.repository;
    } catch {
      return all({ unavailable: 'gh api graphql printed no JSON' });
    }
    if (!found) return all({ unavailable: 'gh api graphql printed no repository' });
    return queries.map(({ cwd, head }, i) => {
      const pulls = found[`b${i}`]?.nodes;
      return {
        pullRequest: Array.isArray(pulls) ? selectPullRequest(pulls as GhPullRequest[], head, ancestry(cwd)) : null,
      };
    });
  };
}

/** The merged or closed pull request whose commits include HEAD, which makes the worktree removable. */
export function endedPullRequest(lookup: PullRequestLookup | null): PullRequestFact | null {
  const pr = lookup && 'pullRequest' in lookup ? lookup.pullRequest : null;
  return pr && pr.state !== 'open' && pr.containsHead ? pr : null;
}

/** "PR #123 merged", for reports. */
export function describePullRequest(pr: Pick<PullRequestFact, 'number' | 'state'>): string {
  return `PR #${pr.number} ${pr.state}`;
}
