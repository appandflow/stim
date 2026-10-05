import type { ConnectionOptions } from 'node:tls';
import { WebSocket, type ClientOptions } from 'ws';
import {
  isJsonObject,
  pinnedEndpoint,
  readDeviceHostMachines,
  type Endpoint,
  type HostedMacosPlacement,
} from '@stim-cli/core/state';
import type { AuditRecord } from './actions.ts';
import type { SessionTarget } from './control.ts';
import { LatestFrames, FRAME_RETRY_MS } from './frame-delivery.ts';
import { FRAME_FPS, VIDEO_KEYFRAME, type ProtocolError, type RequestId, type ServerMessage } from './protocol.ts';
import { DEFAULT_VIDEO_LIMITS, rewriteVideoSubscription, videoSubscription, VideoGate } from './video.ts';

const TIMEOUT_MS = 10_000;
const KEYFRAME_RETRY_MS = 1000;
const CONGESTION_NOTICE_MS = 250;
type Reply = { result: unknown } | { error: ProtocolError };
type Event = Record<string, unknown> | Buffer;

export interface HostedRelayOptions {
  status: () => unknown | Promise<unknown>;
  endpoint?: (pinned: Endpoint) => Endpoint;
}

interface Route {
  event: (event: Event) => void;
  closed: (error: Error) => void;
}

function routeOf(message: Event): string | null {
  if (Buffer.isBuffer(message)) {
    const subscription = videoSubscription(message);
    return subscription === null ? null : `s:${subscription}`;
  }
  if (typeof message.subscription === 'string') return `s:${message.subscription}`;
  if (message.event === 'control-ended' && typeof message.session === 'string') return `c:${message.session}`;
  return null;
}

class Upstream {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  private readonly routes = new Map<string, Route>();
  private held: { route: string; event: Event }[] = [];
  private holding: NodeJS.Immediate | null = null;
  private ended: Error | null = null;
  private users = 0;
  private features: unknown[] = [];
  onClose: (() => void) | null = null;

  private readonly token: string;

  constructor(endpoint: Endpoint, token: string) {
    this.token = token;
    const options: ClientOptions & ConnectionOptions = {
      handshakeTimeout: TIMEOUT_MS,
      servername: endpoint.servername,
      headers: { Host: endpoint.host },
    };
    this.socket = new WebSocket(endpoint.url, options);
    this.socket.on('error', (error) => this.fail(error.message));
    this.socket.on('close', () => this.fail('the host connection closed'));
    this.socket.on('message', (data, binary) => {
      if (this.ended) return;
      const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      let message: unknown;
      if (binary) message = bytes;
      else {
        try {
          message = JSON.parse(bytes.toString());
        } catch {
          return this.fail('the host sent invalid JSON');
        }
      }
      if (isJsonObject(message) && typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (isJsonObject(message.error)) {
          pending.resolve({
            error: { code: message.error.code, message: this.safe(String(message.error.message)) } as ProtocolError,
          });
        } else if ('result' in message) pending.resolve({ result: message.result });
        else pending.reject(new Error('the host sent an invalid reply'));
      } else if (Buffer.isBuffer(message) || isJsonObject(message)) {
        if (isJsonObject(message)) {
          if (isJsonObject(message.error) && typeof message.error.message === 'string')
            message.error.message = this.safe(message.error.message);
          if (typeof message.message === 'string') message.message = this.safe(message.message);
        }
        const route = routeOf(message);
        if (route) this.dispatch(route, message);
      }
    });
  }

  /** `ws` can emit an event from the same read as the reply that names its route; it waits one turn for that route. */
  private dispatch(route: string, event: Event): void {
    const found = this.routes.get(route);
    if (found) return found.event(event);
    this.held.push({ route, event });
    this.holding ??= setImmediate(() => {
      this.held = [];
      this.holding = null;
    });
  }

  private safe(message: string): string {
    return message.replaceAll(this.token, '[redacted]');
  }

  private fail(message: string): void {
    if (this.ended) return;
    this.ended = new Error(this.safe(message));
    const routes = [...this.routes.values()];
    this.close();
    for (const route of routes) route.closed(this.ended);
  }

