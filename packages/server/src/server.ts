import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP, type AddressInfo, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { configDir } from '@stim-cli/core';
import { isJsonObject, loadConfig, type StatusPayload } from '@stim-cli/core/state';
import { actionArgs, actionOutcome, appendAudit, parseAction, type AuditRecord } from './actions.ts';
import { ControlHub, parseControlBegin, parseInput, SLOT_NAME, type Controller } from './control.ts';
import { FeedPool, type JsonObject } from './feed.ts';
import { buildFrameHelper, type FrameHint } from './frame-helper.ts';
import {
  DEFAULT_FRAME_LIMITS,
  deviceKey,
  FramePool,
  ownedDevice,
  type Device,
  type Frame,
  type FrameLimits,
} from './frames.ts';
import { LogBatcher, logArgs, parseLogFilter, type LogLimits } from './logs.ts';
import { readMachineUsage, UsageSampler } from './machine.ts';
import {
  ACTIONS,
  MAX_INPUT_TEXT,
  FRAME_EDGE,
  FRAME_FPS,
  PROTOCOL_VERSION,
  type BuildPlanResult,
  type ErrorCode,
  type FrameTarget,
  type HelloResult,
  type Methods,
  type ProtocolError,
  type RequestId,
  type ServerMessage,
  type VideoCodec,
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
import { serveRoute, whois, type ServeRoute, type TailscaleState } from './tailscale.ts';
import { DEFAULT_VIDEO_LIMITS, videoPacket, VideoGate, type AccessUnit } from './video.ts';

export interface ServerOptions {
  name: string;
  hosts: string[];
  port: number;
  stimCli: string;
  stimVersion: string;
  serverVersion: string;
  env: NodeJS.ProcessEnv;
  tailscale: string | null;
  tailscaleState: TailscaleState;
  authTimeoutMs?: number;
  maxAuthFailures?: number;
  failureWindowMs?: number;
  logLimits?: Partial<LogLimits>;
  commandLimits?: Partial<CommandLimits>;
  actionLimits?: Partial<CommandLimits>;
  frameLimits?: Partial<FrameLimits>;
  /**
   * The `stim-frames` helper to stream frames with, or null for screenshots only. Without it, the server builds
   * one at startup, and devices subscribed before the build finishes get screenshots.
   */
  frameHelper?: string | null;
  controlLimits?: Partial<ControlLimits>;
}

interface ControlLimits {
  idleMs: number;
  renewMs: number;
  leaseFor: string;
  inputPerSecond: number;
  textCharsPerSecond: number;
}

interface ServerHealth {
  server: 'stim-server';
  name: string;
  version: string;
  stim: string;
  protocol: number;
  stimHome: string;
  tailscale: { state: TailscaleState['state']; dnsName?: string | null; backendState?: string; reason?: string };
  route?: ServeRoute;
}

function healthTailscale(tailscale: TailscaleState): ServerHealth['tailscale'] {
  if (tailscale.state === 'running') return { state: 'running', dnsName: tailscale.dnsName };
  if (tailscale.state === 'not-running') return { state: 'not-running', backendState: tailscale.backendState };
  return { state: 'unavailable', reason: tailscale.reason };
}

/** Only a request made to this Mac's loopback name, so a DNS-rebound web page cannot read the health payload. */
function localHealthRequest(request: IncomingMessage): boolean {
  const host = request.headers.host?.replace(/:\d+$/, '');
  return (
    request.method === 'GET' &&
    request.url === '/health' &&
    (host === '127.0.0.1' || host === 'localhost') &&
    peerAddress(request) === null
  );
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
const FRAME_BUFFER_FRAMES = 2;
const FRAME_RETRY_MS = 50;
const HELPER_RETRY_MS = 5 * 60_000;
const CONTROL_LIMITS: ControlLimits = {
  idleMs: 5 * 60_000,
  renewMs: 60_000,
  leaseFor: '2m',
  inputPerSecond: 120,
  textCharsPerSecond: 40,
};
const LOCK_LIMITS: CommandLimits = { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 };
const STATUS_FEED = { args: ['status', '--watch', '--json'], cwd: homedir(), keep: 1, label: 'stim status --watch' };
const HEALTH_ROUTE_TIMEOUT_MS = 1000;
const COMMAND_LIMITS: CommandLimits = { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 };
const PLAN_TIMEOUT_MS = 150_000;
const AUDIT_FIELD_CHARS = 256;
const ACTION_LIMITS: CommandLimits = { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 };

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

function auditSafely(record: AuditRecord): void {
  try {
    appendAudit(record);
  } catch (cause) {
    console.error(`stim-server: could not append to the action log: ${(cause as Error).message}`);
  }
}

function take(bucket: { tokens: number; at: number }, cost: number, perSecond: number, capacity: number): boolean {
  const now = Date.now();
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.at) / 1000) * perSecond);
  bucket.at = now;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function requestId(value: unknown): RequestId | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

