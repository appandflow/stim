import { t } from '@lingui/core/macro';
import {
  isRpcError,
  isRpcEvent,
  isRpcEventName,
  isRpcResult,
  rpcErrorIssue,
  rpcEventIssue,
  rpcResultIssue,
} from '@stim-cli/core/receive-protocol';

import {
  ACTIONS,
  type ActionName,
  type ControlEndedEvent,
  type Method,
  type NotificationEvent,
  type Methods,
  type ProtocolError,
  type ServerEvent,
} from '@/protocol/types';
import { reportFailure, safeName, type Failure } from '@/lib/diagnostics';
import {
  createSocket,
  type SessionClose,
  type SessionTiming,
  type SocketAuth,
  type StimSocket,
  type VideoStream,
} from '@/lib/socket';

export type ConnectionState =
  | { kind: 'connecting' }
  | {
      kind: 'open';
      server: Methods['hello']['result']['server'];
      /** The protocol version the server answered `hello` with. */
      protocol: number;
      actions: ActionName[] | null;
      capabilities: string[];
      /** What the server serves beyond the base protocol, such as `physical-android`. */
      features: string[];
      /** This phone's id on the Mac, as `stim-server devices` lists it; null from a server that predates it. */
      deviceId: string | null;
    }
  | { kind: 'waiting'; retryInMs: number; reason: string }
  | { kind: 'refused'; code: string; reason: string }
  | { kind: 'closed' };

/** What the Mac lets this phone do, from the last `hello`: null while not connected, since only `hello` says. */
export function pairingScope(state: ConnectionState): 'control' | 'read' | null {
  if (state.kind !== 'open') return null;
  return state.capabilities.includes('control') ? 'control' : 'read';
}

type SubscribeMethod =
  | 'status.subscribe'
  | 'workspaces.subscribe'
  | 'workspace.subscribe'
  | 'machine.subscribe'
  | 'logs.subscribe'
  | 'frames.subscribe';

type SubscribeResult = Methods[SubscribeMethod]['result'];

interface Subscription {
  method: SubscribeMethod;
  params: Methods[SubscribeMethod]['params'];
  onEvent: (event: ServerEvent) => void;
  onSubscribed?: (result: SubscribeResult) => void;
  onVideo?: (stream: VideoStream) => void;
  video: VideoStream | null;
  serverId: string | null;
  retryMs: number;
  retry: unknown;
}

