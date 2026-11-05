import fixture from '../../../desktop/Tests/StimKitTests/Fixtures/agent-sessions-vectors.json';

import { agentName, agentLabel, agentsSummary, agentWebUrl, workspaceAgentSessions } from '@/lib/agents';
import type { AgentSession, EndedAgentSession } from '@/protocol/types';

const vectors = fixture as unknown as {
  labels: { name: string; session: AgentSession; label: string }[];
  order: { name: string; agents?: AgentSession[]; endedAgents?: EndedAgentSession[]; ids: string[] }[];
};

const claude: AgentSession = { tool: 'claude-code', sessionId: 'a', cwd: '/w', title: 'Fix the login bug' };
const codex: AgentSession = { tool: 'codex', sessionId: 'b', cwd: '/w' };

describe('agentLabel', () => {
  it.each(vectors.labels.map((c) => [c.name, c] as const))('%s', (_, { session, label }) => {
    expect(agentLabel(session)).toBe(label);
  });
});

describe('workspaceAgentSessions', () => {
  it.each(vectors.order.map((c) => [c.name, c] as const))('%s', (_, { agents, endedAgents, ids }) => {
    expect(workspaceAgentSessions({ agents, endedAgents }).map((s) => `${s.tool}:${s.sessionId}`)).toEqual(ids);
  });
});

test('a session is named by its title, or by the tool without one', () => {
  expect(agentName(claude)).toBe('Fix the login bug');
  expect(agentName({ ...codex, title: '' })).toBe('Codex');
});

test('the summary shows the first session and counts the others', () => {
  expect(agentsSummary([])).toBeNull();
  expect(agentsSummary([claude, codex])).toBe('Claude Code \u00B7 Fix the login bug +1');
});

test('only an https web link opens a session from the phone', () => {
  const url = 'https://claude.ai/code/session_016mNVcEGnttEVda1aDtiDUK';
  expect(agentWebUrl({ ...claude, webUrl: url })).toBe(url);
  expect(agentWebUrl({ ...claude, openUrl: 'claude://code/continue?session=local_a' })).toBeNull();
  expect(agentWebUrl({ ...claude, webUrl: 'javascript:alert(1)' })).toBeNull();
});