type ResolvedWorkspace = { dir: string } | { code: ErrorCode; message: string };

function registeredWorkspace(workspace: unknown): ResolvedWorkspace {
  if (typeof workspace !== 'string') {
    return { code: 'bad-request', message: 'params.workspace must be an environment path from a status payload.' };
  }
  let projects: Record<string, unknown>;
  try {
    projects = loadConfig()?.projects ?? {};
  } catch (cause) {
    return { code: 'stim-failed', message: (cause as Error).message };
  }
  const dir = Object.keys(projects).find((path) => path === workspace);
  if (dir === undefined)
    return { code: 'unknown-workspace', message: `${workspace} is not a Stim workspace on this Mac.` };
  if (!existsSync(dir)) {
    return { code: 'unknown-workspace', message: `${dir} is registered but no longer exists on this Mac.` };
  }
  return { dir };
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const limiter = new FailureLimiter(options.maxAuthFailures ?? 5, options.failureWindowMs ?? 60_000);
  const authTimeoutMs = options.authTimeoutMs ?? 5000;
  const feeds = new FeedPool(options.stimCli, options.env);
  const frameLimits: FrameLimits = { ...DEFAULT_FRAME_LIMITS, ...options.frameLimits };
  let helperPath = options.frameHelper ?? null;
  let helperBuilding = false;
  let helperRetryAt = 0;
  const helperAbort = new AbortController();
  const buildHelper = () => {
    helperBuilding = true;
    void (async () => {
      try {
        helperPath = await buildFrameHelper(options.env, helperAbort.signal);
      } catch (cause) {
        helperRetryAt = Date.now() + HELPER_RETRY_MS;
        if (!helperAbort.signal.aborted) {
          console.error(`stim-server: frames come from screenshots: ${(cause as Error).message}`);
        }
      } finally {
        helperBuilding = false;
      }
    })();
  };
  const frameHelper = () => {
    if (options.frameHelper === undefined && !helperPath && !helperBuilding && Date.now() >= helperRetryAt) {
      buildHelper();
    }
    return helperPath;
  };
  if (options.frameHelper === undefined) buildHelper();
  const frames = new FramePool(options.env, frameLimits, frameHelper);
  const running = new Set<() => Promise<void>>();
  const logLimits: LogLimits = { ...LOG_LIMITS, ...options.logLimits };
  const commandLimits: CommandLimits = { ...COMMAND_LIMITS, ...options.commandLimits };
  const actionLimits: CommandLimits = { ...ACTION_LIMITS, ...options.actionLimits };
  const busyWorkspaces = new Set<string>();
  const planQueues = new Map<string, Promise<void>>();
  const sessions = new Map<WebSocket, PairedDevice>();
  const sampler = new UsageSampler();
  const controllers = new Map<WebSocket, Controller>();
  const controlLimits: ControlLimits = { ...CONTROL_LIMITS, ...options.controlLimits };
  const control = new ControlHub({
    env: options.env,
    stimCli: options.stimCli,
    feeds,
    frames,
    statusFeed: STATUS_FEED,
    audit: auditSafely,
    lockLimits: LOCK_LIMITS,
    idleMs: controlLimits.idleMs,
    renewMs: controlLimits.renewMs,
    leaseFor: controlLimits.leaseFor,
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  mkdirSync(serverDir(), { recursive: true, mode: 0o700 });
  let revocationCheck: NodeJS.Timeout | null = null;
  const watcher: FSWatcher = watch(serverDir(), () => {
    revocationCheck ??= setTimeout(() => {
      revocationCheck = null;
      const paired = new Map(readDevices().map((device) => [device.id, device]));
      for (const [socket, device] of sessions) {
        if (!paired.has(device.id)) socket.close(CLOSE_UNAUTHORIZED, 'device revoked');
      }
      for (const [socket, controller] of controllers) {
        if (!paired.get(controller.device.id)?.capabilities.includes('control')) {
          control.endFor(controller, 'forbidden', 'This device can no longer control devices.');
          controllers.delete(socket);
        }
      }
    }, 50);
  });

  function connection(socket: WebSocket, peer: string | null): void {
    const limitKey = peer ?? 'local';
    const subscriptions = new Map<string, () => void>();
    const keyframes = new Map<string, () => void>();
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
      sampler.start();
      const result: HelloResult = {
        protocol: PROTOCOL_VERSION,
        server: { name: options.name, version: options.serverVersion, stim: options.stimVersion, home: homedir() },
        capabilities: device.capabilities,
        actions: device.capabilities.includes('control') ? [...ACTIONS] : [],
        device: { id: device.id, name: device.name },
        ...(outcome.deviceToken ? { deviceToken: outcome.deviceToken } : {}),
      };
      send(socket, { id, result });
    }

    function error(id: RequestId, code: ErrorCode, message: string): void {
      send(socket, { id, error: { code, message } });
    }

    const inputs = { tokens: controlLimits.inputPerSecond, at: Date.now() };
    const characters = { tokens: MAX_INPUT_TEXT, at: Date.now() };

    function controller(session: PairedDevice): Controller {
      let found = controllers.get(socket);
      if (!found) {
        found = { device: session, send: (message) => send(socket, message) };
        controllers.set(socket, found);
      }
      return found;
    }

    async function beginControl(id: RequestId, params: unknown, session: PairedDevice): Promise<void> {
      const raw = isJsonObject(params) ? params : {};
      const clip = (value: unknown) => (typeof value === 'string' ? value.slice(0, AUDIT_FIELD_CHARS) : null);
      const refuseControl = (code: ErrorCode, message: string) => {
        auditSafely({
          at: new Date().toISOString(),
          device: { id: session.id, name: session.name },
          action: raw.takeOver === true ? 'control.take-over' : 'control.begin',
          workspace: clip(raw.workspace),
          ...(typeof raw.platform === 'string' ? { platform: clip(raw.platform)! } : {}),
          ok: false,
          error: { code, message: clip(message)! },
        });
        error(id, code, message);
      };
      const current = readDevices().find((entry) => entry.id === session.id);
      if (!current?.capabilities.includes('control')) {
        return refuseControl(
          'forbidden',
          `This device can only read. On the Mac, run \`stim-server devices grant ${session.id} --control\` to let it control devices.`,
        );
      }
      const parsed = parseControlBegin(params);
      if ('code' in parsed) return refuseControl(parsed.code, parsed.message);
      const resolved = registeredWorkspace(parsed.value.workspace);
      if ('code' in resolved) return refuseControl(resolved.code, resolved.message);
      const owner = controller(session);
      const outcome = await control.begin(
        owner,
        { ...parsed.value, workspace: resolved.dir },
        resolved.dir,
        () =>
          socket.readyState === socket.OPEN &&
          controllers.get(socket) === owner &&
          readDevices().some((entry) => entry.id === session.id && entry.capabilities.includes('control')),
      );
      if ('code' in outcome) return refuseControl(outcome.code, outcome.message);
      send(socket, { id, result: outcome });
    }

    async function input(
      id: RequestId,
      method: 'input.touch' | 'input.text' | 'input.button',
      params: unknown,
      session: PairedDevice,
    ): Promise<void> {
      const owner = controller(session);
      const parsed = parseInput(method, params, (name) => control.platformOf(owner, name));
      if ('code' in parsed) return error(id, parsed.code, parsed.message);
      if (!take(inputs, 1, controlLimits.inputPerSecond, controlLimits.inputPerSecond)) {
        return error(id, 'limit-exceeded', `A connection can send ${controlLimits.inputPerSecond} inputs a second.`);
      }
      const { command: sent } = parsed.value;
      if (
        sent.input === 'text' &&
        !take(characters, sent.text.length, controlLimits.textCharsPerSecond, MAX_INPUT_TEXT)
      ) {
        return error(
          id,
          'limit-exceeded',
          `A connection can type ${controlLimits.textCharsPerSecond} characters a second. Send the rest shortly.`,
        );
      }
      const refused = await control.input(owner, parsed.value.session, parsed.value.command);
      if (refused) return error(id, refused.code, refused.message);
      send(socket, { id, result: {} });
    }

    function workspaceDir(id: RequestId, workspace: unknown, required: boolean): string | null {
      if (workspace === undefined && !required) return homedir();
      const resolved = registeredWorkspace(workspace);
      if ('code' in resolved) {
        error(id, resolved.code, resolved.message);
        return null;
      }
      return resolved.dir;
    }

    function openSubscription(id: RequestId, result: { video?: VideoCodec } = {}): string | null {
      if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
        error(id, 'limit-exceeded', `A connection can hold ${MAX_SUBSCRIPTIONS} subscriptions.`);
        return null;
      }
      const subscription = `s${nextSubscription++}`;
      send(socket, { id, result: { subscription, ...result } });
      return subscription;
    }

    function subscribeStatus(id: RequestId): void {
      const subscription = openSubscription(id);
      if (!subscription) return;
      const unsubscribe = feeds.subscribe(STATUS_FEED, {
        item: (payload) =>
          send(socket, { event: 'status', subscription, payload: payload as unknown as StatusPayload }),
        failed: (message) => {
          subscriptions.delete(subscription);
          send(socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
        },
      });
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

    function subscribeFrames(id: RequestId, params: unknown): void {
      const target = isJsonObject(params) ? params : {};
      const { workspace, platform, slot, fps, maxEdge, video } = target;
      if (typeof workspace !== 'string' || (platform !== 'ios' && platform !== 'android')) {
        return error(
          id,
          'bad-request',
          'frames.subscribe needs params.workspace and params.platform (ios or android).',
        );
      }
      if (slot !== undefined && (typeof slot !== 'string' || slot === '')) {
        return error(id, 'bad-request', 'slot must be a slot name.');
      }
      if (video !== undefined && (!Array.isArray(video) || !video.every((codec) => typeof codec === 'string'))) {
        return error(id, 'bad-request', 'video must be a list of codec names.');
      }
      const wantsVideo = (video as string[] | undefined)?.includes('h264') === true;
      const offersVideo = wantsVideo && frameHelper() !== null;
      const maxFps = wantsVideo ? FRAME_FPS.video : FRAME_FPS.max;
      if (fps !== undefined && (!Number.isInteger(fps) || (fps as number) < 1 || (fps as number) > maxFps)) {
        return error(id, 'bad-request', `fps must be a whole number from 1 to ${maxFps}.`);
      }
      if (
        maxEdge !== undefined &&
        (!Number.isInteger(maxEdge) || (maxEdge as number) < FRAME_EDGE.min || (maxEdge as number) > FRAME_EDGE.max)
      ) {
        return error(
          id,
          'bad-request',
          `maxEdge must be a whole number of pixels from ${FRAME_EDGE.min} to ${FRAME_EDGE.max}.`,
        );
      }
      const hint: FrameHint = {
        fps: Math.min((fps as number | undefined) ?? FRAME_FPS.default, offersVideo ? FRAME_FPS.video : FRAME_FPS.max),
        maxEdge: (maxEdge as number | undefined) ?? FRAME_EDGE.default,
      };
      if (!workspaceDir(id, workspace, true)) return;
      const subscription = openSubscription(id, offersVideo ? { video: 'h264' } : {});
      if (!subscription) return;
      const frameTarget: FrameTarget = { workspace, platform, ...(slot ? { slot } : {}) };
      const gate = new VideoGate(DEFAULT_VIDEO_LIMITS.congestedBytes);
      let sequence = 0;
      let streamed: Device | null = null;
      let draining: NodeJS.Timeout | null = null;
      const drain = () => {
        draining = null;
        if (ended || !streamed) return;
        if (socket.bufferedAmount <= DEFAULT_VIDEO_LIMITS.congestedBytes) return frames.keyframe(streamed);
        frames.congested(streamed);
        draining = setTimeout(drain, FRAME_RETRY_MS);
      };
      let attached: string | null = null;
      let detach: (() => void) | null = null;
      let pending: Frame | null = null;
      let retry: NodeJS.Timeout | null = null;
      let ended = false;
      let sentAt = 0;
      const flush = () => {
        retry = null;
        if (!pending || ended) return;
        const wait = sentAt + 1000 / hint.fps - Date.now();
        if (wait > 0) {
          retry = setTimeout(flush, wait);
          return;
        }
        if (socket.bufferedAmount > FRAME_BUFFER_FRAMES * pending.data.length) {
          retry = setTimeout(flush, FRAME_RETRY_MS);
          return;
        }
        const frame = pending;
        pending = null;
        sentAt = Date.now();
        send(socket, {
          event: 'frame',
          subscription,
          platform,
          slot: slot ?? 'default',
          mime: 'image/jpeg',
          ...frame,
        });
      };
      const cleanup = () => {
        ended = true;
        keyframes.delete(subscription);
        if (retry) clearTimeout(retry);
        if (draining) clearTimeout(draining);
        detach?.();
        detach = null;
        unsubscribeStatus?.();
      };
      const end = (message: string) => {
        if (ended) return;
        cleanup();
        subscriptions.delete(subscription);
        send(socket, { event: 'error', subscription, error: { code: 'frames-failed', message } });
      };
      const listener = {
        frame: (frame: Frame) => {
          pending = frame;
          if (!retry) flush();
        },
        delayed: (delayed: boolean) => {
          if (!ended) send(socket, { event: 'frame-delayed', subscription, delayed });
        },
        failed: end,
        ...(offersVideo
          ? {
              video: (unit: AccessUnit) => {
                if (ended || socket.readyState !== socket.OPEN) return;
                const verdict = gate.admit(unit, socket.bufferedAmount);
                if (verdict === 'send') socket.send(videoPacket(subscription, sequence++, unit));
                else if (verdict === 'congested' && !draining) drain();
              },
            }
          : {}),
      };
      if (offersVideo) {
        keyframes.set(subscription, () => {
          gate.reset();
          if (streamed) frames.keyframe(streamed);
        });
      }
      let unsubscribeStatus: (() => void) | null = null;
      unsubscribeStatus = feeds.subscribe(STATUS_FEED, {
        item: (payload) => {
          if (ended) return;
          const resolved = ownedDevice(payload as unknown as StatusPayload, frameTarget, attached);
          if (typeof resolved === 'string') return queueMicrotask(() => end(resolved));
          if (deviceKey(resolved) === attached) return;
          detach?.();
          gate.reset();
          streamed = resolved;
          attached = deviceKey(resolved);
          detach = frames.subscribe(resolved, listener, hint);
        },
        failed: (message) => queueMicrotask(() => end(message)),
      });
      subscriptions.set(subscription, cleanup);
    }

    function command<M extends 'logs.query' | 'stats.get' | 'settings.get' | 'build.plan'>(
      id: RequestId,
      args: string[],
      cwd: string,
      result: (stdout: string) => Methods[M]['result'],
      limits: CommandLimits = commandLimits,
      turn: Promise<void> | null = null,
    ): Promise<void> | null {
      if (commands.size >= MAX_COMMANDS) {
        error(id, 'limit-exceeded', `A connection can run ${MAX_COMMANDS} requests at a time.`);
        return null;
      }
      let run: ReturnType<typeof runStim> | null = null;
      let dropped = false;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cancel = async () => {
        dropped = true;
        if (!run) return void (turn ?? Promise.resolve()).then(release);
        await run.cancel();
        release();
      };
      const start = async () => {
        if (dropped) return;
        run = runStim(options.stimCli, options.env, args, cwd, limits);
        const outcome = await run.outcome;
        commands.delete(cancel);
        running.delete(cancel);
        try {
          if (!outcome.ok) {
            const printed = actionOutcome(outcome);
            return error(id, 'stim-failed', printed.ok ? outcome.message : printed.error.message);
          }
          let value: Methods[M]['result'];
          try {
            value = result(outcome.stdout);
          } catch {
            return error(id, 'stim-failed', `stim ${args[0]} printed output that is not JSON.`);
          }
          send(socket, { id, result: value });
        } finally {
          release();
        }
      };
      commands.add(cancel);
      running.add(cancel);
      if (turn) void turn.then(start);
      else void start();
      return released;
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

    function runAction(id: RequestId, params: unknown, session: PairedDevice): void {
      const startedAt = Date.now();
      const raw = isJsonObject(params) ? params : {};
      const clip = (value: unknown) => (typeof value === 'string' ? value.slice(0, AUDIT_FIELD_CHARS) : null);
      const record: AuditRecord = {
        at: new Date(startedAt).toISOString(),
        device: { id: session.id, name: session.name },
        action: clip(raw.action),
        workspace: clip(raw.workspace),
        ...(typeof raw.platform === 'string' ? { platform: clip(raw.platform)! } : {}),
        ok: false,
      };
      const audit = (outcome: Pick<AuditRecord, 'ok' | 'error' | 'durationMs'>) => {
        const logged = outcome.error ? { ...outcome.error, message: clip(outcome.error.message)! } : undefined;
        try {
          appendAudit({ ...record, ...outcome, ...(logged ? { error: logged } : {}) });
        } catch (cause) {
          console.error(`stim-server: could not append to the action log: ${(cause as Error).message}`);
        }
      };
      const refuseAction = (code: ErrorCode, message: string) => {
        audit({ ok: false, error: { code, message } });
        error(id, code, message);
      };
      const current = readDevices().find((entry) => entry.id === session.id);
      if (!current?.capabilities.includes('control')) {
        return refuseAction(
          'forbidden',
          `This device can only read. On the Mac, run \`stim-server devices grant ${session.id} --control\` to let it run actions.`,
        );
      }
      const parsed = parseAction(params);
      if ('code' in parsed) return refuseAction(parsed.code, parsed.message);
      const { action } = parsed;
      const resolved = registeredWorkspace(action.workspace);
      if ('code' in resolved) return refuseAction(resolved.code, resolved.message);
      if (busyWorkspaces.has(resolved.dir)) {
        return refuseAction(
          'action-busy',
          `An action is already running in ${resolved.dir}. Try again when it finishes.`,
        );
      }
      let run: ReturnType<typeof runStim>;
      try {
        run = runStim(options.stimCli, options.env, actionArgs(action), resolved.dir, actionLimits);
      } catch (cause) {
        return refuseAction('action-failed', `stim ${action.action} could not start (${(cause as Error).message}).`);
      }
      busyWorkspaces.add(resolved.dir);
      let finished = false;
      const finish = (outcome: ReturnType<typeof actionOutcome>) => {
        if (finished) return;
        finished = true;
        running.delete(cancel);
        busyWorkspaces.delete(resolved.dir);
        audit({ ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }), durationMs: Date.now() - startedAt });
        if (outcome.ok)
          send(socket, { id, result: { action: action.action, workspace: resolved.dir, output: outcome.output } });
        else send(socket, { id, error: outcome.error });
      };
      const cancel = async () => {
        finish({
          ok: false,
          error: { code: 'action-failed', message: 'stim-server stopped before the action finished.' },
        });
        await run.cancel();
      };
      running.add(cancel);
      void run.outcome.then((outcome) => finish(actionOutcome(outcome)));
    }

    function planBuild(id: RequestId, params: unknown): void {
      if (!isJsonObject(params)) return error(id, 'bad-request', 'params must be an object.');
      const { platform, slot } = params;
      if (platform !== 'ios' && platform !== 'android') {
        return error(id, 'bad-request', 'params.platform must be ios or android.');
      }
      if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
        return error(id, 'bad-request', 'params.slot must be 1-64 letters, digits, underscores or hyphens.');
      }
      const cwd = workspaceDir(id, params.workspace, true);
      if (!cwd) return;
      const args = [platform, '--plan', '--json', ...(slot === undefined ? [] : [`--slot=${slot}`])];
      const finished = command<'build.plan'>(
        id,
        args,
        cwd,
        (stdout) => {
          const value: unknown = JSON.parse(stdout);
          if (!isJsonObject(value) || value.platform !== platform) throw new Error('not a plan');
          return value as unknown as BuildPlanResult;
        },
        { ...commandLimits, timeoutMs: options.commandLimits?.timeoutMs ?? PLAN_TIMEOUT_MS },
        planQueues.get(cwd) ?? null,
      );
      if (!finished) return;
      planQueues.set(cwd, finished);
      void finished.finally(() => {
        if (planQueues.get(cwd) === finished) planQueues.delete(cwd);
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
      if (message.method === 'frames.subscribe') return subscribeFrames(id, message.params);
      if (message.method === 'frames.keyframe') {
        const name = isJsonObject(message.params) ? message.params.subscription : undefined;
        const keyframe = typeof name === 'string' ? keyframes.get(name) : undefined;
        if (!keyframe) {
          return send(socket, {
            id,
            error: { code: 'unknown-subscription', message: `No video subscription ${String(name)}.` },
          });
        }
        keyframe();
        return send(socket, { id, result: {} });
      }
      if (message.method === 'build.plan') return planBuild(id, message.params);
      if (message.method === 'machine.get') return send(socket, { id, result: await readMachineUsage() });
      if (message.method === 'machine.history') {
        const params = message.params ?? {};
        const sinceMs = isJsonObject(params) ? params.sinceMs : undefined;
        if (!isJsonObject(params) || (sinceMs !== undefined && typeof sinceMs !== 'number')) {
          return error(id, 'bad-request', 'machine.history takes an optional numeric sinceMs.');
        }
        return send(socket, { id, result: sampler.history(sinceMs) });
      }
      if (message.method === 'stats.get' || message.method === 'settings.get') {
        return workspaceCommand(id, message.method, message.params);
      }
      if (message.method === 'action') return runAction(id, message.params, device);
      if (message.method === 'control.begin') {
        void beginControl(id, message.params, device);
        return;
      }
      if (message.method === 'control.end') {
        const name = isJsonObject(message.params) ? message.params.session : undefined;
        if (typeof name !== 'string' || !control.endById(controller(device), name)) {
          return error(id, 'unknown-session', `No control session ${String(name)} on this connection.`);
        }
        return send(socket, { id, result: {} });
      }
      if (message.method === 'input.touch' || message.method === 'input.text' || message.method === 'input.button') {
        const method = message.method;
        void input(id, method, message.params, device);
        return;
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
      if (sessions.size === 0) sampler.stop();
      const owner = controllers.get(socket);
      if (owner) control.endFor(owner, null, 'The client disconnected.');
      controllers.delete(socket);
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

  const health: ServerHealth = {
    server: 'stim-server',
    name: options.name,
    version: options.serverVersion,
    stim: options.stimVersion,
    protocol: PROTOCOL_VERSION,
    stimHome: configDir(),
    tailscale: healthTailscale(options.tailscaleState),
  };
  const answerHealth = async (response: ServerResponse) => {
    const tailscale = options.tailscaleState;
    const route =
      tailscale.state === 'running' && tailscale.dnsName
        ? await serveRoute(options.tailscale, options.env, addresses[0]!.port, tailscale.ips, HEALTH_ROUTE_TIMEOUT_MS)
        : undefined;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...health, route }));
  };
  const servers: Server[] = [];
  const addresses: RunningServer['addresses'] = [];
  const close = async () => {
    watcher.close();
    helperAbort.abort();
    sampler.stop();
    if (revocationCheck) clearTimeout(revocationCheck);
    for (const client of wss.clients) client.terminate();
    await control.close();
    await Promise.all([frames.close(), feeds.close(), ...[...running].map((cancel) => cancel())]);
    wss.close();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  };
  try {
    for (const host of options.hosts) {
      const server = createServer((request, response) => {
        if (localHealthRequest(request)) {
          void answerHealth(response);
          return;
        }
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
