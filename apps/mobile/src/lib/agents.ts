import { t } from '@lingui/core/macro';

import type { AgentSession, EnvironmentState } from '@/protocol/types';

/** The tool's product name; a tool this app does not know is shown by its raw name. */
export function toolName(tool: string): string {
  return tool === 'codex' ? t`Codex` : tool === 'claude-code' ? t`Claude Code` : tool;
}

const startedAtOf = (agent: AgentSession) => {
  const at = Date.parse(agent.startedAt ?? '');
  return Number.isFinite(at) ? at : Infinity;
};
const keyOf = (agent: AgentSession) => `${agent.tool}:${agent.sessionId}`;

/**
 * The workspace's agent sessions, running or ended, earliest started first, so the first is the session that created or
 * first worked in the workspace and stays first as processes start and stop. Sessions without `startedAt` follow, in
 * `tool:sessionId` order. Stim Desktop's `AgentSession.associated` holds the same rule; both replay
 * apps/desktop/Tests/StimKitTests/Fixtures/agent-sessions-vectors.json.
 */
export function workspaceAgentSessions(env: Pick<EnvironmentState, 'agents' | 'endedAgents'>): AgentSession[] {
  return [...(env.agents ?? []), ...(env.endedAgents ?? [])].sort(
    (a, b) => startedAtOf(a) - startedAtOf(b) || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0),
  );
}

/** The tool and the session's title when it has one, joined by a middle dot. */
export function agentLabel(agent: AgentSession): string {
  return [toolName(agent.tool), agent.title].filter(Boolean).join(' \u00B7 ');
}

/** The session's title, or the tool when it has none, for a line too narrow for both. */
export function agentName(agent: AgentSession): string {
  return agent.title || toolName(agent.tool);
}

/** The workspace's session's label, with how many other sessions it has. */
export function agentsSummary(sessions: AgentSession[]): string | null {
  const [first, ...rest] = sessions;
  if (!first) return null;
  const label = agentLabel(first);
  const others = rest.length;
  return others ? t`${label} +${others}` : label;
}

/** The session's https link for other devices, which opens it in the Claude app or a browser; any other scheme is ignored. */
export function agentWebUrl(agent: AgentSession): string | null {
  return agent.webUrl?.startsWith('https://') ? agent.webUrl : null;
}
