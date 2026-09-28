import { agentLabel, agentsSummary } from '@/lib/agents';
import type { AgentSession } from '@/protocol/types';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const claude: AgentSession = {
  tool: 'claude-code',
  sessionId: 'a',
  cwd: '/w',
  title: 'Fix the login bug',
  lastActiveAt: '2026-09-28T11:55:00.000Z',
};
const codex: AgentSession = { tool: 'codex', sessionId: 'b', cwd: '/w' };

test('an agent label names the tool, the title when there is one and the activity age', () => {
  expect(agentLabel(claude, NOW)).toBe('Claude Code · Fix the login bug · 5m ago');
  expect(agentLabel(codex, NOW)).toBe('Codex');
});

test('the summary shows the most recent session and counts the others', () => {
  expect(agentsSummary(undefined, NOW)).toBeNull();
  expect(agentsSummary([claude], NOW)).toBe('Claude Code · Fix the login bug · 5m ago');
  expect(agentsSummary([claude, codex], NOW)).toBe('Claude Code · Fix the login bug · 5m ago +1');
});
