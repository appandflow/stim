import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENDED_AGENT_RETENTION_MS,
  readAgentSessionsCache,
  readDiskUsage,
  readEndedAgentSessions,
  readPullRequestCache,
  type EnvironmentState,
} from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { applyStatusMeasures, createStatusMeasurer } from '../status-measures.ts';
import { checkCounts } from '../workspace/pull-request.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';

const GRAPHQL = readFileSync(new URL('./fixtures/gh-pull-requests-graphql.json', import.meta.url), 'utf-8');
const HEAD = 'dcce0407269e492928e083695fd7b134e64e7af4';
const BRANCH = 'feat/1688-physical-device-tiles';

let home: string;
let app: string;
let avd: string;
let calls: { file: string; args: string[] }[];
let head: string;
let clock: number;
const realHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-status-measures-'));
  process.env.STIM_HOME = home;
  process.env.HOME = home;
  process.env.ANDROID_AVD_HOME = join(home, 'avd');
  app = join(home, 'app');
  avd = join(home, 'avd', 'stim-t.avd');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  mkdirSync(avd, { recursive: true });
  avd = realpathSync(avd);
  writeFileSync(join(home, 'avd', 'stim-t.ini'), `path=${avd}\n`);
  mkdirSync(workspaceDir(app), { recursive: true });
  calls = [];
  head = HEAD;
  clock = Date.parse('2026-09-27T10:00:00.000Z');
  const kilobytes: Record<string, number> = {
    [app]: 1000,
    [join(app, 'node_modules')]: 400,
    [workspaceDir(app)]: 200,
    [avd]: 3000,
  };
  const real = getExecutor();
  setExecutor({
    ...real,
    findExecutable: (name) => (name === 'gh' ? '/usr/bin/gh' : real.findExecutable(name)),
    runFileAsync: async (file, args = []) => {
      calls.push({ file, args });
      if (file === 'du') return `${kilobytes[args.at(-1)!]}\t${args.at(-1)}\n`;
      if (file === 'git') return `${head}\n`;
      if (file === 'gh') return GRAPHQL;
      throw new Error(`unexpected ${file}`);
    },
  });
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  delete process.env.ANDROID_AVD_HOME;
  rmSync(home, { recursive: true, force: true });
});

function environment(): EnvironmentState {
  return {
    path: app,
    live: true,
    memoryMb: 0,
    warnings: [],
    issues: [],
    worktree: {
      path: app,
      branch: BRANCH,
      repository: join(home, 'repo'),
      git: { changed: 0, untracked: 0, upstream: null, ahead: null, behind: null, mergedInto: null },
    },
    android: { name: 'stim-t', owned: true, physical: false },
  };
}

test('measures stale folders and pull requests in the background, then status reads only the caches', async () => {
  const updated = vi.fn<() => void>();
  const measurer = createStatusMeasurer({ updated, now: () => clock });
  const state = environment();
  measurer.schedule([state], [state.worktree!]);
  await vi.waitFor(() => {
    expect(readDiskUsage(avd)).not.toBeNull();
    expect(readPullRequestCache(app)).not.toBeNull();
  });

  const read = environment();
  applyStatusMeasures([read], [read.worktree!]);
  const measuredAt = '2026-09-27T10:00:00.000Z';
  expect(read.disk).toEqual({
    worktreeBytes: 1000 * 1024,
    nodeModulesBytes: 400 * 1024,
    buildBytes: 200 * 1024,
    measuredAt,
  });
  expect(read.android?.disk).toEqual({ bytes: 3000 * 1024, measuredAt });
  expect(read.worktree?.pullRequest).toEqual({
    number: 1692,
    url: 'https://github.com/appandflow/stim/pull/1692',
    title: 'feat(status): show leased physical devices as device tiles',
    state: 'open',
    checks: { passing: 10, failing: 0, pending: 0 },
    reviewDecision: null,
    checkedAt: measuredAt,
  });
  expect(calls.filter((call) => call.file === 'du')).toHaveLength(4);
  expect(calls.filter((call) => call.file === 'gh')).toHaveLength(1);
  expect(calls.filter((call) => call.file === 'git').map((call) => call.args.slice(0, 2))).toEqual([
    ['-C', join(home, 'repo')],
  ]);
  expect(updated).toHaveBeenCalled();

  calls = [];
  clock += 60_000;
  measurer.schedule([state], [state.worktree!]);
  await vi.waitFor(() => expect(calls.some((call) => call.file === 'git')).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls.map((call) => call.file)).toEqual(['git']);

  calls = [];
  clock += 60_000;
  head = 'f'.repeat(40);
  measurer.schedule([state], [state.worktree!]);
  await vi.waitFor(() => expect(readPullRequestCache(app)?.head).toBe(head));
  expect(calls.map((call) => call.file)).toEqual(['git', 'gh']);
});

