import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { configDir } from '@stim-cli/core';
import { isJsonObject } from '@stim-cli/core/state';

// compat C23 until removal-minor
const PROBE_MS = 1500;

/** -1, 0 or 1 as `a` is below, equal to or above `b`; a prerelease is below its release. */
function compareVersions(a: string, b: string): number {
  const [coreA = '', preA] = a.split('-', 2);
  const [coreB = '', preB] = b.split('-', 2);
  const partsA = coreA.split('.').map(Number);
  const partsB = coreB.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return preA === undefined ? (preB === undefined ? 0 : 1) : preB === undefined ? -1 : 0;
}

function listener(port: number): Promise<string> {
  return new Promise((resolve) =>
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: PROBE_MS }, (_error, stdout) =>
      resolve(String(stdout).trim().split(/\s+/)[0] || 'unknown'),
    ),
  );
}

/**
 * Why the net thread stays off: an older stim-server, such as a Stim Desktop 0.x bundle, answers `/health` on
 * `port` with a version below `floor`. Null when nothing answers, it is not a stim-server, or `floor` is null.
 */
export async function legacyServerRefusal(port: number, floor: string | null): Promise<string | null> {
  if (floor === null) return null;
  let health: unknown;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(PROBE_MS) });
    health = await response.json();
  } catch {
    return null;
  }
  if (!isJsonObject(health) || health.server !== 'stim-server' || typeof health.version !== 'string') return null;
  if (compareVersions(health.version, floor) >= 0) return null;
  const home = configDir().replace(homedir(), '~');
  const pid = process.platform === 'win32' ? 'unknown' : await listener(port);
  return `stim-server ${health.version} (Stim Desktop bundle, pid ${pid}) holds port ${port}; update Stim Desktop (Stim > Check for Updates) or quit it. Phone, shares and remote builds for ${home} wait until then.`;
}
// compat end
