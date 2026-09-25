import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { isJsonObject } from '@stim-cli/core/state';
import {
  PROTOCOL_VERSION,
  type ErrorCode,
  type HelloResult,
  type ProtocolError,
  type RequestId,
  type ServerMessage,
} from './protocol.ts';
import {
  authenticateDevice,
  readDevices,
  serverDir,
  spendPairingToken,
  type AuthOutcome,
  type PairedDevice,
  type PeerIdentity,
} from './registry.ts';
import { StatusFeed } from './status-feed.ts';
import { whois } from './tailscale.ts';

export interface ServerOptions {
  name: string;
  hosts: string[];
  port: number;
  stimCli: string;
  stimVersion: string;
  serverVersion: string;
  env: NodeJS.ProcessEnv;
  tailscale: string | null;
  authTimeoutMs?: number;
  maxAuthFailures?: number;
  failureWindowMs?: number;
}

export interface RunningServer {
  addresses: { host: string; port: number }[];
  close: () => Promise<void>;
}

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_AUTH_TIMEOUT = 4408;
const MAX_PAYLOAD = 64 * 1024;

const AUTH_REFUSALS: Record<Exclude<AuthOutcome, { ok: true }>['reason'], ProtocolError> = {
  'pairing-unknown': {
    code: 'pairing-expired',
    message: 'This pairing code is unknown or was already used. Pair again.',
  },
  'pairing-expired': { code: 'pairing-expired', message: 'This pairing code expired. Pair again.' },
  'device-unknown': { code: 'unauthorized', message: 'This Mac does not recognize this device token. Pair again.' },
  'node-mismatch': { code: 'unauthorized', message: 'This device token was paired from a different tailnet node.' },
};

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * The tailnet address of the peer. `tailscale serve` proxies from loopback and names the peer in
 * X-Forwarded-For; a loopback connection without that header comes from this Mac.
 */
function peerAddress(request: IncomingMessage): string | null {
  const remote = request.socket.remoteAddress;
  if (!isLoopback(remote)) return remote ?? null;
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || null;
}

