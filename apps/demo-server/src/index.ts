import { EventEmitter } from 'node:events';
import { generateNoiseKeyPair, noiseKeyPairFromPrivateKey, type NoiseKeyPair } from '@stim-cli/core/noise';
import { CLOSE_REFUSED, type RawSocket } from '@stim-cli/core/noise-session';
import { DurableObject } from 'cloudflare:workers';

import { DemoMachine, HANDSHAKE_MS, upgradeFromWebPage, type DeviceRecord } from './demo.ts';
import { bundledFixtures } from './fixtures.ts';

interface Env {
  DEMO: DurableObjectNamespace<DemoServer>;
  DEMO_TOKEN?: string;
  VERSION: WorkerVersionMetadata;
}

const MACHINE_NAME = 'Demo Mac';
const MAX_SOCKETS = 32;
const IDENTITY_KEY = 'identity';
const DEVICE_PREFIX = 'device:';

export default {
  fetch(request, env): Promise<Response> | Response {
    const demo = (): DurableObjectStub<DemoServer> => env.DEMO.get(env.DEMO.idFromName('demo'));
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      if (new URL(request.url).pathname === '/pairing') return demo().fetch(request);
      return new Response('Stim demo server. Pair the Stim app with this address over wss://.\n', { status: 426 });
    }
    if (upgradeFromWebPage(request.headers, request.url)) return new Response(null, { status: 403 });
    return demo().fetch(request);
  },
} satisfies ExportedHandler<Env>;

class WorkerSocket extends EventEmitter implements RawSocket {
  readonly bufferedAmount = 0;
  readonly #socket: WebSocket;

  constructor(socket: WebSocket) {
    super();
    this.#socket = socket;
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  send(data: Buffer | string, callback?: (error?: Error) => void): void {
    try {
      this.#socket.send(data);
    } catch (error) {
      return void callback?.(error as Error);
    }
    callback?.();
  }

  close(code?: number, reason?: string): void {
    if (this.#socket.readyState === 1) this.#socket.close(code, reason);
  }

  terminate(): void {
    this.close(1011, 'terminated');
  }
}

export class DemoServer extends DurableObject<Env> {
  private readonly machine: DemoMachine;
  private readonly sockets = new Map<WebSocket, WorkerSocket>();
  private readonly deadlines = new Map<WebSocket, ReturnType<typeof setTimeout>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const { kv } = ctx.storage;
    this.machine = new DemoMachine(bundledFixtures(), MACHINE_NAME, {
      token: env.DEMO_TOKEN,
      keyPair: identity(kv),
      devices: {
        get: (key) => kv.get<DeviceRecord>(DEVICE_PREFIX + key),
        set: (key, record) => kv.put(DEVICE_PREFIX + key, record),
      },
    });
  }

  override fetch(request: Request): Response {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json(this.machine.pairingCode(`${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}`), {
        headers: { 'X-Demo-Version': this.env.VERSION.id },
      });
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('Too many connections.\n', { status: 503 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    this.deadlines.set(
      server,
      setTimeout(() => {
        this.deadlines.delete(server);
        if (server.readyState === 1) server.close(CLOSE_REFUSED, 'timeout');
      }, HANDSHAKE_MS),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const data = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
    const isBinary = typeof message !== 'string';
    const known = this.sockets.get(socket);
    if (known) return void known.emit('message', data, isBinary);
    // Cloudflare Durable Objects drop in-memory state on hibernation; the session's cipher states went with it.
    if (socket.deserializeAttachment() !== null) return socket.close(1012, 'restarted');
    this.clearDeadline(socket);
    const raw = new WorkerSocket(socket);
    this.sockets.set(socket, raw);
    this.accept(socket, raw, data, isBinary).catch(() => raw.close(1011, 'handshake-failed'));
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.drop(socket, code, reason);
  }

  override webSocketError(socket: WebSocket): void {
    this.drop(socket, 1006, '');
  }

  private async accept(socket: WebSocket, raw: WorkerSocket, first: Uint8Array, isBinary: boolean): Promise<void> {
    if (await this.machine.accept(raw, first, isBinary)) socket.serializeAttachment(true);
  }

  private clearDeadline(socket: WebSocket): void {
    clearTimeout(this.deadlines.get(socket));
    this.deadlines.delete(socket);
  }

  private drop(socket: WebSocket, code: number, reason: string): void {
    this.clearDeadline(socket);
    this.sockets.get(socket)?.emit('close', code, new TextEncoder().encode(reason));
    this.sockets.delete(socket);
  }
}

function identity(kv: SyncKvStorage): NoiseKeyPair {
  const stored = kv.get<Uint8Array>(IDENTITY_KEY);
  if (stored) return noiseKeyPairFromPrivateKey(stored);
  const created = generateNoiseKeyPair();
  kv.put(IDENTITY_KEY, new Uint8Array(created.privateKey));
  return created;
}