interface Pending {
  method: Method;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class RequestError extends Error {
  constructor(readonly error: ProtocolError) {
    super(error.message);
  }
}

type SocketFactory = (url: string, auth: SocketAuth) => StimSocket;

export interface ConnectionOptions {
  endpoint: string;
  /** The server key this phone pinned when it paired, base64url. */
  serverKey: string;
  client: { name: string; version: string };
  onState?: (state: ConnectionState) => void;
  createSocket?: SocketFactory;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function responseFailure(method: Method, message: { result?: unknown; error?: unknown }): Failure {
  if ('result' in message && !('error' in message)) {
    return { kind: 'rpc', stage: 'result', name: method, issue: rpcResultIssue(method, message.result) };
  }
  if ('error' in message && !('result' in message)) {
    return { kind: 'rpc', stage: 'error', name: method, issue: rpcErrorIssue(message.error) };
  }
  return { kind: 'rpc', stage: 'envelope', name: method, issue: null };
}

function isMessageObject(value: unknown): value is {
  id?: unknown;
  event?: unknown;
  subscription?: unknown;
  result?: unknown;
  error?: unknown;
} {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
const INVALID_BACKOFF_MS = 60_000;
const REFUSAL_CODES = new Set(['unauthorized', 'pairing-expired', 'protocol-unsupported']);

/**
 * Why a session that closed will not work on retry, or null for a lost connection. A protocol 1 stim-server closes
 * with 4400 "unexpected binary frame" on the Noise prefix, before answering it. A protocol 2 server names its refusal
 * in the close reason.
 */
function sessionRefusal(event: SessionClose): { code: string; reason: string } | null {
  if (!event.serverAnswered && event.code === 4400 && event.reason === 'unexpected binary frame') {
    return {
      code: 'server-outdated',
      reason: t`Update stim-server on this Mac. It speaks an older protocol than this app.`,
    };
  }
  if (event.error === 'server-key-mismatch') {
    return {
      code: 'server-key-mismatch',
      reason: t`This Mac's key does not match the pairing code or the key this phone paired with. Pair it again if stim-server was reset.`,
    };
  }
  if (event.reason === 'unknown-secret') {
    return {
      code: 'unknown-secret',
      reason: t`This pairing code expired or was already used. Show a new one on the Mac.`,
    };
  }
  if (event.reason === 'unauthorized') {
    return { code: 'unauthorized', reason: t`This Mac no longer knows this phone. Pair it again.` };
  }
  if (event.reason === 'protocol-unsupported') {
    return { code: 'protocol-unsupported', reason: t`This Mac speaks a newer protocol. Update the app.` };
  }
  return null;
}

/**
 * One authenticated connection to a Stim server. It reconnects with a delay that doubles from 1 to
 * 30 seconds and resubscribes after each `hello`, because the server keeps no per-client history.
 * An `error` event ends one subscription on the server; that subscription is sent again after the
 * same doubling delay, which resets once it delivers an event.
 */
export class StimConnection {
  private socket: StimSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subscriptions = new Set<Subscription>();
  private controlListeners = new Set<(event: ControlEndedEvent) => void>();
  private notificationListeners = new Set<(event: NotificationEvent) => void>();
  private retryMs = MIN_RETRY_MS;
  private lastInvalidAt = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private stopped = false;
  private open = false;
  private readonly createSocket: SocketFactory;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ConnectionOptions) {
    this.createSocket = options.createSocket ?? createSocket;
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
    this.detach(t`Reconnecting.`);
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
    this.failPending(t`Connection closed.`);
    this.options.onState?.({ kind: 'closed' });
  }

  request<M extends Method>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    if (!this.open || !this.socket) return Promise.reject(new Error(t`Not connected.`));
    return this.send(this.socket, method, params);
  }

  /**
   * `onSubscribed` runs each time the server accepts the subscription, with its result, before the events it
   * then sends. `onVideo` then gets the stream of a `frames.subscribe` whose result offered H.264; the connection
   * disposes it when the subscription ends or is sent again.
   */
  subscribe<M extends SubscribeMethod>(
    method: M,
    params: Methods[M]['params'],
    onEvent: (event: ServerEvent) => void,
    onSubscribed?: (result: Methods[M]['result']) => void,
    onVideo?: (stream: VideoStream) => void,
  ): () => void {
    const sub: Subscription = {
      method,
      params,
      onEvent,
      onSubscribed: onSubscribed as Subscription['onSubscribed'],
      onVideo,
      video: null,
      serverId: null,
      retryMs: MIN_RETRY_MS,
      retry: null,
    };
    this.subscriptions.add(sub);
    if (this.open && this.socket) this.sendSubscribe(this.socket, sub);
    return () => {
      this.subscriptions.delete(sub);
      this.cancelRetry(sub);
      endVideo(sub);
      if (sub.serverId && this.open) {
        this.request('unsubscribe', { subscription: sub.serverId }).catch(() => {});
      }
    };
  }

  /** The current session's timing, in development builds; null while not connected. */
  timing(): SessionTiming | null {
    return this.open && this.socket ? this.socket.timing() : null;
  }