  async open(version: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        this.socket.removeListener('open', opened);
        this.socket.removeListener('close', closed);
        this.socket.removeListener('error', failed);
        if (error) reject(error);
        else resolve();
      };
      const opened = () => done();
      const closed = () => done(this.ended ?? new Error('the host connection closed'));
      const failed = () => done(this.ended ?? new Error('the host connection failed'));
      const timer = setTimeout(() => {
        this.fail('the host did not connect in time');
        done(this.ended!);
      }, TIMEOUT_MS);
      this.socket.once('open', opened);
      this.socket.once('close', closed);
      this.socket.once('error', failed);
    });
    const reply = await this.request('hello', {
      protocol: 1,
      client: { name: 'stim-server', version },
      auth: { deviceToken: this.token },
    });
    if ('error' in reply) throw new Error(reply.error.message);
    if (
      !isJsonObject(reply.result) ||
      !Array.isArray(reply.result.capabilities) ||
      !reply.result.capabilities.includes('device-host')
    ) {
      throw new Error('the host did not grant device-host access');
    }
    if (Array.isArray(reply.result.features)) this.features = reply.result.features;
  }

  request(method: string, params: unknown): Promise<Reply> {
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => this.fail(`the host did not answer ${method} in time`), TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  route(name: string, route: Route): () => void {
    if (this.ended) throw this.ended;
    this.routes.set(name, route);
    const held = this.held.filter((entry) => entry.route === name);
    this.held = this.held.filter((entry) => entry.route !== name);
    for (const entry of held) route.event(entry.event);
    return () => {
      if (this.routes.get(name) === route) this.routes.delete(name);
    };
  }

  supports(feature: string): boolean {
    return this.features.includes(feature);
  }

  lease(): Lease {
    this.users++;
    let released = false;
    return {
      connection: this,
      release: () => {
        if (released) return;
        released = true;
        if (--this.users === 0) this.close();
      },
    };
  }

  close(): void {
    this.routes.clear();
    this.held = [];
    if (this.holding) clearImmediate(this.holding);
    this.holding = null;
    this.ended ??= new Error('the host connection closed');
    for (const pending of this.pending.values()) pending.reject(this.ended);
    this.pending.clear();
    const closed = this.onClose;
    this.onClose = null;
    closed?.();
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
    else this.socket.close();
  }
}

interface Lease {
  connection: Upstream;
  release: () => void;
}

/**
 * The client's connections to its hosts, one per host credential and pinned endpoint, shared by every local socket.
 * Each subscription and control session holds a lease; the connection closes when the last lease is released.
 */
export class HostConnections {
  private readonly open = new Map<string, { connection: Upstream; ready: Promise<void> }>();
  private readonly options: HostedRelayOptions;
  private readonly version: string;

  constructor(options: HostedRelayOptions, version: string) {
    this.options = options;
    this.version = version;
  }

  /** Checks the credential and pinned node on every call, then joins or opens the connection to that endpoint. */
  async acquire(host: HostedMacosPlacement): Promise<Lease> {
    let token = '';
    try {
      const credential = readDeviceHostMachines().find((entry) => entry.machine === host.machine);
      if (!credential || credential.state !== 'approved') throw new Error('no approved device-host credential');
      token = credential.deviceToken;
      const pinned = pinnedEndpoint(credential, await this.options.status());
      if (typeof pinned === 'string') throw new Error(pinned);
      const endpoint = this.options.endpoint?.(pinned) ?? pinned;
      const key = JSON.stringify([host.machine, token, endpoint.url, endpoint.servername, endpoint.host]);
      let entry = this.open.get(key);
      if (!entry) {
        const connection = new Upstream(endpoint, token);
        const opened = { connection, ready: connection.open(this.version) };
        connection.onClose = () => {
          if (this.open.get(key) === opened) this.open.delete(key);
        };
        opened.ready.catch(() => connection.close());
        this.open.set(key, opened);
        entry = opened;
      }
      const lease = entry.connection.lease();
      try {
        await entry.ready;
      } catch (cause) {
        lease.release();
        throw cause;
      }
      return lease;
    } catch (cause) {
      const reason = (cause as Error).message;
      throw new Error(token ? reason.replaceAll(token, '[redacted]') : reason, { cause });
    }
  }

