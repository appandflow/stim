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
import { DEFAULT_VIDEO_LIMITS, rewriteVideoSubscription, VideoGate } from './video.ts';

const TIMEOUT_MS = 10_000;
const KEYFRAME_RETRY_MS = 1000;
type Reply = { result: unknown } | { error: ProtocolError };
type Event = Record<string, unknown> | Buffer;

export interface HostedRelayOptions {
  status: () => unknown | Promise<unknown>;
  endpoint?: (pinned: Endpoint) => Endpoint;
}

class Upstream {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  private buffered: Event[] = [];
  private event: ((event: Event) => void) | null = null;
  private ended: Error | null = null;
  onClose: ((error: Error) => void) | null = null;

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
        if (this.event) this.event(message);
        else this.buffered.push(message);
      }
    });
  }

  private safe(message: string): string {
    return message.replaceAll(this.token, '[redacted]');
  }

  private fail(message: string): void {
    if (this.ended) return;
    this.ended = new Error(this.safe(message));
    for (const pending of this.pending.values()) pending.reject(this.ended);
    this.pending.clear();
    this.onClose?.(this.ended);
    this.close();
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

  listen(event: (event: Event) => void, closed: (error: Error) => void): void {
    if (this.ended) throw this.ended;
    this.onClose = closed;
    this.event = event;
    for (const message of this.buffered) event(message);
    this.buffered = [];
  }

  close(): void {
    this.onClose = null;
    this.event = null;
    this.buffered = [];
    this.ended ??= new Error('the host connection closed');
    for (const pending of this.pending.values()) pending.reject(this.ended);
    this.pending.clear();
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
    else this.socket.close();
  }
}

export class HostedRelay {
  private readonly connections = new Set<Upstream>();
  private readonly frames = new Map<
    string,
    { connection: Upstream; subscription: string; reset: () => void; stop: () => void }
  >();
  private readonly controls = new Map<
    string,
    {
      connection: Upstream;
      hostSession: string;
      startedAt: number;
      workspace: string;
      device: { id: string; name: string };
    }
  >();
  private nextControl = 1;
  private closed = false;

  private readonly options: HostedRelayOptions;
  private readonly version: string;
  private readonly send: (message: ServerMessage | Buffer) => void;
  private readonly buffered: () => number;
  private readonly openSubscription: (id: RequestId, result: { video?: 'h264' }) => string | null;
  private readonly dropSubscription: (subscription: string) => void;
  private readonly audit: (record: AuditRecord) => void;

  constructor(
    options: HostedRelayOptions,
    version: string,
    send: (message: ServerMessage | Buffer) => void,
    buffered: () => number,
    openSubscription: (id: RequestId, result: { video?: 'h264' }) => string | null,
    dropSubscription: (subscription: string) => void,
    audit: (record: AuditRecord) => void,
  ) {
    this.options = options;
    this.version = version;
    this.send = send;
    this.buffered = buffered;
    this.openSubscription = openSubscription;
    this.dropSubscription = dropSubscription;
    this.audit = audit;
  }

  private async connect(host: HostedMacosPlacement): Promise<Upstream> {
    let connection: Upstream | undefined;
    let token = '';
    try {
      const credential = readDeviceHostMachines().find((entry) => entry.machine === host.machine);
      if (!credential || credential.state !== 'approved') throw new Error('no approved device-host credential');
      token = credential.deviceToken;
      const pinned = pinnedEndpoint(credential, await this.options.status());
      if (typeof pinned === 'string') throw new Error(pinned);
      if (this.closed) throw new Error('the local connection closed');
      connection = new Upstream(this.options.endpoint?.(pinned) ?? pinned, token);
      this.connections.add(connection);
      await connection.open(this.version);
      if (this.closed) throw new Error('the local connection closed');
      return connection;
    } catch (cause) {
      if (connection) this.release(connection);
      const reason = (cause as Error).message;
      throw new Error(token ? reason.replaceAll(token, '[redacted]') : reason, { cause });
    }
  }

  private release(connection: Upstream): void {
    this.connections.delete(connection);
    connection.close();
  }

