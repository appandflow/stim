import {
  PROTOCOL_VERSION,
  type ActionName,
  type ClientAuth,
  type ControlEndedEvent,
  type Method,
  type Methods,
  type ProtocolError,
  type ServerEvent,
  type ServerMessage,
} from '@/protocol/types';

export type ConnectionState =
  | { kind: 'connecting' }
  | {
      kind: 'open';
      server: Methods['hello']['result']['server'];
      actions: ActionName[] | null;
      capabilities: string[];
    }
  | { kind: 'waiting'; retryInMs: number; reason: string }
  | { kind: 'refused'; code: string; reason: string }
  | { kind: 'closed' };

type SubscribeMethod = 'status.subscribe' | 'logs.subscribe' | 'frames.subscribe';

interface Subscription {
  method: SubscribeMethod;
  params: Methods[SubscribeMethod]['params'];
  onEvent: (event: ServerEvent) => void;
  onSubscribed?: () => void;
  serverId: string | null;
  retryMs: number;
  retry: unknown;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class RequestError extends Error {
  constructor(readonly error: ProtocolError) {
    super(error.message);
  }
}

type SocketFactory = (url: string) => WebSocket;

export interface ConnectionOptions {
  endpoint: string;
  auth: ClientAuth;
  client: { name: string; version: string };
  onState?: (state: ConnectionState) => void;
  createSocket?: SocketFactory;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
const REFUSAL_CODES = new Set(['unauthorized', 'pairing-expired', 'protocol-unsupported']);

/**
 * One authenticated connection to a Stim server. It reconnects with a delay that doubles from 1 to
 * 30 seconds and resubscribes after each `hello`, because the server keeps no per-client history.
 * An `error` event ends one subscription on the server; that subscription is sent again after the
 * same doubling delay, which resets once it delivers an event.
 */
export class StimConnection {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subscriptions = new Set<Subscription>();
  private controlListeners = new Set<(event: ControlEndedEvent) => void>();
  private retryMs = MIN_RETRY_MS;
  private timer: unknown = null;
  private stopped = false;
  private open = false;
  private readonly createSocket: SocketFactory;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ConnectionOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Skips the remaining retry delay, for when the app returns to the foreground. */
  retryNow(): void {
    if (this.stopped || this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
    this.connect();
  }

  /** Replaces the connection now, so a new `hello` reports capabilities the Mac changed since. */
  reconnect(): void {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.detach('Reconnecting.');
    socket?.close();
    this.connect();
  }

  close(): void {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    for (const sub of this.subscriptions) this.cancelRetry(sub);
    this.socket?.close();
    this.socket = null;
    this.failPending('Connection closed.');
    this.options.onState?.({ kind: 'closed' });
  }

  request<M extends Method>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    if (!this.open || !this.socket) return Promise.reject(new Error('Not connected.'));
    return this.send(this.socket, method, params);
  }

  /** `onSubscribed` runs each time the server accepts the subscription, before the events it then sends. */
  subscribe<M extends SubscribeMethod>(
    method: M,
    params: Methods[M]['params'],
    onEvent: (event: ServerEvent) => void,
    onSubscribed?: () => void,
  ): () => void {
    const sub: Subscription = {
      method,
      params,
      onEvent,
      onSubscribed,
      serverId: null,
      retryMs: MIN_RETRY_MS,
      retry: null,
    };
    this.subscriptions.add(sub);
    if (this.open && this.socket) this.sendSubscribe(this.socket, sub);
    return () => {
      this.subscriptions.delete(sub);
      this.cancelRetry(sub);
      if (sub.serverId && this.open) {
        this.request('unsubscribe', { subscription: sub.serverId }).catch(() => {});
      }
    };
  }

