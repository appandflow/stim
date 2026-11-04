import type { StimContext } from '@stim-cli/core';
import {
  pullRequestCacheFile,
  readPullRequestCache,
  type PullRequestCacheEntry,
  type WorktreePullRequest,
} from '@stim-cli/core/state';
import { writeCacheFile } from './cache-file.ts';
import { gitAsync } from './workspace/git.ts';
import {
  pullRequestLookups,
  type PullRequestFact,
  type PullRequestLookup,
  type PullRequestQuery,
} from './workspace/pull-request.ts';

/** How long a worktree's cached pull request lookup counts as current for `status`, the push notifier and similar. */
export const PULL_REQUEST_MAX_AGE_MS: number = 5 * 60_000;

/** A worktree to look up: `path` keys the cache, and `cwd` is where Git compares the pull request's head with `head`. */
export interface PullRequestRequest extends PullRequestQuery {
  path: string;
}

function statusPullRequest(fact: PullRequestFact, checkedAt: string): WorktreePullRequest {
  return {
    number: fact.number,
    url: fact.url,
    title: fact.title ?? '',
    state: fact.state === 'open' && fact.draft ? 'draft' : fact.state,
    checks: fact.checks ?? null,
    reviewDecision: fact.reviewDecision ?? null,
    checkedAt,
  };
}

/**
 * Writes a pull request lookup into the cache every surface reads. A lookup made without detail is marked `partial`,
 * so a caller that wants the title, checks and review decision asks again; until then the entry keeps the title cached
 * for the same pull request, and the checks and review decision cached for the same HEAD.
 */
function recordPullRequestLookup(
  { path, branch, head }: { path: string; branch: string; head: string },
  fact: PullRequestFact | null,
  checkedAt: string,
): void {
  let pullRequest = fact ? statusPullRequest(fact, checkedAt) : null;
  const partial = pullRequest !== null && fact?.title === undefined;
  const previous = partial ? readPullRequestCache(path) : null;
  if (pullRequest && previous?.pullRequest?.number === pullRequest.number) {
    const same = previous.head === head;
    pullRequest = {
      ...pullRequest,
      title: previous.pullRequest.title,
      checks: same ? previous.pullRequest.checks : null,
      reviewDecision: same ? previous.pullRequest.reviewDecision : null,
    };
  }
  const entry: PullRequestCacheEntry = {
    path,
    branch,
    head,
    checkedAt,
    pullRequest,
    ...(fact ? { containsHead: fact.containsHead, endedAt: fact.endedAt } : {}),
    ...(partial ? { partial: true as const } : {}),
  };
  writeCacheFile(pullRequestCacheFile(path), entry);
}

function lookupOf(cached: PullRequestCacheEntry): PullRequestLookup | null {
  const { pullRequest: pr, containsHead, endedAt, head } = cached;
  if (pr === null) return { pullRequest: null };
  if (containsHead === undefined || (pr.state !== 'open' && pr.state !== 'draft' && typeof endedAt !== 'number')) {
    return null;
  }
  const state = pr.state === 'draft' ? 'open' : pr.state;
  return {
    pullRequest: {
      number: pr.number,
      url: pr.url,
      head,
      containsHead,
      state,
      draft: pr.state === 'draft',
      endedAt: state === 'open' ? null : (endedAt ?? null),
    },
  };
}

/**
 * The cached lookup of the worktree at `path` when it was made for `branch` at `head` less than `maxAgeMs` ago, with
 * the title, checks and review decision when `detail` asks for them. Null when the cache cannot answer, which includes
 * an entry written before it recorded whether the pull request contains HEAD. The cached fact carries no detail.
 */
export function cachedPullRequest(
  { path, branch, head }: { path: string; branch: string; head: string },
  { maxAgeMs, detail = false, now = Date.now }: { maxAgeMs: number; detail?: boolean; now?: () => number },
): PullRequestLookup | null {
  const cached = readPullRequestCache(path);
  if (!cached || cached.branch !== branch || cached.head !== head) return null;
  if (detail && cached.partial) return null;
  const age = now() - Date.parse(cached.checkedAt);
  if (!(age >= 0 && age < maxAgeMs)) return null;
  return lookupOf(cached);
}

/**
 * The one way to learn a worktree's pull request, for every surface that reports or acts on it. Each call of the
 * returned function takes the requests of one repository, answers from the cache the ones `cachedPullRequest` accepts
 * for `maxAgeMs`, asks GitHub once for the rest with `pullRequestLookups`, and records those answers in the cache. A
 * request GitHub could not answer gets `unavailable`, never a cached verdict that has gone stale. `onRecord` runs after
 * answers were written to the cache.
 */
export function refreshPullRequests({
  maxAgeMs,
  detail = false,
  operation,
  now = Date.now,
  onRecord,
}: {
  maxAgeMs: number;
  detail?: boolean;
  operation?: StimContext;
  now?: () => number;
  onRecord?: () => void;
}): (repo: string, requests: readonly PullRequestRequest[]) => Promise<PullRequestLookup[]> {
  const lookup = pullRequestLookups({ detail, operation });
  return async (repo, requests) => {
    operation?.signal.throwIfAborted();
    const answers: (PullRequestLookup | null)[] = requests.map((request) =>
      cachedPullRequest(request, { maxAgeMs, detail, now }),
    );
    const stale = requests.flatMap((request, index) => (answers[index] ? [] : [{ request, index }]));
    if (stale.length) {
      const found = await lookup(
        repo,
        stale.map(({ request }) => request),
      );
      const at = new Date(now()).toISOString();
      let recorded = false;
      stale.forEach(({ request, index }, k) => {
        const answer = found[k];
        if (!answer) return;
        answers[index] = answer;
        if ('pullRequest' in answer) {
          recordPullRequestLookup(request, answer.pullRequest, at);
          recorded = true;
        }
      });
      if (recorded) onRecord?.();
    }
    return answers.map((answer) => answer ?? { unavailable: 'the pull request lookup returned no answer' });
  };
}

/** A linked worktree whose pull request {@link worktreePullRequests} looks up. */
export interface WorktreeBranch {
  path: string;
  branch: string;
  repository: string;
}

/**
 * The pull request of each worktree's branch and HEAD, through {@link refreshPullRequests} with one GitHub call per
 * repository. The map holds null for a worktree without one, and leaves out a worktree whose HEAD git cannot read
 * or whose lookup was unavailable.
 */
export function worktreePullRequests(): (
  worktrees: readonly WorktreeBranch[],
) => Promise<Map<string, PullRequestFact | null>> {
  const refresh = refreshPullRequests({ maxAgeMs: PULL_REQUEST_MAX_AGE_MS, detail: true });
  return async (worktrees) => {
    const repos = new Map<string, PullRequestRequest[]>();
    for (const { path, branch, repository } of worktrees) {
      let head: string;
      try {
        head = (await gitAsync(path, ['rev-parse', 'HEAD'], { timeoutMs: 5000 })).trim();
      } catch {
        continue;
      }
      repos.set(repository, [...(repos.get(repository) ?? []), { path, cwd: path, branch, head }]);
    }
    const found = new Map<string, PullRequestFact | null>();
    for (const [repo, requests] of repos) {
      const results = await refresh(repo, requests);
      requests.forEach(({ path }, i) => {
        const result = results[i];
        if (result && 'pullRequest' in result) found.set(path, result.pullRequest);
      });
    }
    return found;
  };
}
