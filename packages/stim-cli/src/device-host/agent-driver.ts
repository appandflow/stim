import { isJsonObject, readHostedAppMetadata, readHostedSessions } from '@stim-cli/core/state';
import type { Finding } from '../diagnostics/doctor.ts';
import { loadConfig } from '../workspace/config.ts';

export function hostedAgentDriverFinding(driver: unknown, apps: number): Finding | null {
  if (apps === 0 || (driver !== undefined && driver !== 'none')) return null;
  return {
    code: 'hosted-agent-driver',
    level: 'note',
    title: `${apps === 1 ? 'A hosted macOS app runs' : `${apps} hosted macOS apps run`} with no agent driver`,
    detail:
      "The client's coding agent cannot drive these apps because `hosting.agentDriver` is none, so stim-server starts no driver. agent-device starts only once it can lease a single macOS app.",
    fix: 'stim settings set hosting.agentDriver agent-device, once agent-device can lease one macOS app',
  };
}

function runningHostedMacosApps(): number {
  try {
    return readHostedSessions().filter((session) => {
      if (session.platform !== 'macos' || session.state !== 'ready' || !session.appAttempt) return false;
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

/** Notes installed hosted macOS apps on this Mac while `hosting.agentDriver` starts no driver. */
export function inspectHostedAgentDriver(): Finding | null {
  const hosting = loadConfig()?.hosting;
  return hostedAgentDriverFinding(isJsonObject(hosting) ? hosting.agentDriver : undefined, runningHostedMacosApps());
}
