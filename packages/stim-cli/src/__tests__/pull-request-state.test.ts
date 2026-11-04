import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullRequestCacheDir, pullRequestCacheFile, readPullRequestCache } from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { cachedPullRequest, refreshPullRequests, worktreePullRequests } from '../pull-request-state.ts';

const HEAD = 'a'.repeat(40);
const MAX_AGE = 5 * 60_000;

let home: string;
let gh: { repo: string | undefined; branches: string[]; detail: boolean }[];
let installed: boolean;
let failure: Record<string, unknown> | null;
let clock: number;

function node(number: number, head: string, detail: boolean): Record<string, unknown> {
  return {
    number,
    state: 'OPEN',
    url: `https://github.com/o/r/pull/${number}`,
    headRefOid: head,
    mergedAt: null,
    closedAt: null,
    isCrossRepository: false,
    isDraft: false,
    ...(detail ? { title: `PR ${number}`, reviewDecision: null, commits: { nodes: [] } } : {}),
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-pull-request-state-'));
  process.env.STIM_HOME = home;
  gh = [];
  installed = true;
  failure = null;
  clock = Date.parse('2026-11-04T10:00:00.000Z');
  const real = getExecutor();
  setExecutor({
    ...real,
    findExecutable: (name) => (name === 'gh' ? (installed ? '/usr/bin/gh' : null) : real.findExecutable(name)),
    runFileAsync: async (file, args: string[] = [], opts) => {
      if (file === 'git') return args.includes('rev-parse') ? `${HEAD}\n` : '';
      if (file !== 'gh') throw new Error(`unexpected ${file}`);
      const branches = args.filter((arg) => arg.startsWith('b')).map((arg) => arg.slice(arg.indexOf('=') + 1));
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      const detail = query.includes('statusCheckRollup');
      gh.push({ repo: opts?.cwd, branches, detail });
      if (failure) throw Object.assign(new Error('gh failed'), failure);
      const repository = Object.fromEntries(
        branches.map((_, i) => [`b${i}`, { nodes: [node(100 + i, HEAD, detail)] }]),
      );
      return JSON.stringify({ data: { repository } });
    },
  });
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

const request = (name: string, head = HEAD) => ({ path: join(home, name), cwd: join(home, name), branch: name, head });
const now = () => clock;

test('a lookup younger than maxAgeMs is answered from the cache without asking GitHub', async () => {
  const refresh = refreshPullRequests({ maxAgeMs: MAX_AGE, now });
  const first = await refresh('/repo', [request('one')]);
  expect(first).toEqual([{ pullRequest: expect.objectContaining({ number: 100, state: 'open', containsHead: true }) }]);
  expect(gh).toHaveLength(1);

  clock += MAX_AGE - 1;
  expect(await refreshPullRequests({ maxAgeMs: MAX_AGE, now })('/repo', [request('one')])).toEqual(first);
  expect(gh).toHaveLength(1);
});

test('a stale lookup, one dated in the future, or one for another HEAD asks GitHub again and rewrites the cache', async () => {
  const refresh = refreshPullRequests({ maxAgeMs: MAX_AGE, now });
  await refresh('/repo', [request('one')]);
  clock += MAX_AGE;
  await refresh('/repo', [request('one')]);
  expect(gh).toHaveLength(2);
  expect(readPullRequestCache(request('one').path)?.checkedAt).toBe(new Date(clock).toISOString());

  clock -= 1000;
  await refresh('/repo', [request('one')]);
  expect(gh).toHaveLength(3);

  await refresh('/repo', [request('one', 'b'.repeat(40))]);
  expect(gh).toHaveLength(4);
  expect(readPullRequestCache(request('one').path)?.head).toBe('b'.repeat(40));
});

test('one call per repository asks only for the requests the cache cannot answer', async () => {
  const refresh = refreshPullRequests({ maxAgeMs: MAX_AGE, now });
  await refresh('/repo', [request('one')]);
  const results = await refresh('/repo', [request('one'), request('two')]);
  expect(gh.map((call) => call.branches)).toEqual([['one'], ['two']]);
  expect(results.map((result) => ('pullRequest' in result ? result.pullRequest?.number : null))).toEqual([100, 100]);
});

test('a lookup made without detail is stale only for a caller that wants detail', async () => {
  await refreshPullRequests({ maxAgeMs: MAX_AGE, now })('/repo', [request('one')]);
  expect(readPullRequestCache(request('one').path)?.partial).toBe(true);
  expect(cachedPullRequest(request('one'), { maxAgeMs: MAX_AGE, now })).not.toBeNull();
  expect(cachedPullRequest(request('one'), { maxAgeMs: MAX_AGE, detail: true, now })).toBeNull();

  await refreshPullRequests({ maxAgeMs: MAX_AGE, detail: true, now })('/repo', [request('one')]);
  expect(gh.map((call) => call.detail)).toEqual([false, true]);
  expect(readPullRequestCache(request('one').path)).toMatchObject({ pullRequest: { title: 'PR 100' } });
  expect(cachedPullRequest(request('one'), { maxAgeMs: MAX_AGE, detail: true, now })).not.toBeNull();
});

test('a cache entry that does not say whether the pull request contains HEAD is not an answer', () => {
  const { path } = request('one');
  const checkedAt = new Date(clock).toISOString();
  const pullRequest = { number: 7, url: 'u', title: 't', state: 'open', checks: null, reviewDecision: null, checkedAt };
  mkdirSync(pullRequestCacheDir(), { recursive: true });
  writeFileSync(
    pullRequestCacheFile(path),
    JSON.stringify({ path, branch: 'one', head: HEAD, checkedAt, pullRequest }),
  );
  expect(cachedPullRequest(request('one'), { maxAgeMs: MAX_AGE, now })).toBeNull();
});

test('without gh every request is unavailable and a stale cached verdict is not used in its place', async () => {
  await refreshPullRequests({ maxAgeMs: MAX_AGE, now })('/repo', [request('one')]);
  installed = false;
  clock += MAX_AGE;
  const results = await refreshPullRequests({ maxAgeMs: MAX_AGE, now })('/repo', [request('one'), request('two')]);
  expect(results).toEqual([{ unavailable: 'gh is not installed' }, { unavailable: 'gh is not installed' }]);
  expect(gh).toHaveLength(1);
  expect(readPullRequestCache(request('one').path)?.checkedAt).not.toBe(new Date(clock).toISOString());
});

test('a failing gh makes only that repository unavailable and records nothing', async () => {
  const refresh = refreshPullRequests({ maxAgeMs: 0, now });
  failure = { status: 1, stderr: 'HTTP 502' };
  expect(await refresh('/one', [request('a')])).toEqual([{ unavailable: 'gh api graphql failed: HTTP 502' }]);
  failure = null;
  expect(await refresh('/two', [request('b')])).toEqual([{ pullRequest: expect.objectContaining({ number: 100 }) }]);
  expect(readPullRequestCache(request('a').path)).toBeNull();
  expect(gh.map((call) => call.repo)).toEqual(['/one', '/two']);
});

test('a rate limit stops every later repository from asking GitHub through the same refresh', async () => {
  const refresh = refreshPullRequests({ maxAgeMs: 0, now });
  failure = { status: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' };
  const [limited] = await refresh('/one', [request('a')]);
  expect(limited).toEqual({ unavailable: expect.stringMatching(/rate limited/) });
  failure = null;
  expect(await refresh('/two', [request('b')])).toEqual([limited]);
  expect(gh).toHaveLength(1);
});

test('worktreePullRequests answers from the cache another caller filled and leaves out an unavailable worktree', async () => {
  const worktrees = [
    { path: request('a').path, branch: 'a', repository: '/repo' },
    { path: request('b').path, branch: 'b', repository: '/repo' },
  ];
  await refreshPullRequests({ maxAgeMs: MAX_AGE, detail: true, now })('/repo', [request('a')]);
  vi.useFakeTimers({ toFake: ['Date'], now: clock });
  const found = await worktreePullRequests()(worktrees);
  expect([...found.keys()]).toEqual(worktrees.map((worktree) => worktree.path));
  expect(gh.map((call) => call.branches)).toEqual([['a'], ['b']]);
  failure = { status: 4 };
  vi.setSystemTime(clock + MAX_AGE);
  expect([...(await worktreePullRequests()(worktrees)).keys()]).toEqual([]);
});
