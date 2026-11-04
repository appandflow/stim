import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { isJsonObject, SHARE_TOKEN, type StatusPayload } from '@stim-cli/core/state';
import type { ControlHub, Controller, InputCommand } from './control.ts';
import { CLIPBOARD_INPUT_COST, parseInput, take } from './control.ts';
import { MAX_CLIENT_MESSAGE_BYTES } from '@stim-cli/core/noise-session';
import { FRAME_RETRY_MS, LatestFrames } from './frame-delivery.ts';
import type { FrameHint } from './frame-helper.ts';
import { deviceKey, ownedDevice, type Device, type Frame, type FramePool, type LeaseLookup } from './frames.ts';
import { presenceKey, type PresenceHub } from './presence.ts';
import {
  FRAME_FPS,
  SHARE_SLUG_PATTERN,
  type DeviceFrameArtwork,
  type PresenceParticipant,
  type ServerMessage,
} from './protocol.ts';
import { targetKey } from './recorder.ts';
import { hostedOf, type HostedTarget, type ShareSource } from './share-hosted.ts';
import { endedPage, loginPage, SHARE_ASSETS, viewerPage } from './share-page.ts';
import { simulatorAppName, titleFacts, viewerTitle, type TitleFacts } from './share-title.ts';
import { accessFor, cleanName, digest, guestName, viewerColor, type ShareAccess } from './share-identity.ts';
import type { OpenedRoute } from './share-route.ts';
import { DEFAULT_VIDEO_LIMITS, videoPacket, VideoGate, type AccessUnit } from './video.ts';
import { cleanupRtc, openRtc } from './webrtc-sender.ts';

type SharePlatform = 'ios' | 'android';

/** `waiting` while the share's device is away: viewers stay signed in, and frames resume with the device. */
type ShareState = 'live' | 'waiting';

/** What a share is of, without the password a request may carry. */
export type ShareTarget = Omit<ShareRequest, 'password'>;

export interface ShareRequest {
  workspace: string;
  platform: SharePlatform;
  slot?: string;
  physical?: boolean;
  control: boolean;
  expiresMinutes: number;
  /** Starts the share under this URL token, which a share the same person stopped had; without it one is generated. */
  token?: string;
  /** The exact expiry, in epoch milliseconds, of a share that starts again; without it, `expiresMinutes` from now. */
  expiresAt?: number;
  /** A password the person chose, kept only as its digest; without it and without `passwordless`, one is generated. */
  password?: string;
  /** No login: the URL token alone admits a viewer. */
  passwordless?: boolean;
  /** A second, view-only password; with `control` and a password. Without its own `password`, one is generated. */
  view?: { password?: string };
  /** The link path, `/s/<slug>/`, in place of the random URL token; never with `passwordless`. */
  slug?: string;
}

/** How a share admits viewers: a generated password, one the person set, or the URL token alone. */
type ShareAuth = 'generated' | 'set' | 'none';
type ViewAuth = 'generated' | 'set' | null;

export interface ShareRow {
  id: string;
  workspace: string;
  platform: SharePlatform;
  slot: string;
  physical: boolean;
  control: boolean;
  expiresAt: string;
  viewers: number;
  state: ShareState;
  auth: ShareAuth;
  viewAuth: ViewAuth;
  slug?: string;
}

/** `password` and `viewPassword` are present only when generated: a password the person set is never sent back. */
export interface StartedShare extends ShareRow {
  url: string;
  password?: string;
  viewPassword?: string;
  /** How the link will not work as printed, such as a proxy mode without a public address. */
  warning?: string;
}

export interface ShareLimits {
  maxViewers: number;
  maxFailures: number;
  /** New view sessions one share admits per `failureWindowMs`. */
  maxViewLogins: number;
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
  maxViewLogins: 30,
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
  control: Pick<ControlHub, 'begin' | 'input' | 'release' | 'targetOf' | 'endFor' | 'endById'>;
  /** Who else touches a local device; without it viewers see only their own touches. */
  presence?: Pick<PresenceHub, 'subscribe' | 'join' | 'leave'>;
  subscribeStatus: (listener: StatusListener) => () => void;
  route: {
    /** Chooses how the listener about to open is exposed; returns the loopback port to bind, 0 for any free one. */
    prepare?: () => Promise<number>;
    /** After `prepare`: whether the choice is a reverse proxy at a public address, whose listener a long-running server keeps bound. */
    standing?: () => boolean;
    open: (target: number) => Promise<OpenedRoute>;
    close: () => Promise<void>;
    /** The loopback port a route that could not be removed still points at, or null. */
    stranded: () => number | null;
    /** Retries removing the route `stranded` reports. */
    removeStranded: () => Promise<void>;
  };
  /**
   * Whether viewers of a share may take video over WebRTC: `share.webrtc` is on and, for a device on this machine,
   * node-datachannel loads here. Without it viewers get WebSocket video only and WebRTC offers are refused.
   */
  webrtc?: (hosted: boolean) => boolean;
  /** Frames and input for a device a host Mac runs for this machine; without it such a share is refused. */
  hosted?: (host: HostedTarget, request: ShareTarget) => ShareSource;
  /** The display name of an app on a simulator, for the page titles; defaults to reading its Info.plist. */
  appName?: (udid: string, bundleId: string) => Promise<string | null>;
  lookup?: LeaseLookup;
  limits?: Partial<ShareLimits>;
  /** Called when {@link ShareHub.unrecordedTargets} changed. */
  recordingChanged?: () => void;
  /** Called when the last share has ended and its route is gone. */
  idle?: () => void;
  /**
   * Holds the workspace's native-run claim while a share reads its device and registers, so an automatic shutdown or
   * deletion of the workspace's devices, which reads the share list under that claim, runs wholly before or wholly
   * after it. Waits a bounded time for a holder; `stop` ends the wait.
   */
  holdWorkspace?: (workspace: string, stop: () => boolean) => Promise<WorkspaceHold | Refusal>;
}

export interface WorkspaceHold {
  release: () => void;
}

export interface StatusListener {
  item: (payload: StatusPayload) => void;
  failed: (message: string) => void;
}

/** `busy`: the workspace's native-run claim is held, which a restore waits out instead of giving up. */
export type Refusal = { code: 'bad-request' | 'action-failed'; message: string; busy?: true };

