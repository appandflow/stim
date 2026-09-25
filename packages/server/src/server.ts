import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isIP, type AddressInfo, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { isJsonObject, loadConfig, type StatusPayload } from '@stim-cli/core/state';
import { FeedPool, type JsonObject } from './feed.ts';
import { LogBatcher, logArgs, parseLogFilter, type LogLimits } from './logs.ts';
import {
  PROTOCOL_VERSION,
  type ErrorCode,
  type HelloResult,
  type Methods,
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
import { runStim, type CommandLimits } from './stim-command.ts';
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
  logLimits?: Partial<LogLimits>;
  commandLimits?: Partial<CommandLimits>;
}

export interface RunningServer {
  addresses: { host: string; port: number }[];
  close: () => Promise<void>;
}

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_AUTH_TIMEOUT = 4408;
const MAX_PAYLOAD = 64 * 1024;
const MAX_SUBSCRIPTIONS = 32;
const MAX_COMMANDS = 4;
const LOG_LIMITS: LogLimits = { maxBufferedBytes: 4 * 1024 * 1024, maxPendingRecords: 20_000 };
const COMMAND_LIMITS: CommandLimits = { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 };

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
  const feeds = new FeedPool(options.stimCli, options.env);
  const running = new Set<() => Promise<void>>();
  const logLimits: LogLimits = { ...LOG_LIMITS, ...options.logLimits };
  const commandLimits: CommandLimits = { ...COMMAND_LIMITS, ...options.commandLimits };
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
    const commands = new Set<() => Promise<void>>();
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
      if (peer === null) return { kind: 'local' };
      return isIP(peer) ? whois(options.tailscale, options.env, peer) : null;
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
      clearTimeout(timer);
      const identity = await identify();
      if (socket.readyState !== socket.OPEN) return;
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

    function error(id: RequestId, code: ErrorCode, message: string): void {
      send(socket, { id, error: { code, message } });
    }

    function workspaceDir(id: RequestId, workspace: unknown, required: boolean): string | null {
      if (workspace === undefined && !required) return homedir();
      if (typeof workspace !== 'string') {
        error(id, 'bad-request', 'params.workspace must be an environment path from a status payload.');
        return null;
      }
      let registered: boolean;
      try {
        registered = Object.hasOwn(loadConfig()?.projects ?? {}, workspace);
      } catch (cause) {
        error(id, 'stim-failed', (cause as Error).message);
        return null;
      }
      if (!registered) {
        error(id, 'unknown-workspace', `${workspace} is not a Stim workspace on this Mac.`);
        return null;
      }
      if (!existsSync(workspace)) {
        error(id, 'unknown-workspace', `${workspace} is registered but no longer exists on this Mac.`);
        return null;
      }
      return workspace;
    }

    function openSubscription(id: RequestId): string | null {
      if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
        error(id, 'limit-exceeded', `A connection can hold ${MAX_SUBSCRIPTIONS} subscriptions.`);
        return null;
      }
      const subscription = `s${nextSubscription++}`;
      send(socket, { id, result: { subscription } });
      return subscription;
    }

    function subscribeStatus(id: RequestId): void {
      const subscription = openSubscription(id);
      if (!subscription) return;
      const unsubscribe = feeds.subscribe(
        { args: ['status', '--watch', '--json'], cwd: homedir(), keep: 1, label: 'stim status --watch' },
        {
          item: (payload) =>
            send(socket, { event: 'status', subscription, payload: payload as unknown as StatusPayload }),
          failed: (message) => {
            subscriptions.delete(subscription);
            send(socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
          },
        },
      );
      subscriptions.set(subscription, unsubscribe);
    }

    function subscribeLogs(id: RequestId, params: unknown): void {
      const parsed = parseLogFilter(params);
      if ('error' in parsed) return error(id, 'bad-request', parsed.error);
      const cwd = workspaceDir(id, parsed.filter.workspace, true);
      if (!cwd) return;
      const subscription = openSubscription(id);
      if (!subscription) return;
      const end = () => {
        subscriptions.get(subscription)?.();
        subscriptions.delete(subscription);
      };
      const batcher = new LogBatcher(
        {
          send: (records) => send(socket, { event: 'logs', subscription, records }),
          bufferedBytes: () => socket.bufferedAmount,
          overflow: () => {
            end();
            send(socket, {
              event: 'error',
              subscription,
              error: { code: 'slow-client', message: 'This client fell behind the log stream. Subscribe again.' },
            });
          },
        },
        logLimits,
      );
      const unsubscribe = feeds.subscribe(
        { args: logArgs(parsed.filter, true), cwd, keep: parsed.filter.tail!, label: 'stim logs --follow' },
        {
          item: (record) => batcher.push(record),
          failed: (message) => {
            batcher.flush(true);
            batcher.stop();
            subscriptions.delete(subscription);
            send(socket, { event: 'error', subscription, error: { code: 'logs-failed', message } });
          },
        },
      );
      subscriptions.set(subscription, () => {
        batcher.stop();
        unsubscribe();
      });
    }

    function command<M extends 'logs.query' | 'stats.get' | 'settings.get'>(
      id: RequestId,
      args: string[],
      cwd: string,
      result: (stdout: string) => Methods[M]['result'],
    ): void {
      if (commands.size >= MAX_COMMANDS) {
        return error(id, 'limit-exceeded', `A connection can run ${MAX_COMMANDS} requests at a time.`);
      }
      const run = runStim(options.stimCli, options.env, args, cwd, commandLimits);
      commands.add(run.cancel);
      running.add(run.cancel);
      void (async () => {
        const outcome = await run.outcome;
        commands.delete(run.cancel);
        running.delete(run.cancel);
        if (!outcome.ok) return error(id, 'stim-failed', outcome.message);
        let value: Methods[M]['result'];
        try {
          value = result(outcome.stdout);
        } catch {
          return error(id, 'stim-failed', `stim ${args[0]} printed output that is not JSON.`);
        }
        send(socket, { id, result: value });
      })();
    }

    function queryLogs(id: RequestId, params: unknown): void {
      const parsed = parseLogFilter(params);
      if ('error' in parsed) return error(id, 'bad-request', parsed.error);
      const cwd = workspaceDir(id, parsed.filter.workspace, true);
      if (!cwd) return;
      command<'logs.query'>(id, logArgs(parsed.filter, false), cwd, (stdout) => ({
        records: stdout
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as JsonObject),
      }));
    }

    function workspaceCommand(id: RequestId, method: 'stats.get' | 'settings.get', params: unknown): void {
      if (params !== undefined && !isJsonObject(params)) return error(id, 'bad-request', 'params must be an object.');
      const cwd = workspaceDir(id, params?.workspace, false);
      if (!cwd) return;
      command<typeof method>(id, [method === 'stats.get' ? 'stats' : 'settings', '--json'], cwd, (stdout) => {
        const value: unknown = JSON.parse(stdout);
        if (!isJsonObject(value)) throw new Error('not an object');
        return value;
      });
    }

    async function handle(raw: string): Promise<void> {
      if (socket.readyState !== socket.OPEN) return;
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
      if (message.method === 'logs.subscribe') return subscribeLogs(id, message.params);
      if (message.method === 'logs.query') return queryLogs(id, message.params);
      if (message.method === 'stats.get' || message.method === 'settings.get') {
        return workspaceCommand(id, message.method, message.params);
      }
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
      for (const cancel of commands) {
        running.delete(cancel);
        void cancel();
      }
      commands.clear();
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
    for (const client of wss.clients) client.terminate();
    await Promise.all([feeds.close(), ...[...running].map((cancel) => cancel())]);
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