  /** Control sessions the server ended; a lost connection ends them too, without an event. */
  onControlEnded(listener: (event: ControlEndedEvent) => void): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  private connect(): void {
    this.options.onState?.({ kind: 'connecting' });
    const socket = this.createSocket(this.options.endpoint);
    this.socket = socket;
    socket.onopen = () => {
      this.send(socket, 'hello', {
        protocol: PROTOCOL_VERSION,
        client: this.options.client,
        auth: this.options.auth,
      }).then(
        (hello) => {
          if (socket !== this.socket) return;
          this.open = true;
          this.retryMs = MIN_RETRY_MS;
          this.options.onState?.({
            kind: 'open',
            server: hello.server,
            actions: hello.actions ?? null,
            capabilities: hello.capabilities,
          });
          for (const sub of this.subscriptions) this.sendSubscribe(socket, sub);
        },
        (error: Error) => {
          if (socket !== this.socket) return;
          if (error instanceof RequestError && REFUSAL_CODES.has(error.error.code)) {
            this.stopped = true;
            this.options.onState?.({ kind: 'refused', code: error.error.code, reason: error.message });
          }
          socket.close();
        },
      );
    };
    socket.onmessage = (message) => {
      if (socket === this.socket) this.receive(String(message.data));
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.detach('Connection lost.');
      if (!this.stopped) this.scheduleRetry('Connection lost.');
    };
  }

  private detach(reason: string): void {
    this.socket = null;
    this.open = false;
    for (const sub of this.subscriptions) {
      sub.serverId = null;
      this.cancelRetry(sub);
    }
    this.failPending(reason);
  }

  private scheduleRetry(reason: string): void {
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.options.onState?.({ kind: 'waiting', retryInMs: delay, reason });
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private sendSubscribe(socket: WebSocket, sub: Subscription): void {
    this.send(socket, sub.method, sub.params).then(
      (result) => {
        if (!this.subscriptions.has(sub)) {
          this.request('unsubscribe', { subscription: result.subscription }).catch(() => {});
          return;
        }
        sub.serverId = result.subscription;
        sub.onSubscribed?.();
      },
      (error: Error) => {
        sub.onEvent({ event: 'error', error: { code: 'subscribe-failed', message: error.message } });
      },
    );
  }

  private send<M extends Method>(socket: WebSocket, method: M, params: Methods[M]['params']) {
    const id = this.nextId++;
    return new Promise<Methods[M]['result']>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private receive(text: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ('error' in message) pending.reject(new RequestError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.event === 'control-ended') {
      for (const listener of this.controlListeners) listener(message);
      return;
    }
    for (const sub of this.subscriptions) {
      if (sub.serverId === null || sub.serverId !== message.subscription) continue;
      if (message.event === 'error') this.resubscribeLater(sub);
      else sub.retryMs = MIN_RETRY_MS;
      sub.onEvent(message);
    }
  }

  private resubscribeLater(sub: Subscription): void {
    const socket = this.socket;
    const delay = sub.retryMs;
    sub.serverId = null;
    sub.retryMs = Math.min(sub.retryMs * 2, MAX_RETRY_MS);
    sub.retry = this.setTimer(() => {
      sub.retry = null;
      if (socket && socket === this.socket && this.open && this.subscriptions.has(sub)) this.sendSubscribe(socket, sub);
    }, delay);
  }

  private cancelRetry(sub: Subscription): void {
    if (sub.retry !== null) this.clearTimer(sub.retry);
    sub.retry = null;
  }

  private failPending(reason: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }
}

const PAIRING_TIMEOUT_MS = 15_000;

/** Spends a pairing token and returns the device token the server issues. */
export function pair(
  endpoint: string,
  pairingToken: string,
  deviceName: string,
  client: { name: string; version: string },
  createSocket: SocketFactory = (url) => new WebSocket(url),
): Promise<{ deviceToken: string; serverName: string }> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(endpoint);
    let done = false;
    const unreachable = () => new Error(`Cannot reach ${endpoint}. Check that Tailscale is connected on this phone.`);
    const timeout = setTimeout(() => finish(() => reject(unreachable())), PAIRING_TIMEOUT_MS);
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.close();
      settle();
    };
    const hello: Methods['hello']['params'] = {
      protocol: PROTOCOL_VERSION,
      client,
      auth: { pairingToken, deviceName },
    };
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'hello', params: hello }));
    socket.onmessage = (message) => {
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(String(message.data)) as ServerMessage;
      } catch {
        return;
      }
      if (!('id' in parsed) || parsed.id !== 1) return;
      finish(() => {
        if ('error' in parsed) return reject(new RequestError(parsed.error));
        const result = parsed.result as Methods['hello']['result'];
        if (!result.deviceToken) return reject(new Error('The server did not issue a device token.'));
        resolve({ deviceToken: result.deviceToken, serverName: result.server.name });
      });
    };
    socket.onclose = () => finish(() => reject(unreachable()));
  });
}
