import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LABEL_VARIABLE, parseInstalledPlist, parseUnit, type InstalledService } from '@stim-cli/core/state';
import { validateLabel } from '@stim-cli/server/service-plist';
import { getExecutor } from '../exec.ts';

const PLUTIL_TIMEOUT_MS = 5_000;

function installedUnit(label: string, platform: NodeJS.Platform): InstalledService | null {
  if (platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (!existsSync(plist)) return null;
    const json = getExecutor().runFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
      timeoutMs: PLUTIL_TIMEOUT_MS,
    });
    return parseInstalledPlist(JSON.parse(json));
  }
  const unit = join(homedir(), '.config', 'systemd', 'user', `${label}.service`);
  return existsSync(unit) ? parseUnit(readFileSync(unit, 'utf8')) : null;
}

/**
 * Whether a unit `stim service install` wrote for `port` started this process. launchd names the job a process runs in
 * `XPC_SERVICE_NAME`, and a systemd unit that install wrote sets `STIM_SERVICE_LABEL`; Task Scheduler gives none.
 */
export function startedByServiceUnit(
  env: NodeJS.ProcessEnv,
  port: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const label = platform === 'darwin' ? env.XPC_SERVICE_NAME : platform === 'linux' ? env[LABEL_VARIABLE] : undefined;
  if (!label || validateLabel(label)) return false;
  try {
    const installed = installedUnit(label, platform);
    return installed?.managed === true && installed.label === label && installed.port === port;
  } catch {
    return false;
  }
}