test('a session that stops running stays listed as ended with its links for 3 days, and running again wins', async () => {
  clock = Date.now();
  const firstAt = new Date(clock).toISOString();
  const sessions = join(home, '.claude', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const claude = join(sessions, `${process.pid}.json`);
  const run = () =>
    writeFileSync(
      claude,
      JSON.stringify({
        pid: process.pid,
        sessionId: 'live',
        cwd: app,
        name: 'Fix tiles',
        startedAt: clock,
        bridgeSessionId: 'session_01abc',
      }),
    );
  const measurer = createStatusMeasurer({ updated: () => {}, now: () => clock });
  const discover = async (count: number) => {
    const before = readAgentSessionsCache()?.discoveredAt;
    const state = environment();
    measurer.schedule([state], [state.worktree!]);
    await vi.waitFor(() => {
      const cache = readAgentSessionsCache();
      expect(cache?.discoveredAt).not.toBe(before);
      expect(cache?.sessions).toHaveLength(count);
    });
  };
  const read = () => {
    const state = environment();
    applyStatusMeasures([state], []);
    return state;
  };

  run();
  recordWorkspaceUse(app, new Date(clock), { CLAUDE_CODE_SESSION_ID: 'live' });
  await discover(1);
  expect(read().agents?.map((agent) => agent.sessionId)).toEqual(['live']);
  expect(read().endedAgents).toBeUndefined();

  rmSync(claude);
  clock += 20_000;
  await discover(0);
  const ended = read();
  expect(ended.agents).toBeUndefined();
  expect(ended.endedAgents).toEqual([
    {
      tool: 'claude-code',
      sessionId: 'live',
      title: 'Fix tiles',
      cwd: realpathSync(app),
      startedAt: firstAt,
      lastActiveAt: firstAt,
      webUrl: 'https://claude.ai/code/session_01abc',
      endedAt: firstAt,
    },
  ]);
  expect(readEndedAgentSessions(app, Date.parse(firstAt) + ENDED_AGENT_RETENTION_MS + 1)).toEqual([]);

  run();
  clock += 20_000;
  await discover(1);
  const resumed = read();
  expect(resumed.agents?.map((agent) => agent.sessionId)).toEqual(['live']);
  expect(resumed.endedAgents).toBeUndefined();
});

test('a failed ended-session write keeps the cache for 2 minutes, so a later discovery records the session', async () => {
  clock = Date.now();
  const sessions = join(home, '.claude', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const claude = join(sessions, `${process.pid}.json`);
  const run = (sessionId: string) =>
    writeFileSync(claude, JSON.stringify({ pid: process.pid, sessionId, cwd: app, startedAt: clock }));
  const measurer = createStatusMeasurer({ updated: () => {}, now: () => clock });
  const discover = () => {
    const state = environment();
    measurer.schedule([state], [state.worktree!]);
  };
  const blocked = join(workspaceDir(app), 'ended-agents.json');
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'state_1.sqlite'), '');
  const failOnce = async () => {
    rmSync(blocked, { recursive: true, force: true });
    mkdirSync(join(blocked, 'keep'), { recursive: true });
    calls = [];
    discover();
    await vi.waitFor(() => expect(calls.some((call) => call.file === process.execPath)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 100));
  };

  run('first');
  discover();
  await vi.waitFor(() => expect(readAgentSessionsCache()?.sessions).toHaveLength(1));
  rmSync(claude);
  clock += 20_000;
  await failOnce();
  expect(readAgentSessionsCache()?.sessions.map((session) => session.sessionId)).toEqual(['first']);

  rmSync(blocked, { recursive: true });
  clock += 20_000;
  discover();
  await vi.waitFor(() =>
    expect(readEndedAgentSessions(app, clock).map((session) => session.sessionId)).toEqual(['first']),
  );
  expect(readAgentSessionsCache()?.sessions).toEqual([]);

  run('second');
  clock += 20_000;
  discover();
  await vi.waitFor(() => expect(readAgentSessionsCache()?.sessions).toHaveLength(1));
  rmSync(claude);
  clock += 3 * 60_000;
  await failOnce();
  await vi.waitFor(() => expect(readAgentSessionsCache()?.sessions).toEqual([]));
});

test('a missing gh leaves the pull request unknown', async () => {
  const real = getExecutor();
  setExecutor({ ...real, findExecutable: (name) => (name === 'gh' ? null : real.findExecutable(name)) });
  const measurer = createStatusMeasurer({ updated: () => {}, now: () => clock });
  const state = environment();
  measurer.schedule([state], [state.worktree!]);
  await vi.waitFor(() => expect(readDiskUsage(avd)).not.toBeNull());
  applyStatusMeasures([state], [state.worktree!]);
  expect(state.worktree).not.toHaveProperty('pullRequest');
  expect(calls.some((call) => call.file === 'gh')).toBe(false);
});

test('check counts sort every check run and commit status state into passing, failing or pending', () => {
  const counts = (states: [string, number][], statuses: [string, number][] = []) =>
    checkCounts({
      contexts: {
        checkRunCountsByState: states.map(([state, count]) => ({ state, count })),
        statusContextCountsByState: statuses.map(([state, count]) => ({ state, count })),
      },
    });
  expect(
    counts(
      [
        ['SUCCESS', 7],
        ['SKIPPED', 3],
        ['FAILURE', 1],
        ['TIMED_OUT', 1],
        ['IN_PROGRESS', 2],
        ['QUEUED', 1],
      ],
      [
        ['ERROR', 1],
        ['PENDING', 1],
        ['EXPECTED', 1],
      ],
    ),
  ).toEqual({ passing: 10, failing: 3, pending: 5 });
  expect(checkCounts(null)).toBeNull();
});