const SLUG = new RegExp(SHARE_SLUG_PATTERN);
const COOKIE = 'stim_share';
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 16;
const MAX_LOGIN_BYTES = 1024;
const MAX_MESSAGE_BYTES = MAX_CLIENT_MESSAGE_BYTES;
const MAX_SESSIONS = 32;
const RENAME_MS = 5000;
/** Presence a viewer's socket is sent while it is backed up: no moves, only the touches that change who is down. */
const PRESENCE_BACKLOG_BYTES = 64 * 1024;
const PING_MS = 30_000;
const PAGE_ID = /^[0-9a-f]{32}$/;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const IDLE_SOCKET_MS = 2 * PING_MS + 10_000;
const MAX_CONNECTIONS = 64;
const CLOSE_GRACE_MS = 2000;
const STRANDED_RETRY_MS = 30_000;
/** How soon a waiting share looks for its device again, and the most it waits between tries after a failed stream. */
const RESUME_MIN_MS = 2000;
const RESUME_MAX_MS = 30_000;
/** What public viewers are told; the reasons, which can name workspaces and clients, go to the server log only. */
const VIEWER_TEXT = {
  ended: 'This share has ended.',
  waiting: 'Waiting for the device...',
  controlRefused: 'Control is not available right now. Try again in a moment.',
  inputRefused: 'That input was not accepted.',
  clipboardRefused: 'The device did not take or return its clipboard.',
  pasteBusy: 'The device is still typing the previous paste.',
  pasteSuggestion: 'If nothing appears, tap the paste suggestion on the device.',
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
  ['clipboard-set', 'input.clipboard.set'],
  ['clipboard-get', 'input.clipboard.get'],
]);
const VIEW_HINT: FrameHint = { fps: 10, maxEdge: 1280 };
const VIDEO_HINT: FrameHint = { fps: FRAME_FPS.video, maxEdge: VIEW_HINT.maxEdge };
const VIDEO_SUBSCRIPTION = 'share';
/** What a viewer on WebRTC still takes from the share socket: artwork and delay events, so a trickle of JPEG frames. */
const RTC_META_HINT: FrameHint = { fps: 1, maxEdge: 256 };
/** The least time between two clock pings from one viewer; the stats panel sends one every 2 s. */
const CLOCK_MIN_MS = 250;
const KEYFRAME_REQUEST = '{"type":"keyframe"}';
export const BUTTONS: Record<SharePlatform, readonly string[]> = {
  ios: ['home', 'lock'],
  android: ['back', 'home', 'app-switch'],
};