  close(): void {
    for (const { connection } of this.open.values()) connection.close();
  }
}

export class HostedRelay {
  private readonly frames = new Map<
    string,
    { lease: Lease; subscription: string; reset: () => void; stop: () => void }
  >();
  private readonly controls = new Map<
    string,
    {
      lease: Lease;
      hostSession: string;
      unroute: () => void;
      startedAt: number;
      workspace: string;
      device: { id: string; name: string };
    }
  >();
  private nextControl = 1;
  private closed = false;

  private readonly hosts: HostConnections;
  private readonly send: (message: ServerMessage | Buffer) => void;
  private readonly buffered: () => number;
  private readonly openSubscription: (id: RequestId, result: { video?: 'h264' }) => string | null;
  private readonly dropSubscription: (subscription: string) => void;
  private readonly audit: (record: AuditRecord) => void;

  constructor(
    hosts: HostConnections,
    send: (message: ServerMessage | Buffer) => void,
    buffered: () => number,
    openSubscription: (id: RequestId, result: { video?: 'h264' }) => string | null,
    dropSubscription: (subscription: string) => void,
    audit: (record: AuditRecord) => void,
  ) {
    this.hosts = hosts;
    this.send = send;
    this.buffered = buffered;
    this.openSubscription = openSubscription;
    this.dropSubscription = dropSubscription;
    this.audit = audit;
  }

  private async connect(host: HostedMacosPlacement): Promise<Lease> {
    if (this.closed) throw new Error('the local connection closed');
    const lease = await this.hosts.acquire(host);
    if (this.closed) {
      lease.release();
      throw new Error('the local connection closed');
    }
    return lease;
  }

  private releaseAfter(lease: Lease, method: string, params: unknown): void {
    void lease.connection
      .request(method, params)
      .catch(() => {})
      .finally(lease.release);
  }

