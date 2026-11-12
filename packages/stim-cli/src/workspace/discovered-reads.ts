import type { AgentSession } from '@stim-cli/core/state';
import { agentKey, attributeAgentSessions, discoverAgentSessions } from '../agent-sessions.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { processReader, type RunningProcesses } from './running-from.ts';

/** What one pass reads once for every checkout: the process table and the agent sessions. */
export interface DiscoveredReads {
  processes: () => Promise<RunningProcesses | null>;
  /** Why an agent session working in the path keeps it. */
  sessions: (path: string, now: number) => Promise<string[]>;
}

export function discoveredReads(signal?: AbortSignal): DiscoveredReads {
  let found: Promise<AgentSession[]> | undefined;
  return {
    processes: processReader(signal),
    sessions: async (path, now) => {
      found ??= discoverAgentSessions({ now });
      const sessions = await found;
      signal?.throwIfAborted();
      const canonical = canonicalPath(path);
      const [mine = []] = attributeAgentSessions([{ path: canonical, root: canonical, recorded: null }], sessions, now);
      return mine.map((session) => `an agent session (${agentKey(session)}) is working in it`);
    },
  };
}
