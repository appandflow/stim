import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import type { PeerIdentity } from './registry.ts';

const MAC_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const TIMEOUT_MS = 3000;

/** The tailnet-only HTTPS port the setup command serves stim-server on. */
const SERVE_PORT = 7443;

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

/**
 * How the node's `tailscale serve` config reaches stim-server's loopback port: `routed` on a
 * tailnet-only HTTPS port, `funneled` when a route to it is on a Funnel port and so public,
 * `missing` with the free port the setup command would use, or `unknown` when the config was
 * unreadable.
 */
export type ServeRoute =
  | { state: 'routed'; port: number }
  | { state: 'funneled'; ports: number[]; port: number }
  | { state: 'missing'; port: number }
  | { state: 'unknown'; reason: string; port: number };

function reaches(address: unknown, target: number, hosts: Set<string>): URL | null {
  if (typeof address !== 'string') return null;
  let url: URL;
  try {
    url = new URL(address.includes('://') ? address : `tcp://${address}`);
  } catch {
    return null;
  }
  return hosts.has(url.hostname) && url.port === String(target) ? url : null;
}

function portOf(hostPort: string): number {
  return Number(hostPort.slice(hostPort.lastIndexOf(':') + 1));
}

/**
 * Reads `tailscale serve status --json`, an ipn.ServeConfig: `TCP` maps a port to `{ HTTPS }` or
 * `{ TCPForward }`, `Web` maps `<host>:<port>` to `{ Handlers: { <mount>: { Proxy } } }`,
 * `AllowFunnel` maps `<host>:<port>` to true, and `Foreground` holds the same shape per
 * foreground session. Any handler or TCP forward that reaches the server on a Funnel port exposes
 * it; only a `/` HTTP proxy on an HTTPS port is a route a client can use.
 */
function parseServeStatus(value: unknown, target: number, ips: string[]): ServeRoute {
  if (!isJsonObject(value)) return { state: 'unknown', reason: 'it printed no serve config', port: SERVE_PORT };
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]', ...ips.map((ip) => (ip.includes(':') ? `[${ip}]` : ip))]);
  const configs = [value, ...(isJsonObject(value.Foreground) ? Object.values(value.Foreground) : [])].filter(
    isJsonObject,
  );
  const used = new Set<number>();
  const funneled = new Set<number>();
  const reaching = new Set<number>();
  const routes = new Set<number>();
  for (const config of configs) {
    const tcp = isJsonObject(config.TCP) ? config.TCP : {};
    for (const [port, listener] of Object.entries(tcp)) {
      used.add(Number(port));
      if (isJsonObject(listener) && reaches(listener.TCPForward, target, hosts)) reaching.add(Number(port));
    }
    for (const [hostPort, allowed] of Object.entries(isJsonObject(config.AllowFunnel) ? config.AllowFunnel : {})) {
      if (allowed === true) funneled.add(portOf(hostPort));
    }
    for (const [hostPort, web] of Object.entries(isJsonObject(config.Web) ? config.Web : {})) {
      const port = portOf(hostPort);
      const listener = tcp[String(port)];
      const https = isJsonObject(listener) && listener.HTTPS === true;
      const handlers = isJsonObject(web) && isJsonObject(web.Handlers) ? web.Handlers : {};
      for (const [mount, handler] of Object.entries(handlers)) {
        const url = isJsonObject(handler) ? reaches(handler.Proxy, target, hosts) : null;
        if (!url) continue;
        reaching.add(port);
        if (https && mount === '/' && url.protocol === 'http:' && url.pathname === '/') routes.add(port);
      }
    }
  }
  let free = SERVE_PORT;
  while (used.has(free) || funneled.has(free)) free++;
  const exposed = [...reaching].filter((port) => funneled.has(port)).toSorted((a, b) => a - b);
  if (exposed.length) return { state: 'funneled', ports: exposed, port: free };
  const tailnet = [...routes].toSorted((a, b) => a - b);
  if (tailnet.length) return { state: 'routed', port: tailnet.includes(SERVE_PORT) ? SERVE_PORT : tailnet[0]! };
  return { state: 'missing', port: free };
}

export function serveRoute(
  binary: string | null,
  env: NodeJS.ProcessEnv,
  target: number,
  ips: string[],
  timeoutMs: number = TIMEOUT_MS,
): Promise<ServeRoute> {
  if (!binary)
    return Promise.resolve({ state: 'unknown', reason: 'the tailscale command was not found', port: SERVE_PORT });
  return new Promise((resolve) => {
    execFile(binary, ['serve', 'status', '--json'], { env, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
      let route: ServeRoute;
      try {
        route = error
          ? {
              state: 'unknown',
              reason: error.killed ? 'it timed out' : error.message.split('\n')[0]!,
              port: SERVE_PORT,
            }
          : parseServeStatus(stdout.trim() ? JSON.parse(stdout) : {}, target, ips);
      } catch {
        route = { state: 'unknown', reason: 'it printed output that is not JSON', port: SERVE_PORT };
      }
      resolve(route);
    });
  });
}

export function tailnetEndpoint(dnsName: string, port: number): string {
  return port === 443 ? `wss://${dnsName}` : `wss://${dnsName}:${port}`;
}

export function serveCommand(port: number, target: number): string {
  return `tailscale serve --bg --https=${port} http://127.0.0.1:${target}`;
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
