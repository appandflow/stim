import { shortDuration } from '@/lib/format';
import type { AgentSession } from '@/protocol/types';

function toolName(tool: AgentSession['tool']): string {
  return tool === 'codex' ? 'Codex' : 'Claude Code';
}

/** "Claude Code · Fix the login bug · 5m ago": the tool, the session's title when it has one, and its activity age. */
export function agentLabel(agent: AgentSession, now: number): string {
  const at = Date.parse(agent.lastActiveAt ?? '');
  const age = Number.isFinite(at) ? `${shortDuration(Math.max(0, now - at))} ago` : null;
  return [toolName(agent.tool), agent.title, age].filter(Boolean).join(' · ');
}

/** The most recently active session's label, with how many others work in the workspace. */
export function agentsSummary(agents: AgentSession[] | undefined, now: number): string | null {
  const [first, ...rest] = agents ?? [];
  if (!first) return null;
  return rest.length ? `${agentLabel(first, now)} +${rest.length}` : agentLabel(first, now);
}
