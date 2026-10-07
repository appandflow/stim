import { isJsonObject, readHostedAppMetadata, readHostedSessions } from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import { loadConfig } from '../workspace/config.ts';

export function hostedAgentDriverFinding(driver: unknown, apps: number): Finding | null {
  if (apps === 0 || (driver !== undefined && driver !== 'none')) return null;
  return {
    code: 'hosted-agent-driver',
    level: 'note',
    title: `${apps === 1 ? 'A hosted app runs' : `${apps} hosted apps run`} with no agent driver`,
    detail:
      "The client's coding agent cannot drive these apps because `hosting.agentDriver` is none, so stim-server starts no driver. agent-device confines macOS control to one macos-app lease and iOS or Android control to one device through its daemon policy.",
    fix: 'stim settings set hosting.agentDriver agent-device, with agent-device 0.21.22 or later',
  };
}

function runningHostedApps(): number {
  try {
    return readHostedSessions().filter((session) => {
      if (!['macos', 'ios', 'android'].includes(session.platform) || session.state !== 'ready' || !session.appAttempt)
        return false;
      try {
        return readHostedAppMetadata(session.id, session.appAttempt).state === 'installed';
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

/** Notes installed hosted apps on this Mac while `hosting.agentDriver` starts no driver. */
export function inspectHostedAgentDriver(): Finding | null {
  const hosting = loadConfig()?.hosting;
  return hostedAgentDriverFinding(isJsonObject(hosting) ? hosting.agentDriver : undefined, runningHostedApps());
}