  /** Control sessions the server ended; a lost connection ends them too, without an event. */
  onControlEnded(listener: (event: ControlEndedEvent) => void): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  /** Notifications the Mac logs, sent once this connection has sent `notifications.list`. */
  onNotification(listener: (event: NotificationEvent) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  private connect(): void {
    this.options.onState?.({ kind: 'connecting' });
    const socket = this.createSocket(this.options.endpoint, { serverKey: this.options.serverKey });
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.send(socket, 'hello', { client: this.options.client }).then(
        (hello) => {
          if (socket !== this.socket) return;
          this.open = true;
          if (Date.now() - this.lastInvalidAt > INVALID_BACKOFF_MS) this.retryMs = MIN_RETRY_MS;
          this.options.onState?.({
            kind: 'open',
            server: hello.server,
            protocol: hello.protocol,
            actions:
              hello.actions?.filter((action): action is ActionName => ACTIONS.some((known) => known === action)) ??
              null,
            capabilities: hello.capabilities,
            features: hello.features ?? [],
            deviceId: hello.device?.id ?? null,
          });
          for (const sub of this.subscriptions) this.sendSubscribe(socket, sub);
        },
        (error: Error) => {
          if (socket !== this.socket) return;
          if (error instanceof RequestError) {
            const refused = REFUSAL_CODES.has(error.error.code);
            reportFailure({
              kind: 'connection',
              errorClass: `${refused ? 'refused' : 'request-error'}:${safeName(error.error.code)}`,
            });
            if (refused) {
              this.stopped = true;
              this.options.onState?.({ kind: 'refused', code: error.error.code, reason: error.message });
            }
          }
          socket.close();
        },
      );
    };
    socket.onmessage = (text) => {
      if (socket !== this.socket) return;
      this.receive(text);
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      const refusal = sessionRefusal(event);
      const lost = t`Connection lost.`;
      this.detach(refusal?.reason ?? lost);
      if (refusal) {
        reportFailure({ kind: 'connection', errorClass: `refused:${safeName(refusal.code)}` });
        this.stopped = true;
        this.options.onState?.({ kind: 'refused', ...refusal });
        return;
      }
      if (!this.stopped) this.scheduleRetry(lost);
    };
  }

