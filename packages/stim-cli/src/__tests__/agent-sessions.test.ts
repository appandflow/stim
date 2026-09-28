import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSessionsCacheFile, readWorkspaceState, type EnvironmentState } from '@stim-cli/core/state';
import {
  attributeAgentSessions,
  discoverAgentSessions,
  parseClaudeSession,
  parseCodexThreads,
  type AgentWorkspace,
} from '../agent-sessions.ts';
import { applyStatusMeasures } from '../status-measures.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';

const CLAUDE = JSON.parse(
  readFileSync(new URL('./fixtures/agent-sessions/claude-session.json', import.meta.url), 'utf-8'),
) as Record<string, unknown>;
const CODEX = JSON.parse(
  readFileSync(new URL('./fixtures/agent-sessions/codex-threads.json', import.meta.url), 'utf-8'),
) as Record<string, unknown>[];
const APPS = { claude: true, codex: true };
const NO_APPS = { claude: false, codex: false };

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-agent-sessions-')));
  process.env.STIM_HOME = join(home, 'stim');
});

afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('a Claude Code session file gives its id, cwd, name and times, and a desktop link only for a desktop session', () => {
  expect(parseClaudeSession(CLAUDE, APPS)).toEqual({
    tool: 'claude-code',
    sessionId: '0dc300cd-42a3-4758-8d35-79edf2904001',
    cwd: '/Users/dev/stim',
    title: 'Stim desktop app concept',
    startedAt: '2026-09-25T14:31:47.440Z',
    lastActiveAt: '2026-09-28T12:41:03.886Z',
    pid: 20606,
    openUrl: 'claude://code/continue?session=local_bb7da4e5-d1f7-4ba4-b2aa-8dd8021e39a7',
  });
  expect(parseClaudeSession(CLAUDE, NO_APPS)).not.toHaveProperty('openUrl');
  expect(parseClaudeSession({ ...CLAUDE, hostSessionId: undefined }, APPS)).not.toHaveProperty('openUrl');
  expect(parseClaudeSession({ ...CLAUDE, name: 'a\nb\tc'.padEnd(300, 'x') }, APPS)?.title).toBe(
    `a b c${'x'.repeat(112)}...`,
  );
  for (const broken of [{ pid: undefined }, { sessionId: 'a b' }, { cwd: 'relative/dir' }]) {
    expect(parseClaudeSession({ ...CLAUDE, ...broken }, APPS)).toBeNull();
  }
  expect(parseClaudeSession('not json', APPS)).toBeNull();
});

test('Codex threads use the short name, never the first prompt, and leave out subagent threads', () => {
  const rows = CODEX.map((row) => Object.assign({ title: 'the whole first prompt' }, row));
  expect(parseCodexThreads(rows, APPS)).toEqual([
    {
      tool: 'codex',
      sessionId: '01a0e5e1-d61b-73e0-b06f-48616fa98d92',
      cwd: '/Users/dev/stim-1743',
      title: 'Add agent sessions to status',
      startedAt: '2026-09-28T01:46:40.000Z',
      lastActiveAt: '2026-09-28T04:54:23.728Z',
      openUrl: 'codex://threads/01a0e5e1-d61b-73e0-b06f-48616fa98d92',
    },
    {
      tool: 'codex',
      sessionId: '01a0e5e3-0000-7000-8000-000000000002',
      cwd: '/Users/dev/other',
      startedAt: '2026-09-28T04:16:40.000Z',
      lastActiveAt: '2026-09-28T04:25:00.000Z',
      openUrl: 'codex://threads/01a0e5e3-0000-7000-8000-000000000002',
    },
  ]);
  expect(parseCodexThreads(rows, NO_APPS).some((session) => session.openUrl)).toBe(false);
  expect(parseCodexThreads({ rows }, APPS)).toEqual([]);
});

