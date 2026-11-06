import { workspaceId } from '@stim-cli/core';
import type { HostedAgentAccess } from '@stim-cli/core/state';

/**
 * The agent-device session `stim agent-device` uses for a hosted device when the agent names none. agent-device keeps
 * one saved remote connection per name for the whole machine, so the name carries the workspace id.
 */
export function hostedAgentSessionName(root: string, platform: 'ios' | 'android', slot: string): string {
  return `stim-${slot}-${platform}-${workspaceId(root).slice(0, 8)}`;
}

export function hostedAgentLine(agent: HostedAgentAccess, machine: string): string {
  return 'command' in agent
    ? agent.command
    : `Agent control is unavailable on ${machine}. On that machine, check \`hosting.agentDriver\` (\`agent-device\` enables it) and the installed agent-device version.`;
}
