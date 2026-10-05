import type { ConnectionOptions } from 'node:tls';
import { WebSocket, type ClientOptions } from 'ws';
import { isJsonObject } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';

const DEFAULT_SERVE_PORT = 7443;
const MAC_APP_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const HELLO_TIMEOUT_MS = 10_000;

export interface TailnetPeer {
  nodeId: string;
  dnsName: string;
  /** A tailnet address of the node; WireGuard delivers packets to it only from that node. */
  address: string;
}

export type HelloReply =
  | {
      result: {
        capabilities: string[];
        device: { id: string; name: string };
        deviceToken?: string;
        approval?: { state: 'pending'; expiresAt: string };
      };
    }
  | { error: { code: string; message: string } }
  | { failed: string };

export interface TailnetMachineIo {
  /** `tailscale status --json`, or null when Tailscale is not running. */
  status: () => unknown;
  hello: (endpoint: Endpoint, auth: Record<string, string>) => Promise<HelloReply>;
}

export function parseMachine(entry: string): { name: string; port: number } | null {
  const match = /^([A-Za-z0-9][A-Za-z0-9.-]*?)(?::(\d{1,5}))?$/.exec(entry.trim());
  if (!match) return null;
  const port = match[2] === undefined ? DEFAULT_SERVE_PORT : Number(match[2]);
  return port >= 1 && port <= 65535 ? { name: match[1]!.toLowerCase(), port } : null;
}

/**
 * The one peer in `tailscale status --json` whose MagicDNS name is `name` or starts with `name.`. `ID` there is
 * the node's StableID, the same value `tailscale whois` reports as `Node.StableID`.
 */
export function findPeer(status: unknown, name: string): TailnetPeer | 'missing' | 'ambiguous' {
  const peers = isJsonObject(status) && isJsonObject(status.Peer) ? Object.values(status.Peer) : [];
  const found = peers.flatMap((peer) => {
    if (!isJsonObject(peer) || typeof peer.ID !== 'string' || typeof peer.DNSName !== 'string') return [];
    const dnsName = peer.DNSName.replace(/\.$/, '').toLowerCase();
    const addresses = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.filter((ip) => typeof ip === 'string') : [];
    const address = addresses.find((ip) => !ip.includes(':')) ?? addresses[0];
    if (!address || !(dnsName === name || dnsName.startsWith(`${name}.`))) return [];
    return [{ nodeId: peer.ID, dnsName, address }];
  });
  if (found.length === 0) return 'missing';
  return found.length === 1 ? found[0]! : 'ambiguous';
}

export interface Endpoint {
  url: string;
  servername: string;
  host: string;
}

/**
 * Connects to the pinned node's own tailnet address rather than resolving its name, so the socket reaches the
 * node whose ID was just checked. `tailscale serve` still needs the MagicDNS name for TLS (SNI and certificate)
 * and for its Host routing.
 */
export function endpoint(peer: TailnetPeer, port: number): Endpoint {
  const address = peer.address.includes(':') ? `[${peer.address}]` : peer.address;
  const suffix = port === 443 ? '' : `:${port}`;
  return { url: `wss://${address}${suffix}`, servername: peer.dnsName, host: `${peer.dnsName}${suffix}` };
}

function tailscaleStatus(): unknown {
  for (const binary of ['tailscale', MAC_APP_TAILSCALE]) {
    const output = getExecutor().runFileQuiet(binary, ['status', '--json'], { timeoutMs: 5000 });
    if (output === null) continue;
    try {
      const status = JSON.parse(output) as unknown;
      return isJsonObject(status) && status.BackendState === 'Running' ? status : null;
    } catch {
      return null;
    }
  }
  return null;
}

function hello({ url, servername, host }: Endpoint, auth: Record<string, string>): Promise<HelloReply> {
  return new Promise((resolve) => {
    const options: ClientOptions & ConnectionOptions = {
      handshakeTimeout: HELLO_TIMEOUT_MS,
      servername,
      headers: { Host: host },
    };
    const socket = new WebSocket(url, options);
    const done = (reply: HelloReply) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.close();
      resolve(reply);
    };
    const timer = setTimeout(() => done({ failed: 'no reply in time' }), HELLO_TIMEOUT_MS);
    socket.on('open', () => {
      const client = { name: 'stim', version: '1' };
      socket.send(JSON.stringify({ id: 1, method: 'hello', params: { protocol: 1, client, auth } }));
    });
    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(String(data));
      } catch {
        message = null;
      }
      if (isJsonObject(message) && ('result' in message || 'error' in message)) return done(message as HelloReply);
      done({ failed: 'the reply was not a hello result' });
    });
    socket.on('error', (error) => done({ failed: error.message }));
    socket.on('close', () => done({ failed: 'the connection closed before a reply' }));
  });
}

export const realIo: TailnetMachineIo = { status: tailscaleStatus, hello };

/**
 * The endpoint of a paired machine's pinned node, or why Stim does not connect to it. The name must still
 * resolve to exactly the pinned node; the token is never sent anywhere else.
 */
export function pinnedEndpoint(
  credential: { machine: string; nodeId: string },
  status: () => unknown = tailscaleStatus,
): Endpoint | string {
  const parsed = parseMachine(credential.machine);
  if (!parsed) return `${credential.machine} is not a tailnet name`;
  const current = status();
  if (!isJsonObject(current)) return 'Tailscale is not running';
  const peer = findPeer(current, parsed.name);
  if (peer === 'missing') return `no peer on this tailnet is named ${parsed.name}`;
  if (peer === 'ambiguous') return `several tailnet peers match ${parsed.name}`;
  if (peer.nodeId !== credential.nodeId) {
    return `${peer.dnsName} is now node ${peer.nodeId}, not the pinned ${credential.nodeId}; run stim doctor`;
  }
  return endpoint(peer, parsed.port);
}