/** Whether the latest status shows the share's device driven, by an agent, a lock or another control session. */
function drivenNow(payload: StatusPayload | null, request: ShareTarget): boolean {
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

/**
 * Makes room for a new session of `access` under {@link MAX_SESSIONS}: drops the oldest session of that access, and
 * for a control login, with none left, the oldest view one. A view login never drops a control session; false when it
 * would have to.
 */
function makeRoom(sessions: Map<string, Login>, access: ShareAccess): boolean {
  if (sessions.size < MAX_SESSIONS) return true;
  const entries = [...sessions];
  const oldest =
    entries.find(([, login]) => login.access === access) ?? (access === 'control' ? entries[0] : undefined);
  if (!oldest) return false;
  sessions.delete(oldest[0]);
  return true;
}

function cookieOf(request: IncomingMessage): string | null {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return null;
}

/** A signed-in browser, known by its cookie: the access its password gave and the name it chose. */
interface Login {
  access: ShareAccess;
  name: string | null;
}

interface Viewer {
  who: PresenceParticipant;
  /** The name this viewer chose, if any; without one it is shown as `Guest N`. */
  chosen: string | null;
  renamedAt: number;
  login: Login | null;
  pageId: string | null;
  socket: WebSocket;
  /** Whether the page asked for H.264 access units over this socket. */
  video: boolean;
  /** Whether the page's video comes over its WebRTC peer instead of this socket, which then sends artwork and delay events only. */
  rtc: boolean;
  /** The WebRTC peer that may send this viewer's video, or null. */
  peer: { close: () => void } | null;
  /** Whether a WebRTC offer is being answered, so a second one waits for the first to end. */
  offering: boolean;
  clockAt: number;
  inputs: { tokens: number; at: number };
  characters: { tokens: number; at: number };
  /** Stops what feeds the viewer from its source, which a waiting share has none of; null while it is fed by none. */
  detach: (() => void) | null;
  /** Gates the viewer's video while it is fed by a source. */
  gate: VideoGate | null;
  /** Feeds the viewer from its source again after `rtc` changed; null while it is fed by none. */
  refeed: (() => void) | null;
  stopPresence: (() => void) | null;
}

/** What a share's status shows it is of: a local device or a hosted session, as the key that tells them apart. */
interface Bound {
  key: string;
  hosted: boolean;
  /** The local device behind `open`; null for a hosted session. */
  device: Device | null;
  open: (request: ShareTarget) => ShareSource;
}

interface Share {
  id: string;
  key: string;
  request: ShareTarget;
  auth: ShareAuth;
  passwordDigest: Buffer | null;
  viewDigest: Buffer | null;
  viewAuth: ViewAuth;
  expiresAt: number;
  state: ShareState;
  /** Key of the device or hosted session the share is fed by; null while it waits. */
  bound: string | null;
  /** Whether the share was last fed by a hosted session, which a waiting share keeps for its page. */
  hosted: boolean;
  /** The local device the share is fed by; null for a hosted session and while the share waits. */
  device: Device | null;
  /** The source of the device now fed from; null while the share waits. */
  source: ShareSource | null;
  /** Not before this time (epoch ms) does a share that lost its stream look for its device again. */
  resumeAt: number;
  backoff: number;
  retry: NodeJS.Timeout | null;
  sessions: Map<string, Login>;
  failures: number[];
  /** When each recent new view session was admitted. */
  viewLogins: number[];
  viewers: Set<Viewer>;
  owner: Controller;
  controlSession: string | null;
  controlStarting: Promise<string | null> | null;
  controlRetryAt: number;
  controlUsed: boolean;
  recordKey: string | null;
  latest: StatusPayload | null;
  /** What the shared device's status says for the page titles, and the app's display name once read. */
  facts: TitleFacts;
  app: string | null;
  timer: NodeJS.Timeout;
  unwatch: () => void;
  ended: boolean;
}

/**
 * Public web shares of one workspace device each, served on one loopback listener behind one Funnel route. A share
 * exists only in memory: its URL token, password digest and sessions die with it and with the server. While its device
 * is away it waits, keeping all of that, and feeds its viewers again when the slot's device is back.
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
  private opening: Promise<string | null> | null = null;
  private persistent = false;
  /** The listener stays bound with no share, answering the not-found page. */
  private kept = false;
  private closingRoute: Promise<void> = Promise.resolve();
  private closed = false;
  private next = 1;
  private nextViewer = 1;
  private starting = 0;
  private retrying: NodeJS.Timeout | null = null;

  constructor(deps: ShareDeps) {
    this.deps = deps;
    this.limits = { ...SHARE_LIMITS, ...deps.limits };
  }

  get startsInFlight(): number {
    return this.starting;
  }

  /** The loopback port the listener serves, or null while it is closed: no share is live and none is kept. */
  get port(): number | null {
    const address = this.listener?.address();
    return typeof address === 'object' && address ? address.port : null;
  }

  /**
   * For a long-running server: binds the listener now and keeps it bound after its last share ends, while the
   * exposure is a reverse proxy at a public address, so the proxy gets the not-found page instead of a refused
   * connection. Changes nothing under Tailscale exposure. A failure is logged; the next share reports it.
   */
  async keep(): Promise<void> {
    if (this.closed) return;
    this.persistent = true;
    try {
      await this.open(true);
    } catch (cause) {
      if (!this.closed) console.error(`stim-server: could not keep the web share listener: ${String(cause)}`);
    }
  }

  /**
   * Starts a share. With `restore`, a share whose device cannot be found yet starts waiting for it instead of being
   * refused, as a share saved before a stim-server restart does while its device comes back.
   */
  async start(request: ShareRequest, options: { restore?: boolean } = {}): Promise<StartedShare | Refusal> {
    this.starting++;
    try {
      return await this.begin(request, options.restore === true);
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

  private reusedLive(request: ShareRequest): boolean {
    return request.token !== undefined && this.shares.has(digest(request.token).toString('hex'));
  }

  private async begin(request: ShareRequest, restore: boolean): Promise<StartedShare | Refusal> {
    if (this.closed) return { code: 'action-failed', message: 'stim-server is stopping.' };
    if (request.control && request.physical && request.platform === 'ios') {
      return { code: 'bad-request', message: 'A physical iPhone is view only: share it without --control.' };
    }
    if (request.view) {
      if (!request.control || request.passwordless) {
        return {
          code: 'bad-request',
          message: 'A separate view password needs a share with control and a password.',
        };
      }
      if (request.view.password !== undefined && request.view.password === request.password) {
        return { code: 'bad-request', message: 'The view password and the control password must differ.' };
      }
    }
    if (request.slug !== undefined && request.passwordless) {
      return { code: 'bad-request', message: 'A share with a slug needs a password: anyone can guess a slug.' };
    }
    const taken = this.slugTaken(request.slug);
    if (taken) return taken;
    if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) {
      return { code: 'bad-request', message: 'That link has expired.' };
    }
    if (this.reusedLive(request)) return { code: 'bad-request', message: 'That link is live now.' };
    const held = this.deps.holdWorkspace ? await this.deps.holdWorkspace(request.workspace, () => this.closed) : null;
    if (held && 'code' in held) return held;
    try {
      return await this.register(request, restore);
    } finally {
      held?.release();
    }
  }

  private async register(request: ShareRequest, restore: boolean): Promise<StartedShare | Refusal> {
    const status = await this.status();
    if ('code' in status) return status;
    if (this.closed) return { code: 'action-failed', message: 'stim-server is stopping.' };
    const resolved = this.resolve(status, request, null);
    if (typeof resolved === 'string' && !restore) return { code: 'action-failed', message: resolved };
    const bound = typeof resolved === 'string' ? null : resolved;
    const source = bound ? bound.open(request) : null;
    let base: string;
    try {
      base = await this.open();
    } catch (cause) {
      return { code: 'action-failed', message: cause instanceof Error ? cause.message : String(cause) };
    }
    if (this.closed || this.base !== base) {
      source?.close();
      void this.teardown();
      return {
        code: 'action-failed',
        message: this.closed ? 'stim-server is stopping.' : 'The share listener closed while starting. Try again.',
      };
    }
    const late = this.slugTaken(request.slug);
    if (late) {
      source?.close();
      void this.teardown();
      return late;
    }
    const { password: chosen, view, token: given, expiresAt: until, ...kept } = request;
    if (this.reusedLive(request)) {
      source?.close();
      void this.teardown();
      return { code: 'bad-request', message: 'That link is live now.' };
    }
    const auth: ShareAuth = request.passwordless ? 'none' : chosen !== undefined ? 'set' : 'generated';
    const shown = auth === 'generated' ? password() : null;
    const viewAuth: ViewAuth = view ? (view.password !== undefined ? 'set' : 'generated') : null;
    const viewShown = viewAuth === 'generated' ? password() : null;
    const secret = request.slug ?? given ?? token();
    const id = `w${this.next++}`;
    const expiresAt = until ?? Date.now() + request.expiresMinutes * 60_000;
    const share: Share = {
      id,
      key: digest(secret).toString('hex'),
      request: kept,
      auth,
      passwordDigest: auth === 'none' ? null : digest(chosen ?? shown ?? ''),
      viewDigest: view ? digest(view.password ?? viewShown ?? '') : null,
      viewAuth,
      expiresAt,
      state: bound ? 'live' : 'waiting',
      bound: bound?.key ?? null,
      hosted: bound?.hosted ?? false,
      device: bound?.device ?? null,
      source,
      resumeAt: 0,
      backoff: RESUME_MIN_MS,
      retry: null,
      sessions: new Map(),
      failures: [],
      viewLogins: [],
      viewers: new Set(),
      owner: {
        device: { id: `share-${id}`, name: 'Web share' },
        send: (message: ServerMessage) => this.controlEvent(share, message),
      },
      controlSession: null,
      controlStarting: null,
      controlRetryAt: 0,
      controlUsed: false,
      recordKey: null,
      latest: status,
      facts: titleFacts(status, request),
      app: null,
      timer: setTimeout(() => void this.end(share, 'This share expired.'), expiresAt - Date.now()),
      unwatch: () => {},
      ended: false,
    };
    share.timer.unref?.();
    this.shares.set(share.key, share);
    this.preloadWebrtc(share);
    void this.readApp(share);
    share.unwatch = this.deps.subscribeStatus({
      item: (payload) => this.reconcile(share, payload),
      failed: () => {},
    });
    if (!bound) this.arm(share);
    return {
      ...this.row(share),
      url: `${base}/s/${secret}/`,
      ...(shown ? { password: shown } : {}),
      ...(viewShown ? { viewPassword: viewShown } : {}),
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }

  /** The refusal for a slug a live share already uses: a share never takes over another's link. */
  private slugTaken(slug: string | undefined): Refusal | null {
    if (slug === undefined) return null;
    const holder = this.shares.get(digest(slug).toString('hex'));
    if (!holder) return null;
    return {
      code: 'action-failed',
      message: `The slug ${slug} is in use by live share ${holder.id} of ${holder.request.workspace}. Stop that share or choose another slug.`,
    };
  }

  /**
   * What the slot's device is in `payload`: a ready hosted session, else the workspace's owned or leased local device;
   * otherwise why there is none. `attached` is the key of the local device a live share is fed by.
   */
  private resolve(payload: StatusPayload, request: ShareTarget, attached: string | null): Bound | string {
    const host = this.deps.hosted ? hostedOf(payload, request) : null;
    if (host && this.deps.hosted) {
      if (!host.ready) {
        return `The hosted session on ${host.machine} is not ready yet. Wait for stim ${request.platform} --remote to finish, then share again.`;
      }
      const hosted = this.deps.hosted;
      return {
        key: `host:${host.machine}/${host.session}`,
        hosted: true,
        device: null,
        open: (target) => hosted(host, target),
      };
    }
    const owned = ownedDevice(payload, request, attached, this.deps.lookup);
    if (typeof owned === 'string') return owned;
    return { key: deviceKey(owned), hosted: false, device: owned, open: (target) => this.localSource(owned, target) };
  }

  private titleOf(share: Share): string {
    return viewerTitle(share.request.platform, share.app, share.facts.model);
  }

  private broadcastTitle(share: Share): void {
    const message = JSON.stringify({ type: 'title', title: this.titleOf(share) });
    for (const viewer of share.viewers) {
      if (viewer.socket.readyState === viewer.socket.OPEN) viewer.socket.send(message);
    }
  }

  /** Reads the display name of the app the status names, once per app, for the titles of a local simulator share. */
  private async readApp(share: Share): Promise<void> {
    const { appId } = share.facts;
    const device = share.device;
    if (!appId || device?.platform !== 'ios' || device.physical) return;
    const name = await (this.deps.appName ?? simulatorAppName)(device.udid, appId).catch(() => null);
    if (share.ended || share.facts.appId !== appId || name === share.app) return;
    share.app = name;
    this.broadcastTitle(share);
  }

  private followTitle(share: Share, payload: StatusPayload): void {
    const next = titleFacts(payload, share.request);
    const appChanged = next.appId !== share.facts.appId;
    const changed = appChanged || next.model !== share.facts.model;
    share.facts = next;
    if (appChanged) {
      share.app = null;
      void this.readApp(share);
    }
    if (changed) this.broadcastTitle(share);
  }

  private localSource(device: Device, request: ShareTarget): ShareSource {
    const { frames, control, presence } = this.deps;
    const key = presenceKey(request.workspace, request.platform, request.slot ?? 'default', request.physical === true);
    return {
      subscribe: (listener, hint) => frames.subscribe(device, listener, hint),
      keyframe: () => frames.keyframe(device),
      congested: () => frames.congested(device),
      webrtc: async (offer, closed) =>
        openRtc(
          offer,
          {
            subscribe: (video, failed) =>
              frames.subscribe(device, { frame: () => {}, video, delayed: () => {}, failed }, VIDEO_HINT),
            keyframe: () => frames.keyframe(device),
            congested: () => frames.congested(device),
          },
          closed,
        ),
      begin: (owner, target, workspace, allowed) => control.begin(owner, target, workspace, allowed),
      targetOf: (owner, session) => control.targetOf(owner, session),
      input: (owner, session, _method, _params, command, participant) =>
        control.input(owner, session, command, participant),
      release: (owner, session, participant) => control.release(owner, session, participant),
      ...(presence
        ? {
            presence: {
              subscribe: (listener) => presence.subscribe(key, listener),
              join: (who) => presence.join(key, who),
              leave: (id) => presence.leave(key, id),
            },
          }
        : {}),
      endFor: (owner, message) => control.endFor(owner, null, message),
      end: (owner, session, message) => void control.endById(owner, session, message),
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

  /** Ends the shares of `workspace`, or of its `slot` alone, or every share for a null workspace. */
  async stop(workspace: string | null, message = 'The share was stopped.', slot?: string): Promise<ShareRow[]> {
    const stopping = [...this.shares.values()].filter(
      (share) =>
        (workspace === null || share.request.workspace === workspace) &&
        (slot === undefined || (share.request.slot ?? 'default') === slot),
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
    await cleanupRtc();
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
      state: share.state,
      auth: share.auth,
      viewAuth: share.viewAuth,
      ...(share.request.slug !== undefined ? { slug: share.request.slug } : {}),
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

  private open(standby: true): Promise<string | null>;
  private open(standby?: false): Promise<string>;
  private async open(standby = false): Promise<string | null> {
    for (;;) {
      if (this.base && this.listener && (standby || !this.kept || this.shares.size)) return this.base;
      this.opening ??= this.closingRoute
        .then(() => this.bind(standby))
        .finally(() => {
          this.opening = null;
        });
      const base = await this.opening;
      if (base !== null || standby) return base;
    }
  }

  /**
   * Opens the listener the exposure settings choose, or reuses a kept one that sits on the same port. `standby`
   * opens only a listener to keep and returns null when the settings choose anything else.
   */
  private async bind(standby: boolean): Promise<string | null> {
    const bindPort = (await this.deps.route.prepare?.()) ?? 0;
    const keep = this.persistent && (this.deps.route.standing?.() ?? false);
    if (standby && !keep) return null;
    if (this.listener && this.kept) {
      if (bindPort !== 0 && bindPort === this.port) {
        const opened = await this.deps.route.open(bindPort);
        this.kept = keep;
        this.base = opened.url;
        this.exposed = opened.proxied ? new URL(opened.url) : null;
        this.warning = opened.warning ?? null;
        return opened.url;
      }
      const old = this.listener;
      this.listener = null;
      this.base = null;
      this.exposed = null;
      this.warning = null;
      this.kept = false;
      closeServer(old);
    }
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
      this.kept = keep;
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
  }

  private async end(share: Share, message: string): Promise<void> {
    if (share.ended) return;
    share.ended = true;
    clearTimeout(share.timer);
    if (share.retry) clearTimeout(share.retry);
    share.unwatch();
    this.shares.delete(share.key);
    console.error(`stim-server: web share ${share.id} ended: ${message}`);
    for (const viewer of share.viewers) {
      viewer.detach?.();
      share.source?.presence?.leave(viewer.who.id);
      const { socket } = viewer;
      if (socket.readyState !== socket.OPEN) {
        socket.terminate();
        continue;
      }
      if (this.closed) socket.close(1001, 'stim-server stopped');
      else {
        socket.send(JSON.stringify({ type: 'ended', message: VIEWER_TEXT.ended }));
        socket.close(1000, 'share ended');
      }
      setTimeout(() => socket.terminate(), CLOSE_GRACE_MS).unref?.();
    }
    share.viewers.clear();
    share.source?.endFor(share.owner, message);
    share.source?.close();
    this.releaseRecording(share);
    await this.teardown();
  }

  /**
   * Re-resolves the share's device from the latest status: a live share whose device went away waits, one whose slot
   * now runs another device moves to it, and a waiting share whose device is back resumes.
   */
  private reconcile(share: Share, payload: StatusPayload): void {
    share.latest = payload;
    if (share.ended) return;
    this.followTitle(share, payload);
    const bound = this.resolve(payload, share.request, share.state === 'live' ? share.bound : null);
    if (typeof bound === 'string') return this.suspend(share, bound);
    if (share.state === 'waiting') {
      if (Date.now() >= share.resumeAt) this.resume(share, bound);
      return;
    }
    if (bound.key === share.bound) return;
    this.suspend(share, 'The device changed.');
    this.resume(share, bound);
  }

  /**
   * The share's device is away: releases control, closes the old source and stops feeding the viewers, which stay
   * connected and signed in. The link, passwords, sessions and expiry are kept.
   */
  private suspend(share: Share, reason: string): void {
    if (share.ended || share.state === 'waiting') return;
    const { source } = share;
    share.state = 'waiting';
    console.error(`stim-server: web share ${share.id} is waiting for its device: ${reason}`);
    for (const viewer of share.viewers) {
      viewer.detach?.();
      source?.presence?.leave(viewer.who.id);
      if (viewer.socket.readyState === viewer.socket.OPEN) {
        viewer.socket.send(JSON.stringify({ type: 'waiting', message: VIEWER_TEXT.waiting }));
      }
    }
    share.source = null;
    share.bound = null;
    share.device = null;
    share.controlSession = null;
    share.controlStarting = null;
    share.controlRetryAt = 0;
    source?.endFor(share.owner, reason);
    source?.close();
    this.releaseRecording(share);
    this.arm(share);
  }

  private resume(share: Share, bound: Bound): void {
    if (share.ended) return;
    if (share.retry) clearTimeout(share.retry);
    share.retry = null;
    share.state = 'live';
    share.source = bound.open(share.request);
    share.bound = bound.key;
    share.hosted = bound.hosted;
    share.device = bound.device;
    this.preloadWebrtc(share);
    void this.readApp(share);
    console.error(`stim-server: web share ${share.id} resumed on ${bound.key}`);
    for (const viewer of share.viewers) {
      if (viewer.socket.readyState === viewer.socket.OPEN) viewer.socket.send('{"type":"resumed"}');
      this.attach(share, viewer);
      this.present(share, viewer);
      this.warmControl(share, viewer);
    }
  }

  /**
   * Looks for the device again while the share waits, because a stream that failed leaves status as it was and no new
   * status item comes to resume it.
   */
  private arm(share: Share): void {
    if (share.retry) clearTimeout(share.retry);
    const delay = Math.max(share.resumeAt - Date.now(), RESUME_MIN_MS);
    share.retry = setTimeout(() => {
      share.retry = null;
      if (share.ended || share.state !== 'waiting') return;
      if (share.latest) this.reconcile(share, share.latest);
      if (share.state === 'waiting') this.arm(share);
    }, delay);
    share.retry.unref?.();
  }

  /**
   * Once no share is live, removes the Funnel route and only then closes the listener, so the public route never
   * points at a free loopback port. A listener whose route could not be removed stays bound, answering 404, until a
   * later route replaces it or the server stops; so does a kept one.
   */
  private teardown(): Promise<void> {
    if (this.shares.size || !this.listener) return this.closingRoute;
    if (this.kept && !this.closed) return this.closingRoute;
    const listener = this.listener;
    this.listener = null;
    this.kept = false;
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
    if (share.request.physical || share.hosted || share.recordKey) return;
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
    if (secret === undefined || rest === undefined || !(SHARE_TOKEN.test(secret) || SLUG.test(secret))) return null;
    const share = this.shares.get(digest(secret).toString('hex'));
    return share && !share.ended ? { share, rest } : null;
  }

  /** The browser's login, or `{ login: null }` on a share that needs none; null when it must sign in. */
  private admit(share: Share, request: IncomingMessage): { login: Login | null } | null {
    if (share.passwordDigest === null) return { login: null };
    const session = cookieOf(request);
    const login =
      session !== null && SHARE_TOKEN.test(session) ? share.sessions.get(digest(session).toString('hex')) : null;
    return login ? { login } : null;
  }

  private accessOf(share: Share, login: Login | null): ShareAccess {
    return share.request.control ? (login?.access ?? 'control') : 'view';
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
      const [path = '', query = ''] = (request.url ?? '').split('?');
      const transport = new URLSearchParams(query).get('transport');
      const remember = this.rtcOffered(share) && (transport === 'webrtc' || transport === 'ws') ? transport : null;
      const extra = remember
        ? { 'set-cookie': `stim_transport=${remember}; Secure; SameSite=Strict; Path=${path}; Max-Age=86400` }
        : {};
      const admitted = this.admit(share, request);
      if (admitted) {
        const { platform, control, physical } = share.request;
        const access = this.accessOf(share, admitted.login);
        const rotate = !physical && !(share.hosted && platform === 'android');
        return this.respond(
          response,
          200,
          viewerPage({
            title: this.titleOf(share),
            control: access === 'control',
            viewOnly: control && access === 'view',
            upgrade: control && access === 'view' && share.viewDigest !== null,
            askName: share.passwordDigest === null,
            platform,
            buttons: BUTTONS[platform],
            rotate,
            webrtc: this.rtcOffered(share),
            stun: process.env.STIM_WEBRTC_STUN ?? '',
          }),
          extra,
        );
      }
      return this.respond(response, 200, loginPage(null, share.app), extra);
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
    const path = (request.url ?? '').replace(/login(?:\?.*)?$/, '');
    const existing = this.admit(share, request)?.login ?? null;
    const back = (query: string) => {
      response.writeHead(303, {
        location: path + query,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      response.end();
    };
    share.failures = share.failures.filter((at) => now - at < this.limits.failureWindowMs);
    if (share.failures.length >= this.limits.maxFailures) {
      return existing
        ? back('?upgrade=limited')
        : this.respond(response, 429, loginPage('Too many wrong access codes. Try again later.', share.app));
    }
    const form = new URLSearchParams(body);
    const matched = accessFor(form.get('access') ?? form.get('password') ?? '', share.passwordDigest, share.viewDigest);
    if (!matched) {
      share.failures.push(now);
      return existing
        ? back('?upgrade=wrong')
        : this.respond(response, 401, loginPage('Wrong access code.', share.app));
    }
    const access: ShareAccess = share.request.control ? matched : 'view';
    if (existing) {
      if (access === 'control') existing.access = 'control';
      return back('');
    }
    if (access === 'view') {
      share.viewLogins = share.viewLogins.filter((at) => now - at < this.limits.failureWindowMs);
      if (share.viewLogins.length >= this.limits.maxViewLogins) {
        return this.respond(response, 429, loginPage('Too many logins. Try again later.', share.app));
      }
    }
    if (!makeRoom(share.sessions, access)) {
      return this.respond(response, 429, loginPage('Too many sessions are signed in. Try again later.', share.app));
    }
    if (access === 'view') share.viewLogins.push(now);
    const session = token();
    share.sessions.set(digest(session).toString('hex'), { access, name: cleanName(form.get('name')) });
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
    const admitted = this.admit(share, request);
    if (!admitted) return refuse(401, 'Unauthorized');
    const query = new URL(request.url ?? '', 'http://share.invalid').searchParams;
    const video = query.get('codec') === 'h264';
    const id = query.get('id');
    const pageId = id !== null && PAGE_ID.test(id) ? id : null;
    const replaced = pageId === null ? 0 : this.pageViewers(share, pageId, admitted.login).length;
    if (share.viewers.size - replaced >= this.limits.maxViewers) return refuse(503, 'Service Unavailable');
    this.wss.handleUpgrade(request, socket, head, (ws) => this.watch(share, ws, video, admitted.login, pageId));
  }

  private pageViewers(share: Share, pageId: string, login: Login | null): Viewer[] {
    return [...share.viewers].filter((viewer) => viewer.pageId === pageId && viewer.login === login);
  }

  private watch(share: Share, socket: WebSocket, video: boolean, login: Login | null, pageId: string | null): void {
    if (share.ended) {
      socket.close(1000, 'share ended');
      return;
    }
    const viewer: Viewer = {
      who: { id: `${share.id}-v${this.nextViewer++}`, kind: 'viewer', name: '', color: 0 },
      chosen: login?.name ?? null,
      renamedAt: -Infinity,
      login,
      pageId,
      socket,
      video,
      rtc: false,
      peer: null,
      offering: false,
      clockAt: 0,
      inputs: { tokens: this.limits.inputPerSecond, at: Date.now() },
      characters: { tokens: this.limits.textCharsPerSecond, at: Date.now() },
      detach: null,
      gate: null,
      refeed: null,
      stopPresence: null,
    };
    if (pageId !== null) {
      for (const stale of this.pageViewers(share, pageId, login)) {
        share.viewers.delete(stale);
        stale.socket.terminate();
      }
    }
    this.attach(share, viewer);
    const json = (message: Record<string, unknown>) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    json({ type: 'hello', expiresAt: new Date(share.expiresAt).toISOString(), title: this.titleOf(share) });
    if (share.state === 'waiting') json({ type: 'waiting', message: VIEWER_TEXT.waiting });
    this.identify(share, viewer);
    share.viewers.add(viewer);
    this.introduce(share, viewer);
    this.present(share, viewer);
    this.warmControl(share, viewer);
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
        viewer.gate?.reset();
        share.source?.keyframe();
        return;
      }
      void this.message(share, viewer, text);
    });
    socket.on('close', () => {
      clearInterval(ping);
      viewer.detach?.();
      share.viewers.delete(viewer);
      if (share.controlSession) share.source?.release?.(share.owner, share.controlSession, viewer.who);
      share.source?.presence?.leave(viewer.who.id);
      if (share.viewers.size === 0 && share.controlSession) {
        share.source?.endFor(share.owner, 'The last viewer left.');
        share.controlSession = null;
        this.releaseRecording(share);
      }
    });
    socket.on('error', () => socket.terminate());
  }

  /**
   * Feeds the viewer from the share's source: its frames or video, and a keyframe for video. A share that waits has no
   * source, so the viewer is fed by none until {@link resume} attaches it.
   */
  private attach(share: Share, viewer: Viewer): void {
    const { source } = share;
    if (!source || viewer.detach) return;
    const { socket } = viewer;
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
      if (socket.bufferedAmount <= DEFAULT_VIDEO_LIMITS.congestedBytes) return source.keyframe();
      source.congested();
      draining = setTimeout(drain, FRAME_RETRY_MS);
    };
    const subscribe = () =>
      source.subscribe(
        {
          frame: (frame) => {
            share.backoff = RESUME_MIN_MS;
            if (!viewer.rtc) delivery.push(frame);
          },
          ...(viewer.video && !viewer.rtc
            ? {
                video: (unit: AccessUnit) => {
                  if (socket.readyState !== socket.OPEN) return;
                  share.backoff = RESUME_MIN_MS;
                  const verdict = gate.admit(unit, socket.bufferedAmount);
                  if (verdict === 'send')
                    socket.send(videoPacket(VIDEO_SUBSCRIPTION, sequence++, unit), { binary: true });
                  else if (verdict === 'congested' && !draining) drain();
                },
              }
            : {}),
          delayed: (delayed) => json({ type: 'delayed', delayed }),
          artwork: (artwork) => json({ type: 'artwork', artwork: artwork && viewerArtwork(artwork) }),
          failed: (message) =>
            queueMicrotask(() => {
              if (share.source !== source) return;
              share.resumeAt = Date.now() + share.backoff;
              share.backoff = Math.min(share.backoff * 2, RESUME_MAX_MS);
              this.suspend(share, message);
            }),
        },
        viewer.rtc ? RTC_META_HINT : viewer.video ? VIDEO_HINT : VIEW_HINT,
      );
    let unsubscribe = subscribe();
    if (viewer.video) source.keyframe();
    viewer.gate = gate;
    viewer.refeed = () => {
      if (stopped) return;
      const previous = unsubscribe;
      gate.reset();
      unsubscribe = subscribe();
      previous();
      if (viewer.video && !viewer.rtc) source.keyframe();
    };
    viewer.detach = () => {
      if (stopped) return;
      stopped = true;
      viewer.peer?.close();
      viewer.peer = null;
      viewer.rtc = false;
      if (draining) clearTimeout(draining);
      delivery.stop();
      unsubscribe();
      viewer.stopPresence?.();
      viewer.stopPresence = null;
      viewer.detach = null;
      viewer.gate = null;
      viewer.refeed = null;
    };
  }

  /** Puts the viewer on the source's roster, and shows it who else touches the device. */
  private present(share: Share, viewer: Viewer): void {
    const { source } = share;
    const { socket } = viewer;
    if (!source?.presence || viewer.stopPresence) return;
    source.presence.join(viewer.who);
    viewer.stopPresence = source.presence.subscribe((participants) => {
      const others = participants.filter(
        (participant) =>
          participant.id !== viewer.who.id &&
          (participant.kind !== 'viewer' || participant.id.startsWith(`${share.id}-`)),
      );
      const sent =
        socket.bufferedAmount > PRESENCE_BACKLOG_BYTES
          ? others.filter((participant) => participant.touch?.phase !== 'move')
          : others;
      if (sent.length && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'presence', participants: sent }));
      }
    });
  }

  private warmControl(share: Share, viewer: Viewer): void {
    if (this.accessOf(share, viewer.login) === 'control') {
      void this.controlSession(share, viewer);
    }
  }

  /** Gives the viewer its name, color and place on the roster among the viewers now connected. */
  private identify(share: Share, viewer: Viewer): void {
    const others = [...share.viewers].filter((other) => other !== viewer).map((other) => other.who);
    const viewOnly = share.request.control && this.accessOf(share, viewer.login) === 'view';
    viewer.who = {
      id: viewer.who.id,
      kind: 'viewer',
      name: viewer.chosen ?? guestName(others.map((other) => other.name)),
      color: viewer.who.color || viewerColor(others.map((other) => other.color)),
      ...(viewOnly ? { viewOnly: true as const } : {}),
    };
  }

  /** Tells the viewer who it is and puts it on the device's roster. */
  private introduce(share: Share, viewer: Viewer): void {
    const { id, name, color } = viewer.who;
    if (viewer.socket.readyState === viewer.socket.OPEN) {
      viewer.socket.send(JSON.stringify({ type: 'you', id, name, color, access: this.accessOf(share, viewer.login) }));
    }
    if (viewer.stopPresence) share.source?.presence?.join(viewer.who);
  }

  private async message(share: Share, viewer: Viewer, raw: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isJsonObject(message)) return;
    if (message.type === 'name') return this.rename(share, viewer, message.name);
    if (message.type === 'clock') {
      const now = Date.now();
      if (now - viewer.clockAt < CLOCK_MIN_MS) return;
      viewer.clockAt = now;
      if (viewer.socket.readyState === viewer.socket.OPEN) {
        viewer.socket.send(JSON.stringify({ type: 'clock', c: message.c, s: Date.now() }));
      }
      return;
    }
    if (message.type === 'webrtc-offer') return this.offer(share, viewer, message.sdp, message.attempt);
    if (message.type === 'transport') return this.transport(viewer, message.via, message.attempt);
    if (!share.request.control) return;
    await this.input(share, viewer, message);
  }

  private preloadWebrtc(share: Share): void {
    this.rtcOffered(share);
  }

  private rtcOffered(share: Share): boolean {
    return this.deps.webrtc?.(share.hosted) === true;
  }

  /**
   * Answers the viewer's WebRTC offer with a peer on the machine that owns the device. The viewer keeps its video on
   * this socket until it reports with `transport` that the peer delivered a keyframe; `attempt` is echoed so the page
   * can tell the reply from one to an earlier offer.
   */
  private async offer(share: Share, viewer: Viewer, sdp: unknown, attempt: unknown): Promise<void> {
    const tag = Number.isSafeInteger(attempt) ? { attempt } : {};
    const failed = (message: string) => {
      if (viewer.socket.readyState === viewer.socket.OPEN) {
        viewer.socket.send(JSON.stringify({ type: 'webrtc-failed', message, ...tag }));
      }
    };
    const { source } = share;
    if (!viewer.video || !this.rtcOffered(share) || typeof sdp !== 'string' || sdp.length > 65536) {
      return failed('WebRTC was not requested.');
    }
    if (!source?.webrtc || !viewer.detach) return failed('This share cannot send WebRTC.');
    if (viewer.offering) return failed('A WebRTC offer is already being answered.');
    if (!take(viewer.inputs, ROTATE_COST, this.limits.inputPerSecond, this.limits.inputPerSecond)) {
      return failed('Too many WebRTC offers.');
    }
    viewer.offering = true;
    this.dropPeer(viewer);
    let ended = false;
    try {
      const handle: { close: () => void } = {
        close: () => {
          ended = true;
          peer?.close();
        },
      };
      let peer: { answer: string; close: () => void } | undefined;
      peer = await source.webrtc(sdp, (reason) => {
        if (ended) return;
        ended = true;
        if (viewer.peer === handle) this.dropPeer(viewer);
        failed(reason);
      });
      if (ended || share.ended || share.source !== source || !share.viewers.has(viewer) || !viewer.detach) {
        return handle.close();
      }
      viewer.peer = handle;
      viewer.socket.send(JSON.stringify({ type: 'webrtc-answer', sdp: peer.answer, ...tag }));
    } catch (cause) {
      console.error(`stim-server: web share ${share.id} WebRTC refused: ${String(cause)}`);
      if (!ended) failed(cause instanceof Error ? cause.message : String(cause));
    } finally {
      viewer.offering = false;
    }
  }

  private dropPeer(viewer: Viewer): void {
    viewer.peer?.close();
    viewer.peer = null;
    this.carry(viewer, false);
  }

  private carry(viewer: Viewer, rtc: boolean): void {
    if (viewer.rtc === rtc) return;
    viewer.rtc = rtc;
    viewer.refeed?.();
  }

  private transport(viewer: Viewer, via: unknown, attempt: unknown): void {
    if (via === 'ws') return this.carry(viewer, false);
    if (via !== 'webrtc') return;
    const limited = !take(viewer.inputs, ROTATE_COST, this.limits.inputPerSecond, this.limits.inputPerSecond);
    if (viewer.peer && viewer.video && !limited) return this.carry(viewer, true);
    if (viewer.socket.readyState === viewer.socket.OPEN) {
      const tag = Number.isSafeInteger(attempt) ? { attempt } : {};
      const message = limited ? 'Too many transport changes.' : 'The WebRTC peer is gone.';
      viewer.socket.send(JSON.stringify({ type: 'webrtc-failed', message, ...tag }));
    }
  }

  private rename(share: Share, viewer: Viewer, raw: unknown): void {
    const now = Date.now();
    if (now - viewer.renamedAt < RENAME_MS) return;
    viewer.renamedAt = now;
    viewer.chosen = cleanName(raw);
    if (viewer.login) viewer.login.name = viewer.chosen;
    viewer.who = { ...viewer.who, name: '' };
    this.identify(share, viewer);
    this.introduce(share, viewer);
  }

  private async input(share: Share, viewer: Viewer, message: Record<string, unknown>): Promise<void> {
    if (this.accessOf(share, viewer.login) !== 'control') return;
    const { type, ...fields } = message;
    const method = INPUT_METHODS.get(String(type));
    if (!method) return;
    const clipboard = method === 'input.clipboard.set' || method === 'input.clipboard.get';
    const cost = method === 'input.rotate' ? ROTATE_COST : clipboard ? CLIPBOARD_INPUT_COST : 1;
    const boundary = method === 'input.touch' && (fields.phase === 'down' || fields.phase === 'up');
    const debt = boundary ? this.limits.inputPerSecond : 0;
    if (!take(viewer.inputs, cost, this.limits.inputPerSecond, this.limits.inputPerSecond, debt)) return;
    const params =
      method === 'input.touch'
        ? {
            phase: fields.phase,
            x: fields.x,
            y: fields.y,
            ...(fields.x2 === undefined && fields.y2 === undefined ? {} : { x2: fields.x2, y2: fields.y2 }),
          }
        : method === 'input.text'
          ? { text: fields.text }
          : method === 'input.key'
            ? { key: fields.key, ...(fields.modifiers === undefined ? {} : { modifiers: fields.modifiers }) }
            : method === 'input.rotate'
              ? { direction: fields.direction }
              : method === 'input.clipboard.set'
                ? { text: fields.text, ...(fields.paste === undefined ? {} : { paste: fields.paste }) }
                : method === 'input.clipboard.get'
                  ? {}
                  : { button: fields.button };
    if (method === 'input.button' && !BUTTONS[share.request.platform].includes(String(fields.button))) return;
    const failRead = () => {
      if (method === 'input.clipboard.get' && viewer.socket.readyState === viewer.socket.OPEN) {
        viewer.socket.send(JSON.stringify({ type: 'clipboard', id: fields.id, error: VIEWER_TEXT.clipboardRefused }));
      }
    };
    const { source } = share;
    const polling = method === 'input.clipboard.get' && fields.poll === true;
    const session = polling ? share.controlSession : await this.controlSession(share, viewer);
    if (!source || !session || share.ended || share.source !== source || !share.viewers.has(viewer)) return failRead();
    const parsed = parseInput(method, { ...params, session }, (name) => source.targetOf(share.owner, name));
    if ('code' in parsed) return failRead();
    const command: InputCommand = parsed.value.command;
    if (
      command.input === 'text' &&
      !take(viewer.characters, command.text.length, this.limits.textCharsPerSecond, 256)
    ) {
      return;
    }
    if (!polling) share.controlUsed = true;
    const refused = await source.input(share.owner, session, method, { ...params }, command, viewer.who);
    const open = viewer.socket.readyState === viewer.socket.OPEN;
    if (refused && 'code' in refused) {
      if ('busy' in refused && typeof refused.busy === 'string') {
        if (open) viewer.socket.send(JSON.stringify({ type: 'busy', name: refused.busy }));
        return;
      }
      console.error(`stim-server: web share ${share.id} input refused: ${String(refused.message)}`);
      if (!open) return;
      if (method === 'input.clipboard.get') {
        viewer.socket.send(JSON.stringify({ type: 'clipboard', id: fields.id, error: VIEWER_TEXT.clipboardRefused }));
      } else {
        const notice = !clipboard
          ? VIEWER_TEXT.inputRefused
          : refused.code === 'device-busy'
            ? VIEWER_TEXT.pasteBusy
            : VIEWER_TEXT.clipboardRefused;
        viewer.socket.send(JSON.stringify({ type: 'control', message: notice }));
      }
    } else if (
      open &&
      method === 'input.clipboard.set' &&
      fields.paste === true &&
      share.request.platform === 'ios' &&
      !(isJsonObject(refused) && refused.typed === true)
    ) {
      viewer.socket.send(JSON.stringify({ type: 'control', message: VIEWER_TEXT.pasteSuggestion }));
    } else if (method === 'input.clipboard.get' && open) {
      const text = isJsonObject(refused) ? refused.text : undefined;
      viewer.socket.send(
        JSON.stringify({ type: 'clipboard', id: fields.id, text: typeof text === 'string' ? text : '' }),
      );
    }
  }

  private controlSession(share: Share, viewer: Viewer): Promise<string | null> {
    const { source } = share;
    if (!source) return Promise.resolve(null);
    if (share.controlSession) return Promise.resolve(share.controlSession);
    if (share.controlStarting) return share.controlStarting;
    if (Date.now() < share.controlRetryAt) return Promise.resolve(null);
    const { workspace, platform, slot, physical } = share.request;
    this.holdRecording(share);
    const attempt: Promise<string | null> = source
      .begin(
        share.owner,
        { workspace, platform, ...(slot ? { slot } : {}), ...(physical ? { physical } : {}) },
        workspace,
        () => !share.ended && share.source === source && share.viewers.size > 0,
      )
      .then((outcome) => {
        if (share.ended || share.source !== source) {
          if (!('code' in outcome)) source.end(share.owner, outcome.session, 'The share ended.');
          return null;
        }
        if ('code' in outcome) {
          if (share.viewers.size > 0) share.controlRetryAt = Date.now() + 5000;
          this.releaseRecording(share, outcome.code !== 'device-busy');
          console.error(`stim-server: web share ${share.id} control refused: ${outcome.message}`);
          if (viewer.socket.readyState === viewer.socket.OPEN) {
            viewer.socket.send(JSON.stringify({ type: 'control', message: VIEWER_TEXT.controlRefused }));
          }
          return null;
        }
        if (share.ended || share.source !== source || share.viewers.size === 0) {
          source.end(share.owner, outcome.session, 'The share ended.');
          this.releaseRecording(share);
          return null;
        }
        share.controlSession = outcome.session;
        share.controlUsed = false;
        return outcome.session;
      })
      .finally(() => {
        if (share.controlStarting === attempt) share.controlStarting = null;
      });
    share.controlStarting = attempt;
    return attempt;
  }

  private controlEvent(share: Share, message: ServerMessage): void {
    if (!('event' in message) || message.event !== 'control-ended') return;
    if (message.session !== share.controlSession) return;
    share.controlSession = null;
    this.releaseRecording(share);
    console.error(`stim-server: web share ${share.id} control ended: ${message.message}`);
    if (message.reason === 'idle' && !share.controlUsed) return;
    for (const viewer of share.viewers) {
      if (viewer.socket.readyState === viewer.socket.OPEN) {
        viewer.socket.send(JSON.stringify({ type: 'control', message: VIEWER_TEXT.controlEnded }));
      }
    }
  }
}
