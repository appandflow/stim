import { WebSocket } from 'ws';
import { generateNoiseKeyPair, type NoiseKeyPair } from '@stim-cli/core/noise';
import { initiateNoise, newSecret, secretValues } from '@stim-cli/core/noise-session';
import type { ServerMessage } from '../src/protocol.ts';
import { serverIdentity, spendSecret, storeSetupSecret, type KeyRecords } from '../src/registry.ts';

export interface ClientSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown;
  once(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown;
}

export interface Client {
  socket: ClientSocket;
  next: () => Promise<ServerMessage>;
  closed: Promise<number>;
  closedWith: Promise<{ code: number; reason: string }>;
  request: (method: string, params?: unknown) => Promise<ServerMessage>;
}

export interface ConnectOptions {
  headers?: Record<string, string>;
  /** The client key; a fresh one when absent. */
  keyPair?: NoiseKeyPair;
  /** First contact: the pairing token or setup ticket text. */
  secret?: string;
  name?: string;
  /** The server key a returning client pins; the test home's own server key when absent. */
  serverKey?: Uint8Array;
}

const open = new Set<WebSocket>();

/** Terminates every socket these helpers opened. */
export function terminateClients(): void {
  for (const socket of open) socket.terminate();
  open.clear();
}

/** Opens a WebSocket without any handshake; rejects with `HTTP <status>` when the upgrade is refused. */
export function openRaw(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers });
  open.add(socket);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
    socket.once('error', reject);
  });
}

/** Request/reply bookkeeping over a socket whose messages are JSON text or binary frames. */
export function wrap(socket: ClientSocket, raw: WebSocket): Client {
  const inbox: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  const replies = new Map<number, (message: ServerMessage) => void>();
  socket.on('message', (data, isBinary) => {
    const message = (isBinary ? { binary: data } : JSON.parse(data.toString())) as ServerMessage;
    if ('id' in message && typeof message.id === 'number') {
      const reply = replies.get(message.id);
      if (reply) {
        replies.delete(message.id);
        reply(message);
        return;
      }
    }
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  const closedWith = new Promise<{ code: number; reason: string }>((resolve) => {
    if (raw.readyState === WebSocket.CLOSED) resolve({ code: 1006, reason: '' });
    raw.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const next = () =>
    inbox.length ? Promise.resolve(inbox.shift()!) : new Promise<ServerMessage>((resolve) => waiting.push(resolve));
  let id = 0;
  const request = (method: string, params?: unknown) =>
    new Promise<ServerMessage>((resolve) => {
      replies.set(++id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { socket, next, closed: closedWith.then(({ code }) => code), closedWith, request };
}

/** A protocol 2 network connection: first contact with `secret`, otherwise a returning client pinning the server key. */
export async function noiseConnect(url: string, options: ConnectOptions = {}): Promise<Client> {
  const raw = await openRaw(url, options.headers);
  const closedWith = new Promise<{ code: number; reason: string }>((resolve) =>
    raw.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const keyPair = options.keyPair ?? generateNoiseKeyPair();
  const socket = await initiateNoise(raw, {
    keyPair,
    timeoutMs: 5000,
    ...(options.secret === undefined
      ? { serverKey: options.serverKey ?? serverIdentity().publicKey }
      : { secret: Buffer.from(options.secret, 'base64url'), name: options.name ?? 'Test phone' }),
  });
  const client = wrap(socket, raw);
  return { ...client, closedWith, closed: closedWith.then(({ code }) => code) };
}

/** A connection on stim-server's Unix socket, which runs no handshake. */
export async function localConnect(path: string): Promise<Client> {
  const raw = await openRaw(`ws+unix://${path}:/`);
  return wrap(raw, raw);
}

/**
 * Records `capabilities` for a fresh key as a finished `stim-server setup` run does, without a connection, for tests
 * whose subject is what the records allow rather than how they were made.
 */
export function setupClient(
  capabilities: ('build' | 'device-host')[],
  name = 'Client',
  from = 'test',
): { keyPair: NoiseKeyPair; records: KeyRecords } {
  const ticket = Buffer.from(newSecret(), 'base64url');
  storeSetupSecret(ticket, capabilities, new Date(Date.now() + 60_000).toISOString());
  const keyPair = generateNoiseKeyPair();
  const records = spendSecret(
    secretValues(ticket).lookup.toString('hex'),
    keyPair.publicKey.toString('base64url'),
    name,
    from,
  );
  if (!records) throw new Error('the setup secret was not spent');
  return { keyPair, records };
}
