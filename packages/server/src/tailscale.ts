import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import type { PeerIdentity } from './registry.ts';

const MAC_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const TIMEOUT_MS = 3000;

export type TailscaleState =
  | { state: 'running'; ips: string[]; dnsName: string | null; hostName: string | null }
  | { state: 'not-running'; backendState: string }
  | { state: 'unavailable'; reason: string };

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findTailscale(env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && executable(join(dir, 'tailscale'))) return join(dir, 'tailscale');
  }
  return executable(MAC_APP_BINARY) ? MAC_APP_BINARY : null;
}

function parseTailscaleStatus(value: unknown): TailscaleState {
  if (!isJsonObject(value) || typeof value.BackendState !== 'string')
    return { state: 'unavailable', reason: '`tailscale status --json` printed no BackendState' };
  if (value.BackendState !== 'Running') return { state: 'not-running', backendState: value.BackendState };
  const self = isJsonObject(value.Self) ? value.Self : {};
  const ips = Array.isArray(value.TailscaleIPs) ? value.TailscaleIPs.filter((ip) => typeof ip === 'string') : [];
  const dnsName = typeof self.DNSName === 'string' && self.DNSName ? self.DNSName.replace(/\.$/, '') : null;
  const hostName = typeof self.HostName === 'string' && self.HostName ? self.HostName : null;
  return { state: 'running', ips, dnsName, hostName };
}

export function tailscaleStatus(binary: string | null, env: NodeJS.ProcessEnv): TailscaleState {
  if (!binary) return { state: 'unavailable', reason: 'the tailscale command was not found' };
  try {
    const output = execFileSync(binary, ['status', '--json'], {
      env,
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseTailscaleStatus(JSON.parse(output));
  } catch (error) {
    return { state: 'unavailable', reason: `\`tailscale status --json\` failed: ${(error as Error).message}` };
  }
}

/** Reads `tailscale whois --json`: the peer's node (`Node.StableID`, `Node.Name`) and user (`UserProfile.LoginName`). */
function parseWhois(value: unknown): PeerIdentity | null {
  if (!isJsonObject(value) || !isJsonObject(value.Node)) return null;
  const { StableID, Name } = value.Node;
  const login = isJsonObject(value.UserProfile) ? value.UserProfile.LoginName : undefined;
  if (typeof StableID !== 'string' || !StableID) return null;
  return {
    kind: 'tailnet',
    nodeId: StableID,
    nodeName: typeof Name === 'string' ? Name.replace(/\.$/, '') : '',
    user: typeof login === 'string' ? login : '',
  };
}

export function whois(binary: string | null, env: NodeJS.ProcessEnv, ip: string): Promise<PeerIdentity | null> {
  if (!binary) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(binary, ['whois', '--json', ip], { env, timeout: TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(parseWhois(JSON.parse(stdout)));
      } catch {
        resolve(null);
      }
    });
  });
}