  async subscribe(
    id: RequestId,
    host: HostedMacosPlacement,
    params: Record<string, unknown>,
    register: (id: string, stop: () => void) => void,
  ): Promise<void> {
    let lease: Lease | undefined;
    let upstream: string | undefined;
    let local: string | null = null;
    try {
      lease = await this.connect(host);
      const connection = lease.connection;
      const reply = await connection.request('device-host.frames.subscribe', {
        session: host.session,
        fps: params.fps,
        maxEdge: params.maxEdge,
        video: params.video,
      });
      if ('error' in reply) throw new Error(reply.error.message);
      if (!isJsonObject(reply.result) || typeof reply.result.subscription !== 'string')
        throw new Error('the host sent no subscription');
      upstream = reply.result.subscription;
      if (this.closed) throw new Error('the local connection closed');
      local = this.openSubscription(id, reply.result.video === 'h264' ? { video: 'h264' } : {});
      if (!local) return this.releaseAfter(lease, 'device-host.unsubscribe', { subscription: upstream });
      const subscription = local;
      const hostSubscription = upstream;
      const leased = lease;
      const gate = new VideoGate(DEFAULT_VIDEO_LIMITS.congestedBytes);
      let askedAt = -Infinity;
      let congestedAt = -Infinity;
      let keyframeRetry: NodeJS.Timeout | null = null;
      let unroute: (() => void) | null = null;
      const delivery = new LatestFrames<Record<string, unknown> & { data: string }>(
        Math.min(
          (params.fps as number | undefined) ?? FRAME_FPS.default,
          reply.result.video === 'h264' ? FRAME_FPS.video : FRAME_FPS.max,
        ),
        this.buffered,
        (event) => this.send(event as unknown as ServerMessage),
      );
      const requestKeyframe = () => {
        keyframeRetry = null;
        if (!this.frames.has(subscription)) return;
        if (this.buffered() > DEFAULT_VIDEO_LIMITS.congestedBytes) {
          if (connection.supports('hosted-congestion') && Date.now() - congestedAt >= CONGESTION_NOTICE_MS) {
            congestedAt = Date.now();
            void connection.request('device-host.frames.congested', { subscription: hostSubscription }).catch(() => {});
          }
          keyframeRetry = setTimeout(requestKeyframe, FRAME_RETRY_MS);
          return;
        }
        if (Date.now() - askedAt < KEYFRAME_RETRY_MS) return;
        askedAt = Date.now();
        void connection.request('device-host.frames.keyframe', { subscription: hostSubscription }).catch(() => {});
      };
      const end = (hostEnded: boolean) => {
        if (!this.frames.delete(subscription)) return;
        delivery.stop();
        if (keyframeRetry) clearTimeout(keyframeRetry);
        unroute?.();
        this.dropSubscription(subscription);
        if (hostEnded) leased.release();
        else this.releaseAfter(leased, 'device-host.unsubscribe', { subscription: hostSubscription });
      };
      const failed = (message: string) => {
        if (!this.frames.has(subscription)) return;
        this.send({
          event: 'error',
          subscription,
          platform: 'macos',
          slot: 'default',
          error: { code: 'frames-failed', message: `${host.machine}: ${message}` },
        } as ServerMessage);
        end(true);
      };
      const stop = () => end(false);
      this.frames.set(subscription, {
        lease,
        subscription: hostSubscription,
        stop,
        reset: () => {
          gate.reset();
          askedAt = Date.now();
          if (keyframeRetry) clearTimeout(keyframeRetry);
          keyframeRetry = null;
        },
      });
      register(subscription, stop);
      unroute = connection.route(`s:${hostSubscription}`, {
        event: (event) => {
          if (!this.frames.has(subscription)) return;
          if (Buffer.isBuffer(event)) {
            const packet = rewriteVideoSubscription(event, hostSubscription, subscription);
            if (!packet) return;
            const keyframe = (packet[1]! & VIDEO_KEYFRAME) !== 0;
            if (gate.admit({ keyframe }, this.buffered()) === 'send') return this.send(packet);
            if (!keyframeRetry) requestKeyframe();
          } else if (['frame', 'frame-delayed', 'macos-windows', 'error'].includes(String(event.event))) {
            if (event.event === 'error')
              return failed(isJsonObject(event.error) ? String(event.error.message) : 'host frames failed');
            if (event.event === 'macos-windows')
              return this.send({ ...event, subscription } as unknown as ServerMessage);
            const forwarded = { ...event, subscription, platform: 'macos', slot: 'default' };
            if (event.event === 'frame') {
              if (typeof event.data !== 'string') return failed('the host sent an invalid JPEG frame');
              delivery.push({ ...forwarded, data: event.data });
            } else this.send(forwarded as unknown as ServerMessage);
          }
        },
        closed: (error) => failed(error.message),
      });
      if (!this.frames.has(subscription)) unroute();
    } catch (cause) {
      const message = `${host.machine}: ${(cause as Error).message}`;
      if (local && this.frames.has(local)) {
        this.send({ event: 'error', subscription: local, error: { code: 'frames-failed', message } });
        this.frames.get(local)!.stop();
        return;
      }
      if (lease && upstream) this.releaseAfter(lease, 'device-host.unsubscribe', { subscription: upstream });
      else lease?.release();
      if (local) {
        this.dropSubscription(local);
        this.send({ event: 'error', subscription: local, error: { code: 'frames-failed', message } });
      } else this.send({ id, error: { code: 'frames-failed', message } });
    }
  }

  keyframe(id: RequestId, subscription: string): boolean {
    const frame = this.frames.get(subscription);
    if (!frame) return false;
    frame.reset();
    void this.forward(id, frame.lease.connection, 'device-host.frames.keyframe', { subscription: frame.subscription });
    return true;
  }

