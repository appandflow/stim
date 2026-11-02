import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { isJsonObject, type StatusPayload } from '@stim-cli/core/state';
import type { ControlHub, Controller, InputCommand } from './control.ts';
import { parseInput } from './control.ts';
import { LatestFrames } from './frame-delivery.ts';
import type { FrameHint } from './frame-helper.ts';
import { deviceKey, ownedDevice, type Device, type Frame, type FramePool, type LeaseLookup } from './frames.ts';
import type { ServerMessage } from './protocol.ts';
import { endedPage, loginPage, viewerPage } from './share-page.ts';
import type { OpenedRoute } from './share-route.ts';

type SharePlatform = 'ios' | 'android';

export interface ShareRequest {
  workspace: string;
  platform: SharePlatform;
  slot?: string;
  physical?: boolean;
  control: boolean;
  expiresMinutes: number;
}

export interface ShareRow {
  id: string;
  workspace: string;
  platform: SharePlatform;
  slot: string;
  physical: boolean;
  control: boolean;
  expiresAt: string;
  viewers: number;
}

export interface StartedShare extends ShareRow {
  url: string;
  password: string;
}

export interface ShareLimits {
  maxViewers: number;
  maxFailures: number;
  failureWindowMs: number;
  statusWaitMs: number;
  inputPerSecond: number;
  textCharsPerSecond: number;
}

const SHARE_LIMITS: ShareLimits = {
  maxViewers: 5,
  maxFailures: 10,
  failureWindowMs: 10 * 60_000,
  statusWaitMs: 60_000,
  inputPerSecond: 120,
  textCharsPerSecond: 40,
};

export const SHARE_EXPIRY = { default: 60, max: 480 } as const;

/** What the share hub needs of the rest of stim-server. */
export interface ShareDeps {
  frames: Pick<FramePool, 'subscribe'>;
  control: Pick<ControlHub, 'begin' | 'input' | 'targetOf' | 'endFor'>;
  subscribeStatus: (listener: StatusListener) => () => void;
  route: { open: (target: number) => Promise<OpenedRoute>; close: () => Promise<void> };
  lookup?: LeaseLookup;
  limits?: Partial<ShareLimits>;
}

export interface StatusListener {
  item: (payload: StatusPayload) => void;
  failed: (message: string) => void;
}

type Refusal = { code: 'bad-request' | 'action-failed'; message: string };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE = 'stim_share';
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 16;
const MAX_LOGIN_BYTES = 1024;
const MAX_MESSAGE_BYTES = 4096;
const MAX_LEASE_TIMES = 256;
const VIEW_HINT: FrameHint = { fps: 10, maxEdge: 1280 };
const BUTTONS: Record<SharePlatform, readonly string[]> = {
  ios: ['home', 'lock'],
  android: ['back', 'home', 'app-switch'],
};

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

function password(): string {
  let out = '';
  while (out.length < PASSWORD_LENGTH) {
    for (const byte of randomBytes(PASSWORD_LENGTH)) {
      if (byte < 256 - (256 % PASSWORD_ALPHABET.length) && out.length < PASSWORD_LENGTH) {
        out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      }
    }
  }
  return out;
}

function take(bucket: { tokens: number; at: number }, cost: number, perSecond: number, capacity: number): boolean {
  const now = Date.now();
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.at) / 1000) * perSecond);
  bucket.at = now;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

function cookieOf(request: IncomingMessage): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return null;
}

interface Viewer {
  socket: WebSocket;
  inputs: { tokens: number; at: number };
  characters: { tokens: number; at: number };
  stop: () => void;
}

interface Share {
  id: string;
  key: string;
  request: ShareRequest;
  passwordDigest: Buffer;
  expiresAt: number;
  device: Device;
  sessions: Set<string>;
  failures: number[];
  viewers: Set<Viewer>;
  owner: Controller;
  controlSession: string | null;
  controlStarting: Promise<string | null> | null;
  controlRetryAt: number;
  timer: NodeJS.Timeout;
  unwatch: () => void;
  ended: boolean;
}

/**
 * Public web shares of one workspace device each, served on one loopback listener behind one Funnel route. A share
 * exists only in memory: its URL token, password digest and sessions die with it and with the server.
 */
export class ShareHub {
  private readonly deps: ShareDeps;
  private readonly limits: ShareLimits;
  private readonly shares = new Map<string, Share>();
  private readonly leases = new Set<string>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private listener: Server | null = null;
  private base: string | null = null;
  private opening: Promise<string> | null = null;
  private closingRoute: Promise<void> = Promise.resolve();
  private closed = false;
  private next = 1;

  constructor(deps: ShareDeps) {
    this.deps = deps;
    this.limits = { ...SHARE_LIMITS, ...deps.limits };
  }