class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  blocked(key: string, now: number = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  record(key: string, now: number = Date.now()): void {
    this.failures.set(key, [...this.recent(key, now), now]);
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function requestId(value: unknown): RequestId | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const limiter = new FailureLimiter(options.maxAuthFailures ?? 5, options.failureWindowMs ?? 60_000);
  const authTimeoutMs = options.authTimeoutMs ?? 5000;
  const feed = new StatusFeed(options.stimCli, options.env);
  const sessions = new Map<WebSocket, PairedDevice>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  mkdirSync(serverDir(), { recursive: true, mode: 0o700 });
  let revocationCheck: NodeJS.Timeout | null = null;
  const watcher: FSWatcher = watch(serverDir(), () => {
    revocationCheck ??= setTimeout(() => {
      revocationCheck = null;
      const paired = new Set(readDevices().map((device) => device.id));
      for (const [socket, device] of sessions) {
        if (!paired.has(device.id)) socket.close(CLOSE_UNAUTHORIZED, 'device revoked');
      }
    }, 50);
  });

  function connection(socket: WebSocket, peer: string | null): void {
    const limitKey = peer ?? 'local';
    const subscriptions = new Map<string, () => void>();
    let nextSubscription = 1;
    let device: PairedDevice | null = null;
    let queue = Promise.resolve();

    const refuse = (id: RequestId | null, code: ErrorCode, message: string, closeCode: number) => {
      if (!device) limiter.record(limitKey);
      send(socket, { id, error: { code, message } });
      socket.close(closeCode, code);
    };
    const timer = setTimeout(() => {
      limiter.record(limitKey);
      socket.close(CLOSE_AUTH_TIMEOUT, 'authentication timeout');
    }, authTimeoutMs);

    async function identify(): Promise<PeerIdentity | null> {
      return peer === null ? { kind: 'local' } : whois(options.tailscale, options.env, peer);
    }

    async function hello(id: RequestId, params: unknown): Promise<void> {
      if (device)
        return send(socket, { id, error: { code: 'already-authenticated', message: 'hello was already accepted.' } });
      const auth = isJsonObject(params) && isJsonObject(params.auth) ? params.auth : null;
      if (!isJsonObject(params) || !auth || !isJsonObject(params.client)) {
        return refuse(id, 'bad-request', 'hello needs params.client and params.auth.', CLOSE_BAD_REQUEST);
      }
      if (params.protocol !== PROTOCOL_VERSION) {
        return refuse(
          id,
          'protocol-unsupported',
          `This server speaks protocol ${PROTOCOL_VERSION}.`,
          CLOSE_BAD_REQUEST,
        );
      }
      const identity = await identify();
      if (!identity) {
        return refuse(id, 'identity-unavailable', `tailscale whois did not identify ${peer}.`, CLOSE_UNAUTHORIZED);
      }
      let outcome: AuthOutcome;
      if (typeof auth.pairingToken === 'string' && typeof auth.deviceName === 'string' && auth.deviceName.trim()) {
        outcome = spendPairingToken(auth.pairingToken, auth.deviceName.trim(), identity);
      } else if (typeof auth.deviceToken === 'string') {
        outcome = authenticateDevice(auth.deviceToken, identity);
      } else {
        return refuse(id, 'bad-request', 'auth needs pairingToken and deviceName, or deviceToken.', CLOSE_BAD_REQUEST);
      }
      if (!outcome.ok) {
        const { code, message } = AUTH_REFUSALS[outcome.reason];
        return refuse(id, code, message, CLOSE_UNAUTHORIZED);
      }
      clearTimeout(timer);
      device = outcome.device;
      sessions.set(socket, device);
      const result: HelloResult = {
        protocol: PROTOCOL_VERSION,
        server: { name: options.name, version: options.serverVersion, stim: options.stimVersion },
        capabilities: device.capabilities,
        device: { id: device.id, name: device.name },
        ...(outcome.deviceToken ? { deviceToken: outcome.deviceToken } : {}),
      };
      send(socket, { id, result });
    }

    function subscribeStatus(id: RequestId): void {
      const subscription = `s${nextSubscription++}`;
      send(socket, { id, result: { subscription } });
      const unsubscribe = feed.subscribe({
        payload: (payload) => send(socket, { event: 'status', subscription, payload }),
        failed: (message) => {
          subscriptions.delete(subscription);
          send(socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
        },
      });
      subscriptions.set(subscription, unsubscribe);
    }

    async function handle(raw: string): Promise<void> {
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        message = null;
      }
      const id = isJsonObject(message) ? requestId(message.id) : null;
      if (!isJsonObject(message) || id === null || typeof message.method !== 'string') {
        if (device)
          return send(socket, { id, error: { code: 'bad-request', message: 'Expected {id, method, params}.' } });
        return refuse(id, 'bad-request', 'Expected {id, method, params}.', CLOSE_BAD_REQUEST);
      }
      if (message.method === 'hello') return hello(id, message.params);
      if (!device) return refuse(id, 'unauthorized', 'Send hello first.', CLOSE_UNAUTHORIZED);
      if (message.method === 'status.subscribe') return subscribeStatus(id);
      if (message.method === 'unsubscribe') {
        const name = isJsonObject(message.params) ? message.params.subscription : undefined;
        const unsubscribe = typeof name === 'string' ? subscriptions.get(name) : undefined;
        if (!unsubscribe) {
          return send(socket, {
            id,
            error: { code: 'unknown-subscription', message: `No subscription ${String(name)}.` },
          });
        }
        subscriptions.delete(name as string);
        unsubscribe();
        return send(socket, { id, result: {} });
      }
      send(socket, { id, error: { code: 'unknown-method', message: `Unknown method ${message.method}.` } });
    }

    socket.on('message', (data) => {
      const raw = data.toString();
      queue = queue.then(() => handle(raw)).catch(() => socket.close(1011, 'internal error'));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      sessions.delete(socket);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    });
  }

  function upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const peer = peerAddress(request);
    if (limiter.blocked(peer ?? 'local')) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => connection(ws, peer));
  }

  const servers: Server[] = [];
  const addresses: RunningServer['addresses'] = [];
  const close = async () => {
    watcher.close();
    if (revocationCheck) clearTimeout(revocationCheck);
    feed.close();
    for (const client of wss.clients) client.terminate();
    wss.close();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  };
  try {
    for (const host of options.hosts) {
      const server = createServer((_request, response) => {
        response.writeHead(426, { 'content-type': 'text/plain' }).end('stim-server speaks WebSocket only.\n');
      });
      server.on('upgrade', upgrade);
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      addresses.push({ host, port: (server.address() as AddressInfo).port });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { addresses, close };
}
