import { workspaceId } from '@stim-cli/core';
import type { HostedAgentAccess } from '@stim-cli/core/state';

/**
 * The default agent-device session for a hosted device or app. agent-device keeps one saved remote connection per
 * name for the whole machine, so the name carries the workspace id.
 */
export function hostedAgentSessionName(root: string, platform: 'ios' | 'android' | 'macos', slot: string): string {
  return `stim-${slot}-${platform}-${workspaceId(root).slice(0, 8)}`;
}

export function hostedAgentLine(agent: HostedAgentAccess, machine: string): string {
  return 'command' in agent
    ? agent.command
    : `Agent control is unavailable on ${machine}. On that machine, check \`hosting.agentDriver\` (\`agent-device\` enables it) and the installed agent-device version.`;
}
