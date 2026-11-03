import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { isJsonObject, type StatusPayload } from '@stim-cli/core/state';
import type { ControlHub, Controller, InputCommand } from './control.ts';
import { parseInput } from './control.ts';
import { FRAME_RETRY_MS, LatestFrames } from './frame-delivery.ts';
import type { FrameHint } from './frame-helper.ts';
import { deviceKey, ownedDevice, type Device, type Frame, type FramePool, type LeaseLookup } from './frames.ts';
import { FRAME_FPS, type DeviceFrameArtwork, type ServerMessage } from './protocol.ts';
import { targetKey } from './recorder.ts';
import { hostedOf, type HostedTarget, type ShareSource } from './share-hosted.ts';
import { endedPage, loginPage, SHARE_ASSETS, viewerPage } from './share-page.ts';
import type { OpenedRoute } from './share-route.ts';
import { DEFAULT_VIDEO_LIMITS, videoPacket, VideoGate, type AccessUnit } from './video.ts';

type SharePlatform = 'ios' | 'android';

export interface ShareRequest {
  workspace: string;
  platform: SharePlatform;
  slot?: string;
  physical?: boolean;
  control: boolean;
  expiresMinutes: number;
  /** A password the person chose, kept only as its digest; without it and without `passwordless`, one is generated. */
  password?: string;
  /** No login: the URL token alone admits a viewer. */
  passwordless?: boolean;
}

/** How a share admits viewers: a generated password, one the person set, or the URL token alone. */
type ShareAuth = 'generated' | 'set' | 'none';

export interface ShareRow {
  id: string;
  workspace: string;
  platform: SharePlatform;
  slot: string;
  physical: boolean;
  control: boolean;
  expiresAt: string;
  viewers: number;
  auth: ShareAuth;
}

/** `password` is present only when it was generated: a password the person set is never sent back. */
export interface StartedShare extends ShareRow {
  url: string;
  password?: string;
  /** How the link will not work as printed, such as a proxy mode without a public address. */
  warning?: string;
}

export interface ShareLimits {
  maxViewers: number;
  maxFailures: number;
  failureWindowMs: number;
  statusWaitMs: number;
  inputPerSecond: number;
  textCharsPerSecond: number;
  /** How long status can still show a share's control lease after its session ends: the lease's own duration. */
  leaseGraceMs: number;
}

const SHARE_LIMITS: ShareLimits = {
  maxViewers: 5,
  maxFailures: 10,
  failureWindowMs: 10 * 60_000,
  statusWaitMs: 20_000,
  inputPerSecond: 120,
  textCharsPerSecond: 40,
  leaseGraceMs: 2 * 60_000,
};

export const SHARE_EXPIRY = { default: 60, max: 480 } as const;

