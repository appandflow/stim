import type { AgentSession } from '@stim-cli/core/state';
import { agentKey, attributeAgentSessions, discoverAgentSessions } from '../agent-sessions.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { freshLaunchers, launchersOf, type LauncherScan } from './launchers.ts';
import { processReader, type RunningProcesses } from './running-from.ts';
import type { StimContext } from '@stim-cli/core';

/** What one pass reads once for every checkout: the process table and the agent sessions. */
export interface DiscoveredReads {
  processes: () => Promise<RunningProcesses | null>;
  /** Where the executables on PATH that are symlinks resolve to, and what could not be read. */
  launchers: () => Promise<LauncherScan>;
  /** Why an agent session working in the path keeps it. */
  sessions: (path: string, now: number) => Promise<string[]>;
}

/** `fresh` reads the launcher directories anew, for the check that immediately precedes a deletion. */
export function discoveredReads(signal?: AbortSignal, operation?: StimContext, fresh = false): DiscoveredReads {
  let found: Promise<AgentSession[]> | undefined;
  return {
    processes: processReader(signal),
    launchers: fresh ? freshLaunchers(operation, signal) : launchersOf(operation, signal),
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
