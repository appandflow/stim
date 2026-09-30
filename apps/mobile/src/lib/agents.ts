import { shortDuration } from '@/lib/format';
import type { AgentSession, EndedAgentSession } from '@/protocol/types';

function toolName(tool: AgentSession['tool']): string {
  return tool === 'codex' ? 'Codex' : 'Claude Code';
}

/** A running session or one that ended; only an ended one carries `endedAt`. */
export type AnyAgentSession = AgentSession | EndedAgentSession;

export function isEndedAgent(agent: AnyAgentSession): agent is EndedAgentSession {
  return 'endedAt' in agent && typeof agent.endedAt === 'string';
}

function activityAge(agent: AnyAgentSession, now: number): string | null {
  const at = Date.parse((isEndedAgent(agent) ? agent.endedAt : agent.lastActiveAt) ?? '');
  return Number.isFinite(at) ? shortDuration(Math.max(0, now - at)) : null;
}

/** The tool, the session's title when it has one, and its activity or end age, joined by middle dots. */
export function agentLabel(agent: AnyAgentSession, now: number): string {
  const age = activityAge(agent, now);
  const when = age ? `${isEndedAgent(agent) ? 'ended ' : ''}${age} ago` : isEndedAgent(agent) ? 'ended' : null;
  return [toolName(agent.tool), agent.title, when].filter(Boolean).join(' \u00B7 ');
}

/** The session's title, or the tool when it has none, and its activity or end age, for a line too narrow for both. */
export function agentShortLabel(agent: AnyAgentSession, now: number): { name: string; age: string | null } {
  return { name: agent.title || toolName(agent.tool), age: activityAge(agent, now) };
}

/** The most recently active session's label, with how many others work in the workspace. */
export function agentsSummary(agents: AgentSession[] | undefined, now: number): string | null {
  const [first, ...rest] = agents ?? [];
  if (!first) return null;
  return rest.length ? `${agentLabel(first, now)} +${rest.length}` : agentLabel(first, now);
}

/** The session's https link for other devices, which opens it in the Claude app or a browser; any other scheme is ignored. */
export function agentWebUrl(agent: AnyAgentSession): string | null {
  return agent.webUrl?.startsWith('https://') ? agent.webUrl : null;
}