/** What the share hub needs of the rest of stim-server. */
export interface ShareDeps {
  frames: Pick<FramePool, 'subscribe' | 'keyframe' | 'congested'>;
  control: Pick<ControlHub, 'begin' | 'input' | 'targetOf' | 'endFor'>;
  subscribeStatus: (listener: StatusListener) => () => void;
  route: {
    /** Chooses how the listener about to open is exposed; returns the loopback port to bind, 0 for any free one. */
    prepare?: () => Promise<number>;
    open: (target: number) => Promise<OpenedRoute>;
    close: () => Promise<void>;
    /** The loopback port a route that could not be removed still points at, or null. */
    stranded: () => number | null;
    /** Retries removing the route `stranded` reports. */
    removeStranded: () => Promise<void>;
  };
  /** Frames and input for a device a host Mac runs for this machine; without it such a share is refused. */
  hosted?: (host: HostedTarget, request: ShareRequest) => ShareSource;
  lookup?: LeaseLookup;
  limits?: Partial<ShareLimits>;
  /** Called when {@link ShareHub.unrecordedTargets} changed. */
  recordingChanged?: () => void;
  /** Called when the last share has ended and its route is gone. */
  idle?: () => void;
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
const MAX_SESSIONS = 32;
const PING_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const IDLE_SOCKET_MS = 2 * PING_MS + 10_000;
const MAX_CONNECTIONS = 64;
const CLOSE_GRACE_MS = 2000;
const STRANDED_RETRY_MS = 30_000;
/** What public viewers are told; the reasons, which can name workspaces and clients, go to the server log only. */
const VIEWER_TEXT = {
  ended: 'This share has ended.',
  controlRefused: 'Control is not available right now. Try again in a moment.',
  inputRefused: 'That input was not accepted.',
  controlEnded: 'Control ended.',
};
const CSP =
  "default-src 'none'; img-src blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const ROTATE_COST = 30;
const INPUT_METHODS = new Map<string, Parameters<typeof parseInput>[0]>([
  ['touch', 'input.touch'],
  ['text', 'input.text'],
  ['key', 'input.key'],
  ['button', 'input.button'],
  ['rotate', 'input.rotate'],
]);
const VIEW_HINT: FrameHint = { fps: 10, maxEdge: 1280 };
const VIDEO_HINT: FrameHint = { fps: FRAME_FPS.video, maxEdge: VIEW_HINT.maxEdge };
const VIDEO_SUBSCRIPTION = 'share';
const KEYFRAME_REQUEST = '{"type":"keyframe"}';
const BUTTONS: Record<SharePlatform, readonly string[]> = {
  ios: ['home', 'lock'],
  android: ['back', 'home', 'app-switch'],
};

/** Whether the latest status shows the share's device driven, by an agent, a lock or another control session. */
function drivenNow(payload: StatusPayload | null, request: ShareRequest): boolean {
  const environment = payload?.environments?.find((candidate) => candidate.path === request.workspace);
  const slot = request.slot ?? 'default';
  const devices = slot === 'default' ? environment : environment?.slots?.find((candidate) => candidate.slot === slot);
  return devices?.[request.platform]?.activity?.state === 'driven';
}

/** The artwork as the viewer draws it: both layers as image data URLs. */
function viewerArtwork(artwork: DeviceFrameArtwork) {
  const { background, foreground, ...geometry } = artwork;
  return {
    ...geometry,
    background: `data:image/png;base64,${background}`,
    foreground: `data:image/png;base64,${foreground}`,
  };
}

function closeServer(server: Server): void {
  server.closeAllConnections();
  server.close();
}

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
  request: Omit<ShareRequest, 'password'>;
  auth: ShareAuth;
  passwordDigest: Buffer | null;
  expiresAt: number;
  device: Device | null;
  host: HostedTarget | null;
  source: ShareSource;
  sessions: Set<string>;
  failures: number[];
  viewers: Set<Viewer>;
  owner: Controller;
  controlSession: string | null;
  controlStarting: Promise<string | null> | null;
  controlRetryAt: number;
  recordKey: string | null;
  latest: StatusPayload | null;
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
  private readonly controlled = new Map<string, number>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private listener: Server | null = null;
  private base: string | null = null;
  private exposed: URL | null = null;
  private warning: string | null = null;
  private readonly stranded = new Map<number, Server>();
  private opening: Promise<string> | null = null;
  private closingRoute: Promise<void> = Promise.resolve();
  private closed = false;
  private next = 1;
  private starting = 0;
  private retrying: NodeJS.Timeout | null = null;

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
    this.starting++;
    try {
      return await this.begin(request);
    } finally {
      this.starting--;
      void this.closingRoute.then(() => this.checkIdle());
    }
  }

  /**
   * Whether nothing is shared, starting or still public: no share, no listener, no start in progress and no route
   * that could not be removed.
   */
  isIdle(): boolean {
    return (
      !this.shares.size && !this.listener && !this.starting && !this.opening && this.deps.route.stranded() === null
    );
  }

  private checkIdle(): void {
    if (this.closed) return;
    if (this.isIdle()) return this.deps.idle?.();
    if (
      this.shares.size ||
      this.listener ||
      this.starting ||
      this.opening ||
      this.retrying ||
      this.deps.route.stranded() === null
    )
      return;
    this.retrying = setTimeout(() => {
      this.retrying = null;
      void this.deps.route
        .removeStranded()
        .then(() => this.pruneStranded())
        .catch((cause: unknown) =>
          console.error(`stim-server: could not remove the share's Funnel route: ${String(cause)}`),
        )
        .finally(() => this.checkIdle());
    }, STRANDED_RETRY_MS);
    this.retrying.unref?.();
  }

  private async begin(request: ShareRequest): Promise<StartedShare | Refusal> {
    if (this.closed) return { code: 'action-failed', message: 'stim-server is stopping.' };
    if (request.control && request.physical && request.platform === 'ios') {
      return { code: 'bad-request', message: 'A physical iPhone is view only: share it without --control.' };
    }
    const status = await this.status();
    if ('code' in status) return status;
    if (this.closed) return { code: 'action-failed', message: 'stim-server is stopping.' };
    const host = this.deps.hosted ? hostedOf(status, request) : null;
    let device: Device | null = null;
    let source: ShareSource;
    if (host && this.deps.hosted) {
      if (!host.ready) {
        return {
          code: 'action-failed',
          message: `The hosted session on ${host.machine} is not ready yet. Wait for stim ${request.platform} --remote to finish, then share again.`,
        };
      }
      source = this.deps.hosted(host, request);
    } else {
      const owned = ownedDevice(status, request, null, this.deps.lookup);
      if (typeof owned === 'string') return { code: 'action-failed', message: owned };
      device = owned;
      source = this.localSource(owned);
    }
    let base: string;
    try {
      base = await this.open();
    } catch (cause) {
      return { code: 'action-failed', message: cause instanceof Error ? cause.message : String(cause) };
    }
    if (this.closed || this.base !== base) {
      void this.teardown();
      return {
        code: 'action-failed',
        message: this.closed ? 'stim-server is stopping.' : 'The share listener closed while starting. Try again.',
      };
    }
    const { password: chosen, ...kept } = request;
    const auth: ShareAuth = request.passwordless ? 'none' : chosen !== undefined ? 'set' : 'generated';
    const shown = auth === 'generated' ? password() : null;
    const secret = token();
    const id = `w${this.next++}`;
    const expiresAt = Date.now() + request.expiresMinutes * 60_000;
    const share: Share = {
      id,
      key: digest(secret).toString('hex'),
      request: kept,
      auth,
      passwordDigest: auth === 'none' ? null : digest(chosen ?? shown ?? ''),
      expiresAt,
      device,
      host,
      source,
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
      recordKey: null,
      latest: status,
      timer: setTimeout(() => void this.end(share, 'This share expired.'), request.expiresMinutes * 60_000),
      unwatch: () => {},
      ended: false,
    };
    share.timer.unref?.();
    this.shares.set(share.key, share);
    const attached = device ? deviceKey(device) : null;
    share.unwatch = this.deps.subscribeStatus({
      item: (payload) => {
        share.latest = payload;
        if (host) {
          const now = hostedOf(payload, request);
          if (now?.machine !== host.machine || now.session !== host.session) {
            queueMicrotask(() => void this.end(share, 'The hosted session ended.'));
          }
          return;
        }
        const resolved = ownedDevice(payload, request, attached, this.deps.lookup);
        if (typeof resolved === 'string') queueMicrotask(() => void this.end(share, resolved));
        else if (deviceKey(resolved) !== attached) queueMicrotask(() => void this.end(share, 'The device changed.'));
      },
      failed: () => {},
    });
    return {
      ...this.row(share),
      url: `${base}/s/${secret}/`,
      ...(shown ? { password: shown } : {}),
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }

  private localSource(device: Device): ShareSource {
    const { frames, control } = this.deps;
    return {
      subscribe: (listener, hint) => frames.subscribe(device, listener, hint),
      keyframe: () => frames.keyframe(device),
      congested: () => frames.congested(device),
      begin: (owner, target, workspace, allowed) => control.begin(owner, target, workspace, allowed),
      targetOf: (owner, session) => control.targetOf(owner, session),
      input: (owner, session, _method, _params, command) => control.input(owner, session, command),
      endFor: (owner, message) => control.endFor(owner, null, message),
      close: () => {},
    };
  }

  /**
   * Recorder target keys of the simulators and emulators shares control, kept for the lease's duration after a share
   * ends because status shows its lease until the release lands, so that lease alone never starts a recording.
   */
  unrecordedTargets(): ReadonlySet<string> {
    return new Set(this.controlled.keys());
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

  async stopOne(workspace: string, id: string, message = 'The share was stopped.'): Promise<ShareRow | null> {
    const share = [...this.shares.values()].find((candidate) => candidate.id === id);
    if (!share || share.request.workspace !== workspace) return null;
    const row = this.row(share);
    await this.end(share, message);
    return row;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.opening?.catch(() => {});
    await this.stop(null, 'stim-server stopped.');
    await this.teardown();
    if (this.retrying) clearTimeout(this.retrying);
    await this.deps.route.removeStranded().catch(() => {});
    for (const server of this.stranded.values()) closeServer(server);
    this.stranded.clear();
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
      auth: share.auth,
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
        const bindPort = (await this.deps.route.prepare?.()) ?? 0;
        const server = createServer(
          { headersTimeout: HEADERS_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
          (request, response) => this.serve(request, response),
        );
        server.maxConnections = MAX_CONNECTIONS;
        server.on('connection', (socket) => socket.setTimeout(IDLE_SOCKET_MS, () => socket.destroy()));
        server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
        await new Promise<void>((resolve, reject) => {
          const refused = (error: NodeJS.ErrnoException) =>
            reject(
              error.code === 'EADDRINUSE' && bindPort !== 0
                ? new Error(
                    `Port ${bindPort} on 127.0.0.1 is already in use, so the share listener cannot bind it. Stop what holds it, or choose another port with: stim settings set share.port <port>`,
                  )
                : error,
            );
          server.once('error', refused);
          server.listen(bindPort, '127.0.0.1', () => {
            server.off('error', refused);
            server.on('error', (error) => console.error(`stim-server: web share listener: ${error.message}`));
            resolve();
          });
        });
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : null;
        try {
          if (port === null) throw new Error('The share listener has no port.');
          if (this.closed) throw new Error('stim-server is stopping.');
          const opened = await this.deps.route.open(port);
          this.listener = server;
          this.base = opened.url;
          this.exposed = opened.proxied ? new URL(opened.url) : null;
          this.warning = opened.warning ?? null;
          this.pruneStranded();
          return opened.url;
        } catch (cause) {
          if (port !== null && this.deps.route.stranded() === port) this.stranded.set(port, server);
          else closeServer(server);
          this.pruneStranded();
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
    console.error(`stim-server: web share ${share.id} ended: ${message}`);
    for (const viewer of share.viewers) {
      viewer.stop();
      const { socket } = viewer;
      if (socket.readyState !== socket.OPEN) {
        socket.terminate();
        continue;
      }
      socket.send(JSON.stringify({ type: 'ended', message: VIEWER_TEXT.ended }));
      socket.close(1000, 'share ended');
      setTimeout(() => socket.terminate(), CLOSE_GRACE_MS).unref?.();
    }
    share.viewers.clear();
    share.source.endFor(share.owner, message);
    share.source.close();
    this.releaseRecording(share);
    await this.teardown();
  }

  /**
   * Once no share is live, removes the Funnel route and only then closes the listener, so the public route never
   * points at a free loopback port. A listener whose route could not be removed stays bound, answering 404, until a
   * later route replaces it or the server stops.
   */
  private teardown(): Promise<void> {
    if (this.shares.size || !this.listener) return this.closingRoute;
    const listener = this.listener;
    this.listener = null;
    this.base = null;
    this.exposed = null;
    this.warning = null;
    this.closingRoute = this.closingRoute
      .then(() => this.deps.route.close())
      .then(
        () => closeServer(listener),
        (cause: unknown) => {
          console.error(`stim-server: could not remove the share's Funnel route: ${String(cause)}`);
          const address = listener.address();
          if (typeof address === 'object' && address) this.stranded.set(address.port, listener);
          this.pruneStranded();
        },
      )
      .then(() => this.checkIdle());
    return this.closingRoute;
  }

  /**
   * Keeps bound, answering 404, only the listener a route that could not be removed still points at, so that public
   * route never reaches a free port; closes the others.
   */
  private pruneStranded(): void {
    const routed = this.deps.route.stranded();
    for (const [port, server] of this.stranded) {
      if (port === routed) continue;
      closeServer(server);
      this.stranded.delete(port);
    }
  }

  /**
   * Exempts the share's device from recording its control lease, before that lease exists. A device something else
   * already drives is left alone: the share's control is refused there, and that driver stays recorded.
   */
  private holdRecording(share: Share): void {
    if (share.request.physical || share.host || share.recordKey) return;
    const { workspace, platform, slot } = share.request;
    const key = targetKey({ workspace, platform, slot });
    if (!this.controlled.has(key) && drivenNow(share.latest, share.request)) return;
    share.recordKey = key;
    this.controlled.set(share.recordKey, (this.controlled.get(share.recordKey) ?? 0) + 1);
    this.deps.recordingChanged?.();
  }

  /**
   * Releases the share's recording exemption once a lease it took, which status can still show, has surely expired,
   * or at once when it took none.
   */
  private releaseRecording(share: Share, leased = true): void {
    const key = share.recordKey;
    if (!key) return;
    share.recordKey = null;
    const release = () => {
      const count = (this.controlled.get(key) ?? 1) - 1;
      if (count > 0) this.controlled.set(key, count);
      else this.controlled.delete(key);
      this.deps.recordingChanged?.();
    };
    if (leased) setTimeout(release, this.limits.leaseGraceMs).unref?.();
    else release();
  }

  private find(request: IncomingMessage): { share: Share; rest: string } | null {
    let url = request.url ?? '';
    const prefix = this.exposed?.pathname.replace(/\/$/, '') ?? '';
    if (prefix) {
      if (!url.startsWith(`${prefix}/`)) return null;
      url = url.slice(prefix.length);
    }
    const [, secret, rest] = /^\/s\/([^/?#]+)\/([^?#]*)(?:\?.*)?$/.exec(url) ?? [];
    if (secret === undefined || rest === undefined || !TOKEN.test(secret)) return null;
    const share = this.shares.get(digest(secret).toString('hex'));
    return share && !share.ended ? { share, rest } : null;
  }

  private signedIn(share: Share, request: IncomingMessage): boolean {
    if (share.passwordDigest === null) return true;
    const session = cookieOf(request);
    return session !== null && TOKEN.test(session) && share.sessions.has(digest(session).toString('hex'));
  }

  private respond(response: ServerResponse, status: number, html: string, extra = {}): void {
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'content-security-policy': CSP,
      ...extra,
    });
    response.end(html);
  }

  private asset(request: IncomingMessage, response: ServerResponse): boolean {
    const asset = /^\/s\/assets\/([\w.]+)$/.exec(request.url ?? '');
    const file = asset?.[1] ? SHARE_ASSETS[asset[1]] : undefined;
    if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) return false;
    response.writeHead(200, {
      'content-type': file.type,
      'cache-control': 'no-cache',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': CSP,
    });
    response.end(request.method === 'HEAD' ? undefined : file.body);
    return true;
  }

  private serve(request: IncomingMessage, response: ServerResponse): void {
    if (this.asset(request, response)) return;
    const found = this.find(request);
    if (!found || (found.rest !== '' && found.rest !== 'login')) {
      request.resume();
      return this.respond(response, 404, endedPage());
    }
    const { share, rest } = found;
    if (rest === '' && request.method === 'GET') {
      if (this.signedIn(share, request)) {
        const { platform, control, physical } = share.request;
        return this.respond(
          response,
          200,
          viewerPage({ control, platform, buttons: BUTTONS[platform], rotate: !physical }),
        );
      }
      return this.respond(response, 200, loginPage(null));
    }
    if (rest !== 'login' || request.method !== 'POST' || share.passwordDigest === null) {
      request.resume();
      return this.respond(response, 404, endedPage());
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
    request.on('end', () => this.login(share, request, response, Buffer.concat(chunks).toString('utf8')));
  }

  private login(share: Share, request: IncomingMessage, response: ServerResponse, body: string): void {
    if (share.ended || !share.passwordDigest) return this.respond(response, 404, endedPage());
    const now = Date.now();
    share.failures = share.failures.filter((at) => now - at < this.limits.failureWindowMs);
    if (share.failures.length >= this.limits.maxFailures) {
      return this.respond(response, 429, loginPage('Too many wrong passwords. Try again later.'));
    }
    const given = new URLSearchParams(body).get('password') ?? '';
    if (!timingSafeEqual(digest(given), share.passwordDigest)) {
      share.failures.push(now);
      return this.respond(response, 401, loginPage('Wrong password.'));
    }
    const session = token();
    share.sessions.add(digest(session).toString('hex'));
    const [oldest] = share.sessions;
    if (share.sessions.size > MAX_SESSIONS && oldest !== undefined) share.sessions.delete(oldest);
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
    // Node's http server drops its own socket error listener once it emits 'upgrade'; without one, a peer that resets
    // the connection after a refusal would raise an uncaught ECONNRESET.
    socket.on('error', () => socket.destroy());
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
        socket.destroy(),
      );
    };
    const found = this.find(request);
    if (!found || found.rest !== 'ws') return refuse(404, 'Not Found');
    const { share } = found;
    const host = request.headers.host;
    const origin = request.headers.origin;
    const sameOrigin = this.exposed
      ? origin === this.exposed.origin
      : host !== undefined && (origin === `https://${host}` || origin === `http://${host}`);
    if (!sameOrigin) return refuse(403, 'Forbidden');
    if (!this.signedIn(share, request)) return refuse(401, 'Unauthorized');
    if (share.viewers.size >= this.limits.maxViewers) return refuse(503, 'Service Unavailable');
    const video = new URL(request.url ?? '', 'http://share.invalid').searchParams.get('codec') === 'h264';
    this.wss.handleUpgrade(request, socket, head, (ws) => this.watch(share, ws, video));
  }

  private watch(share: Share, socket: WebSocket, video: boolean): void {
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
    let stopped = false;
    const gate = new VideoGate(DEFAULT_VIDEO_LIMITS.congestedBytes);
    let sequence = 0;
    let draining: NodeJS.Timeout | null = null;
    const drain = () => {
      draining = null;
      if (stopped) return;
      if (socket.bufferedAmount <= DEFAULT_VIDEO_LIMITS.congestedBytes) return share.source.keyframe();
      share.source.congested();
      draining = setTimeout(drain, FRAME_RETRY_MS);
    };
    const unsubscribe = share.source.subscribe(
      {
        frame: (frame) => delivery.push(frame),
        ...(video
          ? {
              video: (unit: AccessUnit) => {
                if (socket.readyState !== socket.OPEN) return;
                const verdict = gate.admit(unit, socket.bufferedAmount);
                if (verdict === 'send')
                  socket.send(videoPacket(VIDEO_SUBSCRIPTION, sequence++, unit), { binary: true });
                else if (verdict === 'congested' && !draining) drain();
              },
            }
          : {}),
        delayed: (delayed) => json({ type: 'delayed', delayed }),
        artwork: (artwork) => json({ type: 'artwork', artwork: artwork && viewerArtwork(artwork) }),
        failed: (message) => queueMicrotask(() => void this.end(share, message)),
      },
      video ? VIDEO_HINT : VIEW_HINT,
    );
    if (video) share.source.keyframe();
    json({ type: 'hello', expiresAt: new Date(share.expiresAt).toISOString() });
    const viewer: Viewer = {
      socket,
      inputs: { tokens: this.limits.inputPerSecond, at: Date.now() },
      characters: { tokens: this.limits.textCharsPerSecond, at: Date.now() },
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (draining) clearTimeout(draining);
        delivery.stop();
        unsubscribe();
      },
    };
    share.viewers.add(viewer);
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, PING_MS);
    ping.unref?.();
    socket.on('message', (data, binary) => {
      if (binary) return;
      const text = data.toString();
      if (text === KEYFRAME_REQUEST) {
        if (!video || !take(viewer.inputs, 1, this.limits.inputPerSecond, this.limits.inputPerSecond)) return;
        gate.reset();
        share.source.keyframe();
        return;
      }
      if (share.request.control) void this.input(share, viewer, text);
    });
    socket.on('close', () => {
      clearInterval(ping);
      viewer.stop();
      share.viewers.delete(viewer);
      if (share.viewers.size === 0 && share.controlSession) {
        share.source.endFor(share.owner, 'The last viewer left.');
        share.controlSession = null;
        this.releaseRecording(share);
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
    const method = INPUT_METHODS.get(String(type));
    if (!method) return;
    const cost = method === 'input.rotate' ? ROTATE_COST : 1;
    if (!take(viewer.inputs, cost, this.limits.inputPerSecond, this.limits.inputPerSecond)) return;
    const params =
      method === 'input.touch'
        ? { phase: fields.phase, x: fields.x, y: fields.y }
        : method === 'input.text'
          ? { text: fields.text }
          : method === 'input.key'
            ? { key: fields.key }
            : method === 'input.rotate'
              ? { direction: fields.direction }
              : { button: fields.button };
    if (method === 'input.button' && !BUTTONS[share.request.platform].includes(String(fields.button))) return;
    const session = await this.controlSession(share, viewer);
    if (!session || share.ended) return;
    const parsed = parseInput(method, { ...params, session }, (name) => share.source.targetOf(share.owner, name));
    if ('code' in parsed) return;
    const command: InputCommand = parsed.value.command;
    if (
      command.input === 'text' &&
      !take(viewer.characters, command.text.length, this.limits.textCharsPerSecond, 256)
    ) {
      return;
    }
    const refused = await share.source.input(share.owner, session, method, { ...params }, command);
    if (refused && 'code' in refused) {
      console.error(`stim-server: web share ${share.id} input refused: ${refused.message}`);
      if (viewer.socket.readyState === viewer.socket.OPEN) {
        viewer.socket.send(JSON.stringify({ type: 'control', message: VIEWER_TEXT.inputRefused }));
      }
    }
  }

  private controlSession(share: Share, viewer: Viewer): Promise<string | null> {
    if (share.controlSession) return Promise.resolve(share.controlSession);
    if (share.controlStarting) return share.controlStarting;
    if (Date.now() < share.controlRetryAt) return Promise.resolve(null);
    const { workspace, platform, slot, physical } = share.request;
    this.holdRecording(share);
    share.controlStarting = share.source
      .begin(
        share.owner,
        { workspace, platform, ...(slot ? { slot } : {}), ...(physical ? { physical } : {}) },
        workspace,
        () => !share.ended && share.viewers.size > 0,
      )
      .then((outcome) => {
        if ('code' in outcome) {
          share.controlRetryAt = Date.now() + 5000;
          this.releaseRecording(share, outcome.code !== 'device-busy');
          console.error(`stim-server: web share ${share.id} control refused: ${outcome.message}`);
          if (viewer.socket.readyState === viewer.socket.OPEN) {
            viewer.socket.send(JSON.stringify({ type: 'control', message: VIEWER_TEXT.controlRefused }));
          }
          return null;
        }
        if (share.ended || share.viewers.size === 0) {
          share.source.endFor(share.owner, 'The share ended.');
          this.releaseRecording(share);
          return null;
        }
        share.controlSession = outcome.session;
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
    this.releaseRecording(share);
    console.error(`stim-server: web share ${share.id} control ended: ${message.message}`);
    for (const viewer of share.viewers) {
      if (viewer.socket.readyState === viewer.socket.OPEN) {
        viewer.socket.send(JSON.stringify({ type: 'control', message: VIEWER_TEXT.controlEnded }));
      }
    }
  }
}
