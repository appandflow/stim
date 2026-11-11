import { accessSync, constants, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AGENT_DRIVER_UNAVAILABLE, AgentDriverInvocation } from '@stim-cli/agent-driver';

const AGENT_DEVICE_BIN_ENV = 'STIM_AGENT_DEVICE_BIN';

const CANDIDATES = (home: string): string[] => [
  join(home, '.local', 'bin', 'agent-device'),
  '/opt/homebrew/bin/agent-device',
  '/usr/local/bin/agent-device',
];

const UNAVAILABLE: typeof AGENT_DRIVER_UNAVAILABLE = 'agent-driver-unavailable';

/**
 * Finds agent-device at a fixed path: the stim-server LaunchAgent's PATH holds only system directories, and
 * agent-device's `#!/usr/bin/env node` script cannot find Node there, so a JavaScript entry runs under the
 * server's own Node.
 */
export function resolveAgentDevice(env: NodeJS.ProcessEnv): AgentDriverInvocation {
  const explicit = env[AGENT_DEVICE_BIN_ENV]?.trim();
  const candidates = explicit ? [explicit] : CANDIDATES(env.HOME || homedir());
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      accessSync(real, constants.R_OK);
      return /\.(mjs|cjs|js)$/.test(real) ? { command: process.execPath, args: [real] } : { command: real, args: [] };
    } catch {}
  }
  throw Object.assign(
    new Error(
      explicit
        ? `${AGENT_DEVICE_BIN_ENV} names ${explicit}, which is not a readable agent-device on the hosting Mac.`
        : `agent-device is not installed on the hosting Mac (looked in ${candidates.join(', ')}). Install it with: npm install --global --prefix "$HOME/.local" agent-device`,
    ),
    { code: UNAVAILABLE },
  );
}