  private detach(reason: string): void {
    this.socket = null;
    this.open = false;
    for (const sub of this.subscriptions) {
      sub.serverId = null;
      this.cancelRetry(sub);
      endVideo(sub);
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

  private sendSubscribe(socket: StimSocket, sub: Subscription): void {
    this.send(socket, sub.method, sub.params).then(
      (result) => {
        if (!this.subscriptions.has(sub)) {
          this.request('unsubscribe', { subscription: result.subscription }).catch(() => {});
          return;
        }
        sub.serverId = result.subscription;
        sub.onSubscribed?.(result);
        endVideo(sub);
        if (sub.onVideo && 'video' in result && result.video === 'h264') {
          sub.retryMs = MIN_RETRY_MS;
          sub.video = socket.videoStream(result.subscription);
          sub.onVideo(sub.video);
        }
      },
      (error: Error) => {
        sub.onEvent({ event: 'error', error: { code: 'subscribe-failed', message: error.message } });
      },
    );
  }

  private send<M extends Method>(socket: StimSocket, method: M, params: Methods[M]['params']) {
    const id = this.nextId++;
    return new Promise<Methods[M]['result']>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private receive(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      reportFailure({ kind: 'rpc', stage: 'parse', name: 'message', issue: null });
      this.invalidMessage();
      return;
    }
    if (!isMessageObject(message)) {
      reportFailure({ kind: 'rpc', stage: 'envelope', name: 'message', issue: null });
      this.invalidMessage();
      return;
    }
    if ('id' in message) {
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      this.pending.delete(message.id as number);
      if ('error' in message && !('result' in message) && isRpcError(message.error)) {
        pending.reject(new RequestError(message.error));
      } else if ('result' in message && !('error' in message) && isRpcResult(pending.method, message.result)) {
        pending.resolve(message.result);
      } else {
        reportFailure(responseFailure(pending.method, message));
        pending.reject(new Error(t`The Mac sent an invalid RPC response.`));
        this.invalidMessage();
      }
      return;
    }
    if (typeof message.event !== 'string' || !isRpcEventName(message.event)) return;
    const subscription = message.subscription;
    if (typeof subscription === 'string' && ![...this.subscriptions].some((sub) => sub.serverId === subscription))
      return;
    if (!isRpcEvent(message)) {
      reportFailure({ kind: 'rpc', stage: 'event', name: message.event, issue: rpcEventIssue(message) });
      this.invalidMessage();
      return;
    }
    if (message.event === 'control-ended') {
      for (const listener of this.controlListeners) listener(message);
      return;
    }
    if (message.event === 'notification') {
      for (const listener of this.notificationListeners) listener(message);
      return;
    }
    for (const sub of this.subscriptions) {
      if (sub.serverId === null || sub.serverId !== message.subscription) continue;
      if (message.event === 'error') this.resubscribeLater(sub);
      else sub.retryMs = MIN_RETRY_MS;
      sub.onEvent(message);
    }
  }

  private invalidMessage(): void {
    this.lastInvalidAt = Date.now();
    const socket = this.socket;
    const reason = t`The Mac sent an invalid RPC message. Reconnecting.`;
    this.detach(reason);
    socket?.close();
    if (!this.stopped) this.scheduleRetry(reason);
  }

  private resubscribeLater(sub: Subscription): void {
    const socket = this.socket;
    const delay = sub.retryMs;
    sub.serverId = null;
    endVideo(sub);
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

/** Spends a pairing token and returns the server key to pin, which the session checked against `fingerprint`. */
export function pair(
  endpoint: string,
  secret: { pairingToken: string; fingerprint?: string },
  deviceName: string,
  client: { name: string; version: string },
  socketFactory: SocketFactory = createSocket,
): Promise<{ serverKey: string; serverName: string; serverId?: string }> {
  return new Promise((resolve, reject) => {
    const socket = socketFactory(endpoint, {
      pairingToken: secret.pairingToken,
      ...(secret.fingerprint ? { fingerprint: secret.fingerprint } : {}),
      name: deviceName,
    });
    let done = false;
    let serverKey: string | null = null;
    const unreachable = () => new Error(t`Cannot reach ${endpoint}. Check that Tailscale is connected on this phone.`);
    const fail = (errorClass: string, error: Error) => {
      reportFailure({ kind: 'pairing', errorClass });
      reject(error);
    };
    const timeout = setTimeout(() => finish(() => fail('timeout', unreachable())), PAIRING_TIMEOUT_MS);
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.close();
      settle();
    };
    const hello: Methods['hello']['params'] = { client };
    socket.onopen = (key) => {
      serverKey = key;
      socket.send(JSON.stringify({ id: 1, method: 'hello', params: hello }));
    };
    socket.onmessage = (text) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish(() => fail('invalid-response', new Error(t`The Mac sent an invalid pairing response.`)));
        return;
      }
      if (!isMessageObject(parsed) || parsed.id !== 1) return;
      finish(() => {
        if ('error' in parsed && !('result' in parsed) && isRpcError(parsed.error)) {
          return fail(`request-error:${safeName(parsed.error.code)}`, new RequestError(parsed.error));
        }
        if ('error' in parsed || !isRpcResult('hello', parsed.result) || !serverKey) {
          reportFailure(responseFailure('hello', parsed));
          return fail('invalid-response', new Error(t`The Mac sent an invalid pairing response.`));
        }
        const result = parsed.result;
        resolve({
          serverKey,
          serverName: result.server.name,
          ...(result.server.id ? { serverId: result.server.id } : {}),
        });
      });
    };
    socket.onclose = (event) => {
      const refusal = sessionRefusal(event);
      finish(() =>
        refusal ? fail(`refused:${refusal.code}`, new Error(refusal.reason)) : fail('closed', unreachable()),
      );
    };
  });
}

function endVideo(sub: Subscription): void {
  sub.video?.dispose();
  sub.video = null;
}