  async subscribe(
    id: RequestId,
    host: HostedMacosPlacement,
    params: Record<string, unknown>,
    register: (id: string, stop: () => void) => void,
  ): Promise<void> {
    let connection: Upstream | undefined;
    let local: string | null = null;
    try {
      connection = await this.connect(host);
      const reply = await connection.request('device-host.frames.subscribe', {
        session: host.session,
        fps: params.fps,
        maxEdge: params.maxEdge,
        video: params.video,
      });
      if ('error' in reply) throw new Error(reply.error.message);
      if (!isJsonObject(reply.result) || typeof reply.result.subscription !== 'string')
        throw new Error('the host sent no subscription');
      const upstream = reply.result.subscription;
      if (this.closed) throw new Error('the local connection closed');
      local = this.openSubscription(id, reply.result.video === 'h264' ? { video: 'h264' } : {});
      if (!local) return this.release(connection);
      const subscription = local;
      const gate = new VideoGate(DEFAULT_VIDEO_LIMITS.congestedBytes);
      let askedAt = -Infinity;
      let keyframeRetry: NodeJS.Timeout | null = null;
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
          keyframeRetry = setTimeout(requestKeyframe, FRAME_RETRY_MS);
          return;
        }
        if (Date.now() - askedAt < KEYFRAME_RETRY_MS) return;
        askedAt = Date.now();
        void connection!.request('device-host.frames.keyframe', { subscription: upstream }).catch(() => {});
      };
      const stop = () => {
        delivery.stop();
        if (keyframeRetry) clearTimeout(keyframeRetry);
        this.frames.delete(subscription);
        this.dropSubscription(subscription);
        this.release(connection!);
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
        stop();
      };
      this.frames.set(subscription, {
        connection,
        subscription: upstream,
        stop,
        reset: () => {
          gate.reset();
          askedAt = Date.now();
          if (keyframeRetry) clearTimeout(keyframeRetry);
          keyframeRetry = null;
        },
      });
      register(subscription, stop);
      connection.listen(
        (event) => {
          if (!this.frames.has(subscription)) return;
          if (Buffer.isBuffer(event)) {
            const packet = rewriteVideoSubscription(event, upstream, subscription);
            if (!packet) return;
            const keyframe = (packet[1]! & VIDEO_KEYFRAME) !== 0;
            if (gate.admit({ keyframe }, this.buffered()) === 'send') return this.send(packet);
            if (!keyframeRetry) requestKeyframe();
          } else if (
            event.subscription === upstream &&
            ['frame', 'frame-delayed', 'error'].includes(String(event.event))
          ) {
            if (event.event === 'error')
              return failed(isJsonObject(event.error) ? String(event.error.message) : 'host frames failed');
            const forwarded = { ...event, subscription, platform: 'macos', slot: 'default' };
            if (event.event === 'frame') {
              if (typeof event.data !== 'string') return failed('the host sent an invalid JPEG frame');
              delivery.push({ ...forwarded, data: event.data });
            } else this.send(forwarded as unknown as ServerMessage);
          }
        },
        (error) => failed(error.message),
      );
    } catch (cause) {
      if (connection) this.release(connection);
      const message = (cause as Error).message;
      if (local) {
        this.frames.get(local)?.stop();
        this.dropSubscription(local);
        this.send({
          event: 'error',
          subscription: local,
          error: { code: 'frames-failed', message: `${host.machine}: ${message}` },
        });
      } else this.send({ id, error: { code: 'frames-failed', message: `${host.machine}: ${message}` } });
    }
  }

  keyframe(id: RequestId, subscription: string): boolean {
    const frame = this.frames.get(subscription);
    if (!frame) return false;
    frame.reset();
    void this.forward(id, frame.connection, 'device-host.frames.keyframe', { subscription: frame.subscription });
    return true;
  }

  async begin(
    id: RequestId,
    host: HostedMacosPlacement,
    takeOver: boolean,
    allowed: () => boolean,
    context: { workspace: string; device: { id: string; name: string } },
  ): Promise<void> {
    let connection: Upstream | undefined;
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
      connection = await this.connect(host);
      const reply = await connection.request('device-host.control.begin', { session: host.session, takeOver });
      if ('error' in reply) {
        this.release(connection);
        record({ ok: false, error: reply.error });
        return this.send({ id, error: reply.error });
      }
      if (!isJsonObject(reply.result) || typeof reply.result.session !== 'string')
        throw new Error('the host sent no control session');
      if (this.closed || !allowed()) throw new Error('local control access ended');
      const hostSession = reply.result.session;
      const session = `h${this.nextControl++}`;
      this.controls.set(session, { connection, hostSession, startedAt: Date.now(), ...context });
      opened = session;
      record({ ok: true });
      this.send({ id, result: { ...reply.result, session } });
      connection.listen(
        (event) => {
          if (
            this.controls.has(session) &&
            !Buffer.isBuffer(event) &&
            event.event === 'control-ended' &&
            event.session === hostSession
          ) {
            this.send({ ...event, session } as unknown as ServerMessage);
            this.endControl(session, String(event.reason), String(event.message));
          }
        },
        (error) => {
          if (!this.controls.has(session)) return;
          const message = `${host.machine}: ${error.message}`;
          this.send({ event: 'control-ended', session, reason: 'failed', message });
          this.endControl(session, 'failed', message);
        },
      );
    } catch (cause) {
      if (connection) this.release(connection);
      const message = `${host.machine}: ${(cause as Error).message}`;
      if (opened) {
        this.send({ event: 'control-ended', session: opened, reason: 'failed', message });
        this.endControl(opened, 'failed', message);
      } else {
        const error: ProtocolError = { code: 'action-failed', message };
        record({ ok: false, error });
        this.send({ id, error });
      }
    }
  }

  targetOf(session: string): SessionTarget | null {
    return this.controls.has(session) ? { platform: 'macos', postures: [] } : null;
  }

  control(id: RequestId, method: string, params: unknown): boolean {
    if (!isJsonObject(params) || typeof params.session !== 'string') return false;
    const entry = this.controls.get(params.session);
    if (!entry) return false;
    const response = this.forward(id, entry.connection, `device-host.${method}`, {
      ...params,
      session: entry.hostSession,
    });
    if (method === 'control.end') {
      this.endControl(params.session, null, 'The client ended the session.', false);
      void response.finally(() => this.release(entry.connection));
    }
    return true;
  }

  private endControl(session: string, reason: string | null, message: string, release = true): void {
    const entry = this.controls.get(session);
    if (!entry) return;
    this.controls.delete(session);
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
    if (release) this.release(entry.connection);
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
      this.endControl(session, 'forbidden', message);
    }
  }

  close(): void {
    this.closed = true;
    for (const session of this.controls.keys()) this.endControl(session, null, 'The client disconnected.');
    for (const frame of this.frames.values()) frame.stop();
    for (const connection of this.connections) connection.close();
    this.connections.clear();
  }
}