  /** The loopback port the listener serves, or null while no share is live. */
  get port(): number | null {
    const address = this.listener?.address();
    return typeof address === 'object' && address ? address.port : null;
  }

  async start(request: ShareRequest): Promise<StartedShare | Refusal> {
    if (this.closed) return { code: 'action-failed', message: 'stim-server is stopping.' };
    if (request.control && request.physical && request.platform === 'ios') {
      return { code: 'bad-request', message: 'A physical iPhone is view only: share it without --control.' };
    }
    const status = await this.status();
    if ('code' in status) return status;
    const device = ownedDevice(status, request, null, this.deps.lookup);
    if (typeof device === 'string') return { code: 'action-failed', message: device };
    let base: string;
    try {
      base = await this.open();
    } catch (cause) {
      return { code: 'action-failed', message: cause instanceof Error ? cause.message : String(cause) };
    }
    if (this.closed) return { code: 'action-failed', message: 'stim-server is stopping.' };
    if (this.base !== base)
      return { code: 'action-failed', message: 'The share listener closed while starting. Try again.' };
    const secret = token();
    const shown = password();
    const id = `w${this.next++}`;
    const expiresAt = Date.now() + request.expiresMinutes * 60_000;
    const share: Share = {
      id,
      key: digest(secret).toString('hex'),
      request,
      passwordDigest: digest(shown),
      expiresAt,
      device,
      sessions: new Set(),
      failures: [],
      viewers: new Set(),
      owner: {
        device: { id: `share-${id}`, name: 'Web share' },
        send: (message: ServerMessage) => this.controlEvent(share, message),
      },
      controlSession: null,
      controlStarting: null,
      controlRetryAt: 0,
      timer: setTimeout(() => void this.end(share, 'This share expired.'), request.expiresMinutes * 60_000),
      unwatch: () => {},
      ended: false,
    };
    share.timer.unref?.();
    this.shares.set(share.key, share);
    const attached = deviceKey(device);
    share.unwatch = this.deps.subscribeStatus({
      item: (payload) => {
        const resolved = ownedDevice(payload, request, attached, this.deps.lookup);
        if (typeof resolved === 'string') queueMicrotask(() => void this.end(share, resolved));
        else if (deviceKey(resolved) !== attached) queueMicrotask(() => void this.end(share, 'The device changed.'));
      },
      failed: () => {},
    });
    return { ...this.row(share), url: `${base}/s/${secret}/`, password: shown };
  }

  /**
   * `grantedAt` of the device leases shares took for control, kept after their sessions end because status shows the
   * lease until its release lands, so their driving is never recorded.
   */
  leaseTimes(): ReadonlySet<string> {
    return this.leases;
  }

  list(): ShareRow[] {
    return [...this.shares.values()].map((share) => this.row(share));
  }

  async stop(workspace: string | null, message = 'The share was stopped.'): Promise<ShareRow[]> {
    const stopping = [...this.shares.values()].filter(
      (share) => workspace === null || share.request.workspace === workspace,
    );
    const rows = stopping.map((share) => this.row(share));
    await Promise.all(stopping.map((share) => this.end(share, message)));
    return rows;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stop(null, 'stim-server stopped.');
    await this.closingRoute;
  }

  private row(share: Share): ShareRow {
    return {
      id: share.id,
      workspace: share.request.workspace,
      platform: share.request.platform,
      slot: share.request.slot ?? 'default',
      physical: share.request.physical === true,
      control: share.request.control,
      expiresAt: new Date(share.expiresAt).toISOString(),
      viewers: share.viewers.size,
    };
  }