  async begin(
    id: RequestId,
    host: HostedMacosPlacement,
    takeOver: boolean,
    allowed: () => boolean,
    context: { workspace: string; device: { id: string; name: string } },
  ): Promise<void> {
    let lease: Lease | undefined;
    let hostSession: string | undefined;
    let opened: string | undefined;
    const record = (outcome: { ok: boolean; error?: ProtocolError }) =>
      this.audit({
        at: new Date().toISOString(),
        ...context,
        platform: 'macos',
        action: takeOver ? 'control.take-over' : 'control.begin',
        ...outcome,
      });
    try {
      lease = await this.connect(host);
      const connection = lease.connection;
      const reply = await connection.request('device-host.control.begin', { session: host.session, takeOver });
      if ('error' in reply) {
        lease.release();
        record({ ok: false, error: reply.error });
        return this.send({ id, error: reply.error });
      }
      if (!isJsonObject(reply.result) || typeof reply.result.session !== 'string')
        throw new Error('the host sent no control session');
      hostSession = reply.result.session;
      if (this.closed || !allowed()) throw new Error('local control access ended');
      const session = `h${this.nextControl++}`;
      const entry = { lease, hostSession, unroute: () => {}, startedAt: Date.now(), ...context };
      this.controls.set(session, entry);
      opened = session;
      record({ ok: true });
      this.send({ id, result: { ...reply.result, session } });
      entry.unroute = connection.route(`c:${hostSession}`, {
        event: (event) => {
          if (this.controls.has(session) && !Buffer.isBuffer(event) && event.event === 'control-ended') {
            this.send({ ...event, session } as unknown as ServerMessage);
            this.endControl(session, String(event.reason), String(event.message), 'ended');
          }
        },
        closed: (error) => {
          if (!this.controls.has(session)) return;
          const message = `${host.machine}: ${error.message}`;
          this.send({ event: 'control-ended', session, reason: 'failed', message });
          this.endControl(session, 'failed', message, 'ended');
        },
      });
      if (!this.controls.has(session)) entry.unroute();
    } catch (cause) {
      const message = `${host.machine}: ${(cause as Error).message}`;
      if (opened) {
        this.send({ event: 'control-ended', session: opened, reason: 'failed', message });
        return this.endControl(opened, 'failed', message, 'end');
      }
      if (lease && hostSession) this.releaseAfter(lease, 'device-host.control.end', { session: hostSession });
      else lease?.release();
      const error: ProtocolError = { code: 'action-failed', message };
      record({ ok: false, error });
      this.send({ id, error });
    }
  }

  targetOf(session: string): SessionTarget | null {
    return this.controls.has(session) ? { platform: 'macos', postures: [] } : null;
  }

  control(id: RequestId, method: string, params: unknown): boolean {
    if (!isJsonObject(params) || typeof params.session !== 'string') return false;
    const entry = this.controls.get(params.session);
    if (!entry) return false;
    const response = this.forward(id, entry.lease.connection, `device-host.${method}`, {
      ...params,
      session: entry.hostSession,
    });
    if (method === 'control.end') this.endControl(params.session, null, 'The client ended the session.', response);
    return true;
  }

  private endControl(
    session: string,
    reason: string | null,
    message: string,
    host: 'ended' | 'end' | Promise<void>,
  ): void {
    const entry = this.controls.get(session);
    if (!entry) return;
    this.controls.delete(session);
    entry.unroute();
    this.audit({
      at: new Date().toISOString(),
      device: entry.device,
      workspace: entry.workspace,
      platform: 'macos',
      action: 'control.end',
      ok: true,
      durationMs: Date.now() - entry.startedAt,
      reason: `${reason ?? 'ended'}: ${message}`,
    });
    if (host === 'ended') entry.lease.release();
    else if (host === 'end') this.releaseAfter(entry.lease, 'device-host.control.end', { session: entry.hostSession });
    else void host.finally(entry.lease.release);
  }

  private async forward(id: RequestId, connection: Upstream, method: string, params: unknown): Promise<void> {
    try {
      this.send({ id, ...(await connection.request(method, params)) } as ServerMessage);
    } catch (cause) {
      this.send({ id, error: { code: 'action-failed', message: (cause as Error).message } });
    }
  }

  endControls(): void {
    for (const session of this.controls.keys()) {
      const message = 'Local control access ended.';
      this.send({ event: 'control-ended', session, reason: 'forbidden', message });
      this.endControl(session, 'forbidden', message, 'end');
    }
  }

  close(): void {
    this.closed = true;
    for (const session of this.controls.keys()) this.endControl(session, null, 'The client disconnected.', 'end');
    for (const frame of this.frames.values()) frame.stop();
  }
}