test('discovery keeps Claude sessions whose process runs and recent Codex threads, and nothing without their files', async () => {
  expect(await discoverAgentSessions({ home, apps: NO_APPS })).toEqual([]);

  const project = join(home, 'project');
  mkdirSync(project);
  const sessions = join(home, '.claude', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const now = Date.now();
  const write = (name: string, patch: Record<string, unknown>) =>
    writeFileSync(join(sessions, name), JSON.stringify({ ...CLAUDE, cwd: project, ...patch }));
  write('live.json', { pid: process.pid, sessionId: 'live', startedAt: now });
  write('exited.json', { pid: 4_194_000, sessionId: 'exited', startedAt: now });
  write('recycled.json', { pid: process.pid, sessionId: 'recycled', startedAt: now - 30 * 86_400_000 });
  writeFileSync(join(sessions, 'torn.json'), '{"pid": 1');

  const codexHome = join(home, '.codex');
  mkdirSync(codexHome);
  const { DatabaseSync } = await import('node:sqlite');
  for (const [name, updatedAt] of [
    ['state_4.sqlite', now],
    ['state_5.sqlite', now - 60 * 60_000],
  ] as const) {
    const db = new DatabaseSync(join(codexHome, name));
    db.exec(
      'CREATE TABLE threads (id TEXT, cwd TEXT, title TEXT, name TEXT, source TEXT, archived INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)',
    );
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(
      name,
      project,
      'prompt',
      'thread',
      'cli',
      updatedAt,
      updatedAt,
    );
    db.close();
  }

  const found = await discoverAgentSessions({ home, codexHome, apps: NO_APPS, now });
  expect(found.map(({ tool, sessionId, cwd }) => ({ tool, sessionId, cwd }))).toEqual([
    { tool: 'claude-code', sessionId: 'live', cwd: project },
  ]);

  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  db.prepare('UPDATE threads SET updated_at_ms = ?').run(now);
  db.close();
  const withCodex = await discoverAgentSessions({ home, codexHome, apps: NO_APPS, now });
  expect(withCodex.map(({ tool, sessionId, title }) => ({ tool, sessionId, title }))).toEqual([
    { tool: 'claude-code', sessionId: 'live', title: 'Stim desktop app concept' },
    { tool: 'codex', sessionId: 'state_5.sqlite', title: 'thread' },
  ]);
});

test('a session belongs to the deepest workspace holding its cwd and to the workspaces at its git root', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 8, 28, 12, minutes)).toISOString();
  const session = (sessionId: string, cwd: string, minutes: number) => ({
    tool: 'claude-code' as const,
    sessionId,
    cwd,
    lastActiveAt: at(minutes),
  });
  const workspaces: AgentWorkspace[] = [
    { path: '/repo', root: '/repo', recorded: null },
    { path: '/repo/apps/mobile', root: '/repo', recorded: null },
    { path: '/repo/.claude/worktrees/w', root: '/repo/.claude/worktrees/w', recorded: null },
    { path: '/repo-other', root: '/repo-other', recorded: null },
  ];
  const sessions = [
    session('root', '/repo', 1),
    session('mobile', '/repo/apps/mobile/src', 2),
    session('nested', '/repo/.claude/worktrees/w/apps', 3),
  ];
  const ids = attributeAgentSessions(workspaces, sessions, Date.parse(at(5))).map((agents) =>
    agents.map((agent) => agent.sessionId),
  );
  expect(ids).toEqual([['root'], ['mobile', 'root'], ['nested'], []]);
});

test('a workspace shows the session that ran its last command, with the running session details when found', () => {
  const now = Date.parse('2026-09-28T12:00:00.000Z');
  const recorded = {
    tool: 'claude-code' as const,
    sessionId: 'parent',
    cwd: '/work/w1',
    lastActiveAt: '2026-09-28T11:59:00.000Z',
  };
  const running = { ...recorded, cwd: '/repo', title: 'Parent', lastActiveAt: '2026-09-28T11:00:00.000Z' };
  const workspace = { path: '/work/w1', root: '/work/w1', recorded };
  expect(attributeAgentSessions([workspace], [running], now)).toEqual([
    [{ ...running, lastActiveAt: recorded.lastActiveAt }],
  ]);
  expect(attributeAgentSessions([workspace], [], now)).toEqual([[recorded]]);
  expect(attributeAgentSessions([workspace], [], now + 31 * 60_000)).toEqual([[]]);
});

test('a Stim command records the agent session of its shell, and status reads it with the cached sessions', () => {
  const project = join(home, 'project');
  mkdirSync(project);
  const environment = (): EnvironmentState => ({ path: project, live: false, memoryMb: 0, warnings: [], issues: [] });

  recordWorkspaceUse(project, new Date(), { CLAUDE_CODE_SESSION_ID: 'from-shell' });
  expect(readWorkspaceState(project)?.agentSession).toMatchObject({ tool: 'claude-code', sessionId: 'from-shell' });
  const cached = {
    tool: 'codex',
    sessionId: 'thread-1',
    cwd: join(project, 'src'),
    lastActiveAt: '2026-09-28T00:00:00Z',
  };
  mkdirSync(join(home, 'stim'), { recursive: true });
  const cache = (discoveredAt: string) =>
    writeFileSync(agentSessionsCacheFile(), JSON.stringify({ discoveredAt, sessions: [cached, { tool: 'other' }] }));

  cache(new Date().toISOString());
  const fresh = environment();
  applyStatusMeasures([fresh], []);
  expect(fresh.agents?.map((agent) => agent.sessionId)).toEqual(['from-shell', 'thread-1']);

  cache(new Date(Date.now() - 3 * 60_000).toISOString());
  recordWorkspaceUse(project, new Date(), {});
  const stale = environment();
  applyStatusMeasures([stale], []);
  expect(stale).not.toHaveProperty('agents');
  expect(readWorkspaceState(project)).not.toHaveProperty('agentSession');
});
