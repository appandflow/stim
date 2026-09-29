import { shortDuration } from '@/lib/format';
import type { AgentSession } from '@/protocol/types';

function toolName(tool: AgentSession['tool']): string {
  return tool === 'codex' ? 'Codex' : 'Claude Code';
}

function activityAge(agent: AgentSession, now: number): string | null {
  const at = Date.parse(agent.lastActiveAt ?? '');
  return Number.isFinite(at) ? `${shortDuration(Math.max(0, now - at))} ago` : null;
}

/** "Claude Code · Fix the login bug · 5m ago": the tool, the session's title when it has one, and its activity age. */
export function agentLabel(agent: AgentSession, now: number): string {
  return [toolName(agent.tool), agent.title, activityAge(agent, now)].filter(Boolean).join(' · ');
}

/** The session's title, or the tool when it has none, and its activity age, for a line too narrow for both. */
export function agentShortLabel(agent: AgentSession, now: number): { name: string; age: string | null } {
  const at = Date.parse(agent.lastActiveAt ?? '');
  return {
    name: agent.title || toolName(agent.tool),
    age: Number.isFinite(at) ? shortDuration(Math.max(0, now - at)) : null,
  };
}

/** The most recently active session's label, with how many others work in the workspace. */
export function agentsSummary(agents: AgentSession[] | undefined, now: number): string | null {
  const [first, ...rest] = agents ?? [];
  if (!first) return null;
  return rest.length ? `${agentLabel(first, now)} +${rest.length}` : agentLabel(first, now);
}

/** The session's https link for other devices, which opens it in the Claude app or a browser; any other scheme is ignored. */
export function agentWebUrl(agent: AgentSession): string | null {
  return agent.webUrl?.startsWith('https://') ? agent.webUrl : null;
}