  private status(): Promise<StatusPayload | Refusal> {
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (value: StatusPayload | Refusal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        resolve(value);
      };
      const timer = setTimeout(
        () => finish({ code: 'action-failed', message: 'stim status did not report the device in time.' }),
        this.limits.statusWaitMs,
      );
      unsubscribe = this.deps.subscribeStatus({
        item: (payload) => finish(payload),
        failed: (message) => finish({ code: 'action-failed', message }),
      });
      if (settled) unsubscribe();
    });
  }

  private open(): Promise<string> {
    if (this.base && this.listener) return Promise.resolve(this.base);
    this.opening ??= this.closingRoute
      .then(async () => {
        const server = createServer((request, response) => this.serve(request, response));
        server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve());
        });
        try {
          const address = server.address();
          if (typeof address !== 'object' || !address) throw new Error('The share listener has no port.');
          const opened = await this.deps.route.open(address.port);
          this.listener = server;
          this.base = opened.url;
          return opened.url;
        } catch (cause) {
          server.close();
          throw cause;
        }
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private async end(share: Share, message: string): Promise<void> {
    if (share.ended) return;
    share.ended = true;
    clearTimeout(share.timer);
    share.unwatch();
    this.shares.delete(share.key);
    for (const viewer of share.viewers) {
      viewer.stop();
      if (viewer.socket.readyState === viewer.socket.OPEN) {
        viewer.socket.send(JSON.stringify({ type: 'ended', message }));
        viewer.socket.close(1000, 'share ended');
      }
      viewer.socket.terminate();
    }
    share.viewers.clear();
    this.deps.control.endFor(share.owner, null, message);
    if (this.shares.size || !this.listener) return;
    const listener = this.listener;
    this.listener = null;
    this.base = null;
    listener.closeAllConnections();
    listener.close();
    this.closingRoute = this.closingRoute
      .then(() => this.deps.route.close())
      .catch((cause: Error) => {
        console.error(`stim-server: could not remove the share's Funnel route: ${cause.message}`);
      });
    await this.closingRoute;
  }

  private find(request: IncomingMessage): { share: Share; rest: string } | null {
    const url = request.url ?? '';
    const [, secret, rest] = /^\/s\/([^/?#]+)\/([^?#]*)(?:\?.*)?$/.exec(url) ?? [];
    if (secret === undefined || rest === undefined || !TOKEN.test(secret)) return null;
    const share = this.shares.get(digest(secret).toString('hex'));
    return share && !share.ended ? { share, rest } : null;
  }

  private signedIn(share: Share, request: IncomingMessage): boolean {
    const session = cookieOf(request);
    return session !== null && TOKEN.test(session) && share.sessions.has(digest(session).toString('hex'));
  }

  private respond(response: ServerResponse, status: number, html: string, nonce: string, extra = {}): void {
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; img-src blob:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      ...extra,
    });
    response.end(html);
  }

  private serve(request: IncomingMessage, response: ServerResponse): void {
    const nonce = randomBytes(16).toString('base64');
    const found = this.find(request);
    if (!found || (found.rest !== '' && found.rest !== 'login')) {
      request.resume();
      return this.respond(response, 404, endedPage(nonce), nonce);
    }
    const { share, rest } = found;
    if (rest === '' && request.method === 'GET') {
      if (this.signedIn(share, request)) {
        return this.respond(
          response,
          200,
          viewerPage(nonce, { control: share.request.control, buttons: BUTTONS[share.request.platform] }),
          nonce,
        );
      }
      return this.respond(response, 200, loginPage(nonce, null), nonce);
    }
    if (rest !== 'login' || request.method !== 'POST') {
      request.resume();
      return this.respond(response, 404, endedPage(nonce), nonce);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_LOGIN_BYTES) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => this.login(share, request, response, Buffer.concat(chunks).toString('utf8'), nonce));
  }

  private login(share: Share, request: IncomingMessage, response: ServerResponse, body: string, nonce: string): void {
    if (share.ended) return this.respond(response, 404, endedPage(nonce), nonce);
    const now = Date.now();
    share.failures = share.failures.filter((at) => now - at < this.limits.failureWindowMs);
    if (share.failures.length >= this.limits.maxFailures) {
      return this.respond(response, 429, loginPage(nonce, 'Too many wrong passwords. Try again later.'), nonce);
    }
    const given = new URLSearchParams(body).get('password') ?? '';
    if (!timingSafeEqual(digest(given), share.passwordDigest)) {
      share.failures.push(now);
      return this.respond(response, 401, loginPage(nonce, 'Wrong password.'), nonce);
    }
    const session = token();
    share.sessions.add(digest(session).toString('hex'));
    const path = (request.url ?? '').replace(/login(?:\?.*)?$/, '');
    const maxAge = Math.max(1, Math.floor((share.expiresAt - now) / 1000));
    response.writeHead(303, {
      location: path,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'set-cookie': `${COOKIE}=${session}; HttpOnly; Secure; SameSite=Strict; Path=${path}; Max-Age=${maxAge}`,
    });
    response.end();
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const found = this.find(request);
    if (!found || found.rest !== 'ws') return refuse(404, 'Not Found');
    const { share } = found;
    const host = request.headers.host;
    const origin = request.headers.origin;
    if (!host || (origin !== `https://${host}` && origin !== `http://${host}`)) return refuse(403, 'Forbidden');
    if (!this.signedIn(share, request)) return refuse(401, 'Unauthorized');
    if (share.viewers.size >= this.limits.maxViewers) return refuse(503, 'Service Unavailable');
    this.wss.handleUpgrade(request, socket, head, (ws) => this.watch(share, ws));
  }

  private watch(share: Share, socket: WebSocket): void {
    if (share.ended) {
      socket.close(1000, 'share ended');
      return;
    }
    const delivery = new LatestFrames<Frame>(
      VIEW_HINT.fps,
      () => socket.bufferedAmount,
      (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(Buffer.from(frame.data, 'base64'), { binary: true });
      },
    );
    const json = (message: Record<string, unknown>) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    const unsubscribe = this.deps.frames.subscribe(
      share.device,
      {
        frame: (frame) => delivery.push(frame),
        delayed: (delayed, reason) => json({ type: 'delayed', delayed, ...(reason ? { reason } : {}) }),
        failed: (message) => queueMicrotask(() => void this.end(share, message)),
      },
      VIEW_HINT,
    );
    let stopped = false;
    const viewer: Viewer = {
      socket,
      inputs: { tokens: this.limits.inputPerSecond, at: Date.now() },
      characters: { tokens: this.limits.textCharsPerSecond, at: Date.now() },
      stop: () => {
        if (stopped) return;
        stopped = true;
        delivery.stop();
        unsubscribe();
      },
    };
    share.viewers.add(viewer);
    socket.on('message', (data, binary) => {
      if (binary || !share.request.control) return;
      void this.input(share, viewer, data.toString());
    });
    socket.on('close', () => {
      viewer.stop();
      share.viewers.delete(viewer);
      if (share.viewers.size === 0 && share.controlSession) {
        this.deps.control.endFor(share.owner, null, 'The last viewer left.');
        share.controlSession = null;
      }
    });
    socket.on('error', () => socket.terminate());
  }

  private async input(share: Share, viewer: Viewer, raw: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isJsonObject(message)) return;
    const { type, ...fields } = message;
    const method =
      type === 'touch' ? 'input.touch' : type === 'text' ? 'input.text' : type === 'button' ? 'input.button' : null;
    if (!method) return;
    if (!take(viewer.inputs, 1, this.limits.inputPerSecond, this.limits.inputPerSecond)) return;
    const params =
      method === 'input.touch'
        ? { phase: fields.phase, x: fields.x, y: fields.y }
        : method === 'input.text'
          ? { text: fields.text }
          : { button: fields.button };
    if (method === 'input.button' && !BUTTONS[share.request.platform].includes(String(fields.button))) return;
    const session = await this.controlSession(share, viewer);
    if (!session || share.ended) return;
    const parsed = parseInput(method, { ...params, session }, (name) => this.deps.control.targetOf(share.owner, name));
    if ('code' in parsed) return;
    const command: InputCommand = parsed.value.command;
    if (
      command.input === 'text' &&
      !take(viewer.characters, command.text.length, this.limits.textCharsPerSecond, 256)
    ) {
      return;
    }
    const refused = await this.deps.control.input(share.owner, session, command);
    if (refused && 'code' in refused && viewer.socket.readyState === viewer.socket.OPEN) {
      viewer.socket.send(JSON.stringify({ type: 'control', message: refused.message }));
    }
  }

  private controlSession(share: Share, viewer: Viewer): Promise<string | null> {
    if (share.controlSession) return Promise.resolve(share.controlSession);
    if (share.controlStarting) return share.controlStarting;
    if (Date.now() < share.controlRetryAt) return Promise.resolve(null);
    const { workspace, platform, slot, physical } = share.request;
    share.controlStarting = this.deps.control
      .begin(
        share.owner,
        { workspace, platform, ...(slot ? { slot } : {}), ...(physical ? { physical } : {}) },
        workspace,
        () => !share.ended && share.viewers.size > 0,
      )
      .then((outcome) => {
        if ('code' in outcome) {
          share.controlRetryAt = Date.now() + 5000;
          if (viewer.socket.readyState === viewer.socket.OPEN) {
            viewer.socket.send(JSON.stringify({ type: 'control', message: outcome.message }));
          }
          return null;
        }
        if (share.ended || share.viewers.size === 0) {
          this.deps.control.endFor(share.owner, null, 'The share ended.');
          return null;
        }
        share.controlSession = outcome.session;
        const grantedAt = outcome.lease?.grantedAt;
        if (grantedAt) {
          this.leases.add(grantedAt);
          const [oldest] = this.leases;
          if (this.leases.size > MAX_LEASE_TIMES && oldest !== undefined) this.leases.delete(oldest);
        }
        return outcome.session;
      })
      .finally(() => {
        share.controlStarting = null;
      });
    return share.controlStarting;
  }

  private controlEvent(share: Share, message: ServerMessage): void {
    if (!('event' in message) || message.event !== 'control-ended') return;
    if (message.session !== share.controlSession) return;
    share.controlSession = null;
    for (const viewer of share.viewers) {
      if (viewer.socket.readyState === viewer.socket.OPEN) {
        viewer.socket.send(JSON.stringify({ type: 'control', message: `Control ended: ${message.message}` }));
      }
    }
  }
}
