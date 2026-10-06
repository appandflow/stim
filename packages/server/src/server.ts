import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP, type AddressInfo, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { configDir } from '@stim-cli/core';
import {
  isJsonObject,
  listSegments,
  loadConfig,
  readMacosRecord,
  parseNdjsonLine,
  RECORDING_PLATFORMS,
  stimBuildDigest,
  type RecordingPlatform,
  type NdjsonRecord,
  type StatusPayload,
} from '@stim-cli/core/state';
import { actionArgs, actionOutcome, appendAudit, loadAudit, parseAction, type AuditRecord } from './actions.ts';
import { AgentDeviceDriver } from './agent-device-driver.ts';
import { HostedAgentHost } from './agent-driver.ts';
import { DeviceHost, type DeviceHostLimits } from './device-host.ts';
import { HostedViews } from './hosted-view.ts';
import { HostConnections, HostedRelay, type HostedRelayOptions } from './hosted-relay.ts';
import { LatestFrames, FRAME_RETRY_MS } from './frame-delivery.ts';
import { BuildHost, type BuildLimits, type BuildSession } from './build.ts';
import { ControlHub, parseControlBegin, parseInput, SLOT_NAME, type Controller } from './control.ts';
import { Recorder, type RecordLimits } from './recorder.ts';
import { probeDirectories, STARTUP_PROBE_MS, STARTUP_RETRY_MS, type StartupState } from './startup.ts';
import { exclusiveClaimDir, sharedClaimDir } from '@stim-cli/core/ownership-claim';
import { Player, recordedSpans, recordingDir, segmentKeyframe, timelineMarkers } from './replay.ts';
import { FeedPool, type JsonObject } from './feed.ts';
import { buildFoldHelper, buildFrameHelper, type FrameHint } from './frame-helper.ts';
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
import { readDiskVolumes, readMachineUsage, readMemoryPressure, UsageSampler } from './machine.ts';
import {
  BuildMachinesCache,
  doctorWorkspace,
  loadMachineDetails,
  MachineDetailsCache,
  type DoctorTarget,
} from './machine-details.ts';
import { UsageRecorder } from './usage-history.ts';
import {
  ACTIONS,
  BUILD_METHODS,
  DEVICE_HOST_METHODS,
  FEATURES,
  MAX_INPUT_TEXT,
  FRAME_EDGE,
  FRAME_FPS,
  LEGACY_PUSH_EVENTS,
  NOTIFICATION_LEVELS,
  PLATFORMS,
  PROTOCOL_VERSION,
  PUSH_EVENTS,
  PUSH_TOKEN_PATTERN,
  REPLAY_RATES,
  SERVER_UPDATE_METHODS,
  type BuildPlanResult,
  type DeviceFrameArtwork,
  type MacosWindow,
  type FramesSeekParams,
  type ErrorCode,
  type FrameTarget,
  type HelloResult,
  type Platform,
  type Methods,
  type ProtocolError,
  type RequestId,
  type ServerMessage,
  type VideoCodec,
} from './protocol.ts';
import { worktreePullRequests } from 'stim/pull-requests';
import { DEFAULT_STUCK_MINUTES } from '@stim-cli/core/oversight';
import { NotificationLog, notificationLogFile, publicEntry } from './notification-log.ts';
import { EXPO_PUSH_API, PushNotifier, type PushLimits, type PushNotifierOptions } from './push.ts';
import {
  authenticateDevice,
  dropPushToken,
  parseLevels,
  parseQuietHours,
  pushEvents,
  readBuildClients,
  readDeviceHostClients,
  readDevices,
  requestBuildAccess,
  requestDeviceHostAccess,
  setDevicePush,
  serverDir,
  spendPairingToken,
  type AuthOutcome,
  type PairedDevice,
  type PeerIdentity,
  validStuckMinutes,
} from './registry.ts';
import { runStats } from './stats.ts';
import { readWorkspaceDiff } from './workspace-diff.ts';
import { ServerUpdates } from './server-update.ts';
import { MachineUpdates } from './machine-update.ts';
import { Pending, runStim, type CommandLimits } from './stim-command.ts';
import { readHostPermissions } from './stim-host.ts';
import {
  readRawTailscaleStatus,
  serveRoute,
  setupServeRoute,
  whois,
  type ServeRoute,
  type TailscaleState,
} from './tailscale.ts';
import type { TailscaleMonitor, TailscaleSnapshot } from './tailscale-monitor.ts';
import { DEFAULT_VIDEO_LIMITS, videoPacket, VideoGate, type AccessUnit } from './video.ts';
import { DeviceViewers } from './viewers.ts';

const INPUT_METHODS = [
  'input.touch',
  'input.text',
  'input.button',
  'input.rotate',
  'input.posture',
  'input.simulator',
  'input.scroll',
  'input.key',
  'input.window',
] as const;

export interface ServerOptions {
  host?: { executable: string; name: string };
  name: string;
  hosts: string[];
  port: number;
  stimCli: string;
  stimVersion: string;
  serverVersion: string;
  env: NodeJS.ProcessEnv;
  tailscale: string | null;
  tailscaleState: TailscaleState;
  /**
   * Keeps the Tailscale state current after start. Without it, `tailscale` and `tailscaleState` stay as
   * given. While Tailscale runs the server listens on its addresses, and it closes them when Tailscale stops.
   */
  tailscaleMonitor?: TailscaleMonitor;
  /** How long to wait before listening again on a Tailscale address that failed; tests shorten it. */
  listenRetryMs?: number;
  /**
   * How long the startup read of the Stim home directories may take, and how long to wait before reading them
   * again after it failed; tests shorten them.
   */
  startupProbeMs?: number;
  startupRetryMs?: number;
  authTimeoutMs?: number;
  maxAuthFailures?: number;
  failureWindowMs?: number;
  logLimits?: Partial<LogLimits>;
  commandLimits?: Partial<CommandLimits>;
  actionLimits?: Partial<CommandLimits>;
  frameLimits?: Partial<FrameLimits>;
  /**
   * False runs no recorder, and so no status child while no client asks for status; true by default. The limits
   * say how much footage it keeps.
   */
  record?: boolean;
  recordLimits?: Partial<RecordLimits>;
  /**
   * The `stim-frames` helper to stream frames with, or null for screenshots only. Without it, the server builds
   * one at startup, and devices subscribed before the build finishes get screenshots.
   */
  frameHelper?: string | null;
  /** The `sim-fold` helper that folds an iPhone Duo. Without it, the server builds one on the first fold. */
  foldHelper?: string;
  controlLimits?: Partial<ControlLimits>;
  /**
   * False runs the notification rules only while a phone is registered for pushes, so no status child runs for the
   * notification history alone; true by default.
   */
  history?: boolean;
  /** The Expo push API base URL; tests point it at a local server. */
  pushEndpoint?: string;
  pushLimits?: Partial<PushLimits>;
  /** How many offloaded builds run, and for how long; tests shorten them. */
  buildLimits?: Partial<BuildLimits>;
  deviceHostLimits?: Partial<DeviceHostLimits>;
  hostedRelay?: HostedRelayOptions;
  service?: {
    label: string | null;
    node: string;
    script: string;
    runsAsService?: (label: string, port: number) => Promise<boolean>;
  };
  /** Looks up the worktrees' pull requests; tests replace GitHub. */
  pullRequests?: PushNotifierOptions['pullRequests'];
}

interface ControlLimits {
  idleMs: number;
  renewMs: number;
  leaseFor: string;
  inputPerSecond: number;
  textCharsPerSecond: number;
  shapeChangesPerSecond: number;
  /** `sim-fold` waits up to 20 seconds for SpringBoard to finish the fold; Stim Desktop stops it after 40. */
  foldTimeoutMs: number;
}

interface ServerHealth {
  host?: HelloResult['host'];
  startup: StartupState;
  server: 'stim-server';
  name: string;
  version: string;
  stim: string;
  /** The digest of the `stim` build this server runs, which offload compares between Macs. */
  stimBuild: string | null;
  protocol: number;
  stimHome: string;
  /** The work a restart would cut off: offloaded builds and hosted sessions running now. */
  busy: { builds: number; hostedSessions: number };
  tailscale: { state: TailscaleState['state']; dnsName?: string | null; backendState?: string; reason?: string };
  route?: ServeRoute;
  nativeViewerOpened: boolean;
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
  /** Settles once the first read of the Stim home finished: `ready`, or `degraded` while a read does not return. */
  ready: Promise<StartupState>;
  close: () => Promise<void>;
}

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_BAD_REQUEST = 4400;
const CLOSE_AUTH_TIMEOUT = 4408;
const CLOSE_ABNORMAL = 1006;
const MAX_PAYLOAD = 64 * 1024;
const MAX_SUBSCRIPTIONS = 32;
const MAX_COMMANDS = 4;

function isWorkspaceChangeMethod(method: string): method is 'workspace.files' | 'workspace.diff' {
  return method === 'workspace.files' || method === 'workspace.diff';
}
const MAX_KEYFRAME_READS = 8;
const LOG_LIMITS: LogLimits = { maxBufferedBytes: 4 * 1024 * 1024, maxPendingRecords: 20_000 };
const HELPER_RETRY_MS = 5 * 60_000;
/**
 * Test switch: set to 1, a `physical` target may resolve to an emulator its workspace leases with `stim device
 * lock`, which then streams and takes input over adb as a phone does. It exists to exercise the physical-device
 * path without a phone.
 */
const ADB_EMULATORS_SWITCH = 'STIM_SERVER_TEST_ADB_EMULATORS';
const CONTROL_LIMITS: ControlLimits = {
  idleMs: 5 * 60_000,
  renewMs: 60_000,
  leaseFor: '2m',
  inputPerSecond: 120,
  textCharsPerSecond: 40,
  shapeChangesPerSecond: 2,
  foldTimeoutMs: 40_000,
};
const LOCK_LIMITS: CommandLimits = { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 };
const pushToken = new RegExp(PUSH_TOKEN_PATTERN);

const STATUS_FEED = { args: ['status', '--watch', '--json'], cwd: homedir(), keep: 1, label: 'stim status --watch' };
const HEALTH_ROUTE_TIMEOUT_MS = 1000;
const LISTEN_RETRY_MS = 5000;
const COMMAND_LIMITS: CommandLimits = { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 };
const PLAN_TIMEOUT_MS = 150_000;
const DETAILS_TIMEOUT_MS = 150_000;
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
  'approval-pending': {
    code: 'approval-pending',
    message: 'This Mac has not approved this request yet. On it, run `stim-server devices` to find the request.',
  },
  'build-needs-tailnet': {
    code: 'forbidden',
    message: 'Build access is granted only to another Mac on the tailnet, not to a connection from this Mac.',
  },
  'device-host-needs-tailnet': {
    code: 'forbidden',
    message: 'Device hosting is granted only to another Mac on the tailnet, not to a connection from this Mac.',
  },
  'device-host-requests-full': {
    code: 'limit-exceeded',
    message: 'This Mac has too many pending device-host requests. Try again after they are approved or lapse.',
  },
  'bad-device-name': {
    code: 'bad-request',
    message: 'A Mac requesting access needs a one-line name of at most 64 characters.',
  },
  'build-requests-full': {
    code: 'limit-exceeded',
    message: 'This Mac has too many pending build requests. Try again after they are approved or lapse.',
  },
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

function send(socket: WebSocket, message: ServerMessage | string): void {
  if (socket.readyState === socket.OPEN) socket.send(typeof message === 'string' ? message : JSON.stringify(message));
}

function buildAllowed(session: PairedDevice): boolean {
  return Boolean(
    readBuildClients()
      .find((entry) => entry.id === session.id)
      ?.capabilities.includes('build'),
  );
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

interface Replayable {
  seek: (at: number, rate: FramesSeekParams['rate']) => number | null;
  /** Returns why the subscription cannot go live, or null once it is live. */
  live: () => string | null;
}

/** `at` and `rate` of a seek, null when neither is given, or why they are refused. */
function parseReplay(at: unknown, rate: unknown): { at: number; rate: FramesSeekParams['rate'] } | string | null {
  if (at === undefined && rate === undefined) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return 'at must be epoch milliseconds.';
  const parsed = rate === undefined ? 0 : rate;
  if (!REPLAY_RATES.includes(parsed as FramesSeekParams['rate'])) {
    return `rate must be one of ${REPLAY_RATES.join(', ')}.`;
  }
  return { at, rate: parsed as FramesSeekParams['rate'] };
}

function hasFootage(dir: string): boolean {
  return listSegments(dir).length > 0;
}

function doctorTarget(): DoctorTarget {
  try {
    return doctorWorkspace(loadConfig(), existsSync);
  } catch (cause) {
    return { error: (cause as Error).message };
  }
}

const closeListener = ({ server, sockets }: { server: Server; sockets: Set<Socket> }) =>
  new Promise((resolve) => {
    server.close(resolve);
    for (const socket of sockets) socket.destroy();
  });

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  let hostProbe: Promise<HelloResult['host']> | undefined;
  let hostExpires = 0;
  const hostHealth = (): Promise<HelloResult['host']> => {
    if (!options.host) return Promise.resolve(undefined);
    if (!hostProbe || Date.now() >= hostExpires) {
      hostExpires = Infinity;
      hostProbe = readHostPermissions(options.host.executable).then((permissions) => {
        hostExpires = Date.now() + 5000;
        return permissions ? { name: options.host!.name, ...permissions } : null;
      });
    }
    return hostProbe;
  };
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
  let nativeViewerOpened = false;
  const helperEnv = options.host ? { ...options.env, STIM_CAPTURE_HOST: options.host.name } : options.env;
  const frames = new FramePool(helperEnv, frameLimits, frameHelper, new DeviceViewers());
  let recorder: Recorder | null = null;
  let startup: StartupState = { state: 'pending' };
  let startupProbe: ReturnType<typeof probeDirectories> | null = null;
  let startupRetry: NodeJS.Timeout | null = null;
  let foldBuild: Promise<string> | null = null;
  const foldHelper = () => {
    if (options.foldHelper !== undefined) return Promise.resolve(options.foldHelper);
    foldBuild ??= buildFoldHelper(options.env, helperAbort.signal).catch((cause: Error) => {
      foldBuild = null;
      throw new Error(`sim-fold could not be built: ${cause.message}`);
    });
    return foldBuild;
  };
  const running = new Set<() => Promise<void>>();
  const cancelling = new Pending();
  const logLimits: LogLimits = { ...LOG_LIMITS, ...options.logLimits };
  const commandLimits: CommandLimits = { ...COMMAND_LIMITS, ...options.commandLimits };
  const actionLimits: CommandLimits = { ...ACTION_LIMITS, ...options.actionLimits };
  const busyWorkspaces = new Set<string>();
  const planQueues = new Map<string, Promise<void>>();
  const runDetailsCommand = (args: string[], cwd: string = homedir()) => {
    const run = runStim(options.stimCli, options.env, args, cwd, {
      ...commandLimits,
      timeoutMs: options.commandLimits?.timeoutMs ?? DETAILS_TIMEOUT_MS,
    });
    running.add(run.cancel);
    return run.outcome.finally(() => running.delete(run.cancel));
  };
  const readDetailsStats = () => {
    const run = runStats(options.env, homedir(), {
      ...commandLimits,
      timeoutMs: options.commandLimits?.timeoutMs ?? DETAILS_TIMEOUT_MS,
    });
    running.add(run.cancel);
    return run.outcome.finally(() => running.delete(run.cancel));
  };
  const machineDetails = new MachineDetailsCache(() =>
    loadMachineDetails(runDetailsCommand, loadAudit, readDetailsStats),
  );
  const buildMachines = new BuildMachinesCache();
  let recordingTurn: Promise<void> = Promise.resolve();
  let closing = false;
  const sessions = new Map<WebSocket, PairedDevice>();
  const listeners = new Set<WebSocket>();
  const sampler = new UsageSampler();
  const usage = new UsageRecorder();
  let recorders = 0;
  let stopRecording: (() => void) | null = null;
  const recordUsage = (): (() => void) => {
    recorders += 1;
    stopRecording ??= feeds.subscribe(STATUS_FEED, {
      item: (payload) => usage.record(payload as unknown as StatusPayload),
      failed: () => {
        stopRecording = null;
      },
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      recorders -= 1;
      if (recorders > 0) return;
      stopRecording?.();
      stopRecording = null;
    };
  };
  const controllers = new Map<WebSocket, Controller>();
  const controlLimits: ControlLimits = { ...CONTROL_LIMITS, ...options.controlLimits };
  const adbEmulators = options.env[ADB_EMULATORS_SWITCH] === '1';
  const agentDrivers = new HostedAgentHost({
    resolve: () =>
      loadConfig()?.hosting?.agentDriver === 'agent-device'
        ? new AgentDeviceDriver({
            env: options.env,
            stateDir: join(serverDir(), 'agent-device'),
            claimRoot: join(serverDir(), 'agent-device.claims'),
          })
        : null,
    nodeOf: (client) => {
      const identity = readDeviceHostClients().find(
        (entry) => entry.id === client && entry.capabilities.includes('device-host'),
      )?.identity;
      return identity?.kind === 'tailnet' ? identity.nodeId : null;
    },
  });
  const hostedDevices = new DeviceHost({
    worker: join(dirname(options.stimCli), 'device-host-worker.mjs'),
    env: options.env,
    agents: agentDrivers,
    limits: options.deviceHostLimits,
    allowed: (client) =>
      readDeviceHostClients().some((entry) => entry.id === client && entry.capabilities.includes('device-host')),
    builtBundle: (client, handoff, sha256) => {
      const host = readDeviceHostClients().find(
        (entry) => entry.id === client && entry.capabilities.includes('device-host'),
      )?.identity;
      return builds.takeBundle(handoff, sha256, (builder) => {
        const build = readBuildClients().find(
          (entry) => entry.id === builder && entry.capabilities.includes('build'),
        )?.identity;
        return host?.kind === 'tailnet' && build?.kind === 'tailnet' && host.nodeId === build.nodeId;
      });
    },
  });
  const agentNodes = new Map<string, { node: string; until: number }>();
  const agentLimiter = new FailureLimiter(30, options.failureWindowMs ?? 60_000);
  async function answerAgent(request: IncomingMessage, response: ServerResponse, session: string): Promise<void> {
    const peer = peerAddress(request);
    const refuse = (status: number, text: string) =>
      void response.writeHead(status, { 'content-type': 'text/plain' }).end(`${text}\n`);
    if (!peer || !isIP(peer) || request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined)
      return refuse(403, 'Forbidden.');
    if (agentLimiter.blocked(peer)) return refuse(429, 'Too many attempts. Try again in a minute.');
    const bearer = /^bearer (.+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const header = request.headers['x-agent-device-token'];
    const token = bearer ?? (typeof header === 'string' ? header : null);
    let known = agentNodes.get(peer);
    if (!known || known.until < Date.now()) {
      const identity = await whois(tailscaleNow().binary, options.env, peer);
      if (identity?.kind !== 'tailnet') {
        agentLimiter.record(peer);
        return refuse(403, 'Forbidden.');
      }
      known = { node: identity.nodeId, until: Date.now() + 30_000 };
      agentNodes.set(peer, known);
      if (agentNodes.size > 256) agentNodes.delete(agentNodes.keys().next().value!);
    }
    if (agentDrivers.forward(session, token, known.node, request, response) === 'forbidden') agentLimiter.record(peer);
  }
  const builds = new BuildHost({
    worker: join(dirname(options.stimCli), 'offload-worker.mjs'),
    env: options.env,
    limits: options.buildLimits,
    ready: () => startup.state === 'ready',
    finished: ({ client, repo, ok, error, durationMs }) =>
      auditSafely({
        at: new Date().toISOString(),
        device: { id: client, name: readBuildClients().find((each) => each.id === client)?.name ?? client },
        action: 'build',
        workspace: repo,
        ok,
        ...(error ? { error } : {}),
        durationMs,
      }),
    allowed: (client) => readBuildClients().some((each) => each.id === client && each.capabilities.includes('build')),
  });
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
    foldHelper,
    frameHelper,
    foldTimeoutMs: controlLimits.foldTimeoutMs,
    conflict: (deviceId, conflict) => push.control(deviceId, conflict),
    adbEmulators,
  });
  const hostedViews = new HostedViews(hostedDevices, control, helperEnv, frameHelper);
  const ownStimBuild = stimBuildDigest(dirname(options.stimCli));
  const machineUpdates = new MachineUpdates({
    version: options.serverVersion,
    serverDir: dirname(dirname(options.service?.script || fileURLToPath(import.meta.url))),
    status: () => readRawTailscaleStatus(tailscaleNow().binary, options.env),
    endpoint: options.hostedRelay?.endpoint,
  });
  const updates = new ServerUpdates({
    label: options.service?.label ?? null,
    port: options.port,
    build: { version: options.serverVersion, stimBuild: ownStimBuild },
    node: options.service?.node ?? process.execPath,
    script: options.service?.script ?? '',
    env: process.env,
    runsAsService: options.service?.runsAsService,
    acceptsClientBuilds: () => loadConfig()?.server?.acceptClientBuilds === true,
    drain: (reason) => {
      builds.drain(reason);
      hostedDevices.drain(reason);
    },
    audit: ({ by, target, phase, ok, message }) =>
      auditSafely({
        at: new Date().toISOString(),
        device: by,
        action: `server.update.${phase}`,
        workspace: target,
        ok,
        ...(ok ? {} : { error: { code: 'action-failed', message: message.slice(0, AUDIT_FIELD_CHARS) } }),
      }),
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const notificationLog = new NotificationLog(notificationLogFile(serverDir()));
  const push = new PushNotifier({
    name: options.name,
    endpoint: options.pushEndpoint ?? EXPO_PUSH_API,
    subscribeStatus: (listener) => feeds.subscribe(STATUS_FEED, listener),
    readVolumes: readDiskVolumes,
    readPressure: readMemoryPressure,
    pullRequests: options.pullRequests ?? ((worktrees) => worktreePullRequests()(worktrees)),
    ownLeases: () => control.ownLeaseTimes(),
    devices: readDevices,
    dropToken: dropPushToken,
    log: notificationLog,
    whilePaired: options.history ?? true,
    logged: (entries) => {
      for (const socket of listeners) {
        const device = sessions.get(socket);
        for (const entry of entries) {
          if (!device || (entry.device !== undefined && entry.device !== device.id)) continue;
          send(socket, { event: 'notification', log: notificationLog.id, notification: publicEntry(entry) });
        }
      }
    },
    limits: options.pushLimits,
  });

  const relays = new Map<WebSocket, HostedRelay>();
  const hostConnections = new HostConnections(
    options.hostedRelay ?? { status: () => readRawTailscaleStatus(tailscaleNow().binary, options.env) },
    options.serverVersion,
  );
  let revocationCheck: NodeJS.Timeout | null = null;
  let checkedRegistry: string | null = null;
  const checkRevocations = () => {
    const devices = [...readDevices(), ...readBuildClients(), ...readDeviceHostClients()];
    const registry = JSON.stringify(devices);
    if (registry === checkedRegistry) return;
    checkedRegistry = registry;
    const paired = new Map(devices.map((device) => [device.id, device]));
    push.refresh();
    for (const [socket, device] of sessions) {
      if (!paired.has(device.id)) socket.close(CLOSE_UNAUTHORIZED, 'device revoked');
    }
    hostedDevices.revoke();
    builds.abandonDetached((client) => paired.get(client)?.capabilities.includes('build') ?? false);
    void builds.sweepDaemons();
    for (const [socket, controller] of controllers) {
      const capabilities = paired.get(controller.device.id)?.capabilities;
      if (!capabilities?.includes('control') && !capabilities?.includes('device-host')) {
        control.endFor(controller, 'forbidden', 'This device can no longer control devices.');
        relays.get(socket)?.endControls();
        controllers.delete(socket);
      }
    }
  };
  let watcher: FSWatcher | null = null;
  let revocationPoll: NodeJS.Timeout | null = null;
  let retireOnce: Promise<void> | undefined;
  const becomeReady = () => {
    mkdirSync(serverDir(), { recursive: true, mode: 0o700 });
    watcher ??= watch(serverDir(), () => {
      revocationCheck ??= setTimeout(() => {
        revocationCheck = null;
        checkRevocations();
      }, 50);
    });
    // Node's macOS watcher can miss changes before it is ready: https://github.com/nodejs/node/issues/52601.
    revocationPoll ??= setInterval(checkRevocations, 1000).unref();
    push.refresh();
    retireOnce ??= hostedDevices.reconcileStopped().catch((error: unknown) => {
      process.stderr.write(`Hosted device retirement failed: ${(error as Error).message}\n`);
    });
    if (options.frameHelper === undefined && !helperPath && !helperBuilding) buildHelper();
    if (options.record !== false) {
      recorder ??= new Recorder({
        frames,
        subscribeStatus: (listener) => feeds.subscribe(STATUS_FEED, listener),
        limits: options.recordLimits,
      });
    }
  };

  let settingUpRoute: Promise<ServeRoute> | null = null;

  function connection(socket: WebSocket, peer: string | null, localControl: boolean): void {
    const limitKey = peer ?? 'local';
    const subscriptions = new Map<string, () => void>();
    const keyframes = new Map<string, () => void>();
    const congestion = new Map<string, () => void>();
    const replays = new Map<string, Replayable>();
    let keyframeReads = 0;
    const commands = new Set<() => Promise<void>>();
    let nextSubscription = 1;
    let device: PairedDevice | null = null;
    let buildSession: BuildSession | null = null;
    let queue = Promise.resolve();
    const relay = new HostedRelay(
      hostConnections,
      (message) => {
        if (Buffer.isBuffer(message)) {
          if (socket.readyState === socket.OPEN) socket.send(message);
        } else send(socket, message);
      },
      () => socket.bufferedAmount,
      openSubscription,
      (subscription) => subscriptions.delete(subscription),
      auditSafely,
    );
    relays.set(socket, relay);

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
      return isIP(peer) ? whois(tailscaleNow().binary, options.env, peer) : null;
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
      const deviceName = typeof auth.deviceName === 'string' ? auth.deviceName.trim() : '';
      if (typeof auth.pairingToken === 'string' && deviceName) {
        outcome = spendPairingToken(auth.pairingToken, deviceName, identity);
      } else if ((auth.request === 'build' || auth.request === 'device-host') && deviceName) {
        if (limiter.blocked(limitKey)) {
          return refuse(
            id,
            'limit-exceeded',
            'Too many attempts from this peer. Try again in a minute.',
            CLOSE_UNAUTHORIZED,
          );
        }
        outcome =
          auth.request === 'build'
            ? requestBuildAccess(deviceName, identity)
            : requestDeviceHostAccess(deviceName, identity);
      } else if (typeof auth.deviceToken === 'string') {
        outcome = authenticateDevice(auth.deviceToken, identity);
      } else {
        return refuse(
          id,
          'bad-request',
          'auth needs pairingToken and deviceName, request and deviceName, or deviceToken.',
          CLOSE_BAD_REQUEST,
        );
      }
      if (!outcome.ok) {
        const { code, message } = AUTH_REFUSALS[outcome.reason];
        if (outcome.reason !== 'approval-pending') return refuse(id, code, message, CLOSE_UNAUTHORIZED);
        send(socket, { id, error: { code, message } });
        return void socket.close(CLOSE_UNAUTHORIZED, code);
      }
      if (outcome.device.pendingUntil !== undefined) {
        limiter.record(limitKey);
        const result: HelloResult = {
          protocol: PROTOCOL_VERSION,
          server: { name: options.name, version: options.serverVersion, stim: options.stimVersion, home: homedir() },
          capabilities: [],
          features: [...FEATURES],
          actions: [],
          device: { id: outcome.device.id, name: outcome.device.name },
          deviceToken: outcome.deviceToken!,
          approval: { state: 'pending', expiresAt: outcome.device.pendingUntil },
        };
        send(socket, { id, result });
        return void socket.close(CLOSE_UNAUTHORIZED, 'approval-pending');
      }
      device = outcome.device;
      sessions.set(socket, device);
      sampler.start();
      const result: HelloResult = {
        protocol: PROTOCOL_VERSION,
        server: { name: options.name, version: options.serverVersion, stim: options.stimVersion, home: homedir() },
        ...(options.host ? { host: await hostHealth() } : {}),
        capabilities: device.capabilities,
        features: [...FEATURES],
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
    const shapeChanges = { tokens: controlLimits.shapeChangesPerSecond, at: Date.now() };

    function controller(session: Pick<PairedDevice, 'id' | 'name'>): Controller {
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
      const host = parsed.value.platform === 'macos' ? readMacosRecord(resolved.dir)?.host : undefined;
      const owner = controller(session);
      if (host) {
        if (parsed.value.physical || (parsed.value.slot !== undefined && parsed.value.slot !== 'default')) {
          return refuseControl('bad-request', 'Hosted macOS control requires the default, non-physical target.');
        }
        return relay.begin(
          id,
          host,
          parsed.value.takeOver === true,
          () =>
            socket.readyState === socket.OPEN &&
            controllers.get(socket) === owner &&
            readDevices().some((entry) => entry.id === session.id && entry.capabilities.includes('control')),
          { workspace: resolved.dir, device: { id: session.id, name: session.name } },
        );
      }
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
      method: (typeof INPUT_METHODS)[number],
      params: unknown,
      session: Pick<PairedDevice, 'id' | 'name'>,
    ): Promise<void> {
      const owner = controller(session);
      const parsed = parseInput(method, params, (name) => relay.targetOf(name) ?? control.targetOf(owner, name));
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
      const { shapeChangesPerSecond } = controlLimits;
      if (
        (sent.input === 'rotate' || sent.input === 'posture' || sent.input === 'simulator') &&
        !take(shapeChanges, 1, shapeChangesPerSecond, shapeChangesPerSecond)
      ) {
        return error(id, 'limit-exceeded', `A connection can rotate or fold ${shapeChangesPerSecond} times a second.`);
      }
      if (relay.control(id, method, params)) return;
      const refused = await control.input(owner, parsed.value.session, parsed.value.command);
      if (refused && 'code' in refused) return error(id, refused.code, refused.message);
      send(socket, { id, result: refused ?? {} });
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
      const envelope = `{"event":"status","subscription":${JSON.stringify(subscription)},"payload":`;
      const stopUsage = recordUsage();
      const unsubscribe = feeds.subscribe(STATUS_FEED, {
        item: (_payload, text) => {
          const history = usage.history();
          const leases = control.ownLeaseTimes();
          send(
            socket,
            `${envelope}${text}${history ? `,"usage":${JSON.stringify(history)}` : ''}${
              leases.length ? `,"ownLeases":${JSON.stringify(leases)}` : ''
            }}`,
          );
        },
        failed: (message) => {
          stopUsage();
          subscriptions.delete(subscription);
          send(socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
        },
      });
      subscriptions.set(subscription, () => {
        stopUsage();
        unsubscribe();
      });
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

    function subscribeFrames(
      id: RequestId,
      params: unknown,
      hosted?: { client: string; session: string; view: ReturnType<HostedViews['target']> },
    ): void {
      const framePool = hosted?.view.frames ?? frames;
      const target = isJsonObject(params) ? params : {};
      const { workspace, platform, slot, physical, fps, maxEdge, video, at, rate, deviceFrame, duoFrame } = target;
      if (typeof workspace !== 'string' || !PLATFORMS.includes(platform as Platform)) {
        return error(
          id,
          'bad-request',
          'frames.subscribe needs params.workspace and params.platform (ios, android, web or macos).',
        );
      }
      if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
        return error(id, 'bad-request', 'slot must be 1-64 letters, digits, underscores or hyphens.');
      }
      if (physical !== undefined && typeof physical !== 'boolean') {
        return error(id, 'bad-request', 'physical must be true or false.');
      }
      if (deviceFrame !== undefined && typeof deviceFrame !== 'boolean') {
        return error(id, 'bad-request', 'deviceFrame must be true or false.');
      }
      if (
        duoFrame !== undefined &&
        (typeof duoFrame !== 'boolean' || (duoFrame && (platform !== 'ios' || physical || hosted)))
      ) {
        return error(id, 'bad-request', 'duoFrame needs a local owned iOS simulator.');
      }
      const wantsDuo = duoFrame === true && at === undefined;
      const wantsArtwork = deviceFrame === true && !physical && platform !== 'web';
      if (video !== undefined && (!Array.isArray(video) || !video.every((codec) => typeof codec === 'string'))) {
        return error(id, 'bad-request', 'video must be a list of codec names.');
      }
      const wantsVideo = (video as string[] | undefined)?.includes('h264') === true;
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
      const resolvedDir = hosted ? null : workspaceDir(id, workspace, true);
      if (!hosted && !resolvedDir) return;
      const host = !hosted && platform === 'macos' && resolvedDir ? readMacosRecord(resolvedDir)?.host : undefined;
      if (host) {
        if ((slot !== undefined && slot !== 'default') || physical || at !== undefined || rate !== undefined) {
          return error(
            id,
            'bad-request',
            'Hosted macOS frames require the default, non-physical target without replay.',
          );
        }
        return void relay.subscribe(id, host, target, (subscription, stop) => subscriptions.set(subscription, stop));
      }
      const offersVideo = wantsVideo && !wantsDuo && frameHelper() !== null;
      const replayAt = parseReplay(at, rate);
      if (typeof replayAt === 'string') return error(id, 'bad-request', replayAt);
      if (replayAt && !offersVideo) {
        return error(id, 'bad-request', 'Replay needs a video subscription: pass video: ["h264"].');
      }
      const hint: FrameHint = {
        fps: Math.min((fps as number | undefined) ?? FRAME_FPS.default, offersVideo ? FRAME_FPS.video : FRAME_FPS.max),
        maxEdge: (maxEdge as number | undefined) ?? FRAME_EDGE.default,
      };
      const replayDir =
        platform === 'macos'
          ? null
          : recordingDir(workspace, platform as RecordingPlatform, typeof slot === 'string' ? slot : 'default');
      if (replayAt && (physical || replayDir === null || !hasFootage(replayDir))) {
        return error(
          id,
          'no-recording',
          `Nothing was recorded for ${physical ? 'a physical ' : ''}${platform} in ${workspace}.`,
        );
      }
      const subscription = openSubscription(id, offersVideo ? { video: 'h264' } : {});
      if (!subscription) return;
      const frameTarget: FrameTarget = {
        workspace,
        platform: platform as Platform,
        ...(slot ? { slot } : {}),
        ...(physical ? { physical } : {}),
      };
      const gate = new VideoGate(DEFAULT_VIDEO_LIMITS.congestedBytes);
      let sequence = 0;
      let streamed: Device | null = null;
      let draining: NodeJS.Timeout | null = null;
      const drain = () => {
        draining = null;
        if (ended || !streamed) return;
        if (socket.bufferedAmount <= DEFAULT_VIDEO_LIMITS.congestedBytes) return framePool.keyframe(streamed);
        framePool.congested(streamed);
        draining = setTimeout(drain, FRAME_RETRY_MS);
      };
      let attached: string | null = null;
      let detach: (() => void) | null = null;
      let ended = false;
      const delivery = new LatestFrames<Frame>(
        hint.fps,
        () => socket.bufferedAmount,
        (frame) => {
          send(socket, {
            event: 'frame',
            subscription,
            platform: frameTarget.platform,
            slot: slot ?? 'default',
            mime: 'image/jpeg',
            ...frame,
          });
        },
      );
      const cleanup = () => {
        ended = true;
        player?.stop();
        replays.delete(subscription);
        stopViewing?.();
        keyframes.delete(subscription);
        congestion.delete(subscription);
        delivery.stop();
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
        frame: (frame: Frame) => delivery.push(frame),
        delayed: (delayed: boolean, reason?: string) => {
          if (!ended) send(socket, { event: 'frame-delayed', subscription, delayed, ...(reason ? { reason } : {}) });
        },
        failed: end,
        ...(frameTarget.platform === 'macos'
          ? {
              windows: ({
                current,
                windows,
                pinned,
              }: {
                current: MacosWindow | null;
                windows: MacosWindow[];
                pinned: boolean;
              }) => {
                if (!ended) send(socket, { event: 'macos-windows', subscription, current, windows, pinned });
              },
            }
          : {}),
        ...(wantsDuo ? { duo: (frame: Frame) => delivery.push(frame) } : {}),
        ...(wantsArtwork
          ? {
              artwork: (artwork: DeviceFrameArtwork | null) => {
                if (!ended && !player) send(socket, { event: 'device-frame', subscription, artwork });
              },
            }
          : {}),
        ...(offersVideo
          ? {
              video: (unit: AccessUnit) => {
                if (ended || player || socket.readyState !== socket.OPEN) return;
                const verdict = gate.admit(unit, socket.bufferedAmount);
                if (verdict === 'send') socket.send(videoPacket(subscription, sequence++, unit));
                else if (verdict === 'congested' && !draining) drain();
              },
            }
          : {}),
      };
      let player: Player | null = null;
      let latest: StatusPayload | null = null;
      const attach = (resolved: Device) => {
        if (wantsArtwork) send(socket, { event: 'device-frame', subscription, artwork: null });
        if (!hosted && resolved.platform === 'macos') nativeViewerOpened = true;
        detach?.();
        gate.reset();
        streamed = resolved;
        attached = deviceKey(resolved);
        detach = hosted
          ? hostedViews.subscribe(hosted.client, hosted.session, listener, hint)
          : framePool.subscribe(resolved, listener, hint);
      };
      const replay = (): Player => {
        if (player) return player;
        if (wantsArtwork) send(socket, { event: 'device-frame', subscription, artwork: null });
        detach?.();
        detach = null;
        attached = null;
        player = new Player(
          replayDir!,
          {
            unit: (unit) => {
              if (!ended && socket.readyState === socket.OPEN) socket.send(videoPacket(subscription, sequence++, unit));
            },
            bufferedBytes: () => socket.bufferedAmount,
            ended: (position) =>
              queueMicrotask(() => {
                if (!ended) send(socket, { event: 'replay-ended', subscription, at: position });
              }),
          },
          DEFAULT_VIDEO_LIMITS.congestedBytes,
        );
        return player;
      };
      const goLive = (): string | null => {
        const resolved = latest
          ? ownedDevice(latest, frameTarget, null, { adbEmulators })
          : 'The device status is not known yet.';
        if (typeof resolved === 'string') return resolved;
        player?.stop();
        player = null;
        attach(resolved);
        return null;
      };
      if (offersVideo) {
        congestion.set(subscription, () => {
          if (streamed && !player) framePool.congested(streamed);
        });
        keyframes.set(subscription, () => {
          if (player) return player.resend();
          gate.reset();
          if (streamed) framePool.keyframe(streamed);
        });
        replays.set(subscription, {
          seek: (seekAt, seekRate) => {
            if (physical || replayDir === null || !hasFootage(replayDir)) return null;
            const wasLive = player === null;
            const shown = replay().seek(seekAt, seekRate);
            if (shown === null && wasLive) goLive();
            return shown;
          },
          live: goLive,
        });
      }
      if (replayAt && replay().seek(replayAt.at, replayAt.rate) === null) {
        send(socket, { event: 'replay-ended', subscription, at: replayAt.at });
      }
      const stopViewing = physical || hosted ? undefined : recorder?.viewing(frameTarget);
      let unsubscribeStatus: (() => void) | null = null;
      if (hosted) attach(hosted.view.device);
      else
        unsubscribeStatus = feeds.subscribe(STATUS_FEED, {
          item: (payload) => {
            if (ended) return;
            latest = payload as unknown as StatusPayload;
            if (player) return;
            const resolved = ownedDevice(latest, frameTarget, attached, { adbEmulators });
            if (typeof resolved === 'string') return queueMicrotask(() => end(resolved));
            if (deviceKey(resolved) === attached) return;
            attach(resolved);
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
      stats = false,
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
        run = stats ? runStats(options.env, cwd, limits) : runStim(options.stimCli, options.env, args, cwd, limits);
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

    function workspaceChanges(id: RequestId, method: 'workspace.files' | 'workspace.diff', params: unknown): void {
      const needsPath = method === 'workspace.diff';
      if (
        !isJsonObject(params) ||
        typeof params.workspace !== 'string' ||
        !params.workspace.length ||
        params.workspace.length > 4096 ||
        params.workspace.includes('\0') ||
        (!needsPath && params.group !== 'changed' && params.group !== 'untracked') ||
        (needsPath &&
          (typeof params.path !== 'string' ||
            !params.path.length ||
            params.path.length > 4096 ||
            params.path.includes('\0'))) ||
        Object.keys(params).some((key) => key !== 'workspace' && !(needsPath ? key === 'path' : key === 'group'))
      ) {
        return error(id, 'bad-request', 'Workspace diff requires workspace and, for a patch, a file path.');
      }
      const cwd = workspaceDir(id, params.workspace, true);
      if (!cwd) return;
      if (commands.size >= MAX_COMMANDS) {
        return error(id, 'limit-exceeded', `A connection can run ${MAX_COMMANDS} requests at a time.`);
      }
      const abort = new AbortController();
      let task: Promise<void>;
      const cancel = async () => {
        abort.abort();
        await task;
      };
      commands.add(cancel);
      running.add(cancel);
      task = readWorkspaceDiff(
        cwd,
        needsPath ? (params.path as string) : undefined,
        options.env,
        abort.signal,
        !needsPath ? (params.group as 'changed' | 'untracked') : undefined,
      )
        .then(
          (result) => {
            if (!abort.signal.aborted) send(socket, { id, result });
            return undefined;
          },
          (cause: Error) => {
            if (!abort.signal.aborted) error(id, 'stim-failed', cause.message);
            return undefined;
          },
        )
        .finally(() => {
          commands.delete(cancel);
          running.delete(cancel);
        });
      return;
    }

    function workspaceCommand(id: RequestId, method: 'stats.get' | 'settings.get', params: unknown): void {
      if (params !== undefined && !isJsonObject(params)) return error(id, 'bad-request', 'params must be an object.');
      const cwd = workspaceDir(id, params?.workspace, false);
      if (!cwd) return;
      command<typeof method>(
        id,
        [method === 'stats.get' ? 'stats' : 'settings', '--json'],
        cwd,
        (stdout) => {
          const value: unknown = JSON.parse(stdout);
          if (!isJsonObject(value)) throw new Error('not an object');
          return value;
        },
        commandLimits,
        null,
        method === 'stats.get',
      );
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

    function collect(args: string[], cwd: string): Promise<NdjsonRecord[] | string> {
      const run = runStim(options.stimCli, options.env, args, cwd, commandLimits);
      const cancel = () => run.cancel();
      commands.add(cancel);
      running.add(cancel);
      return run.outcome.then((outcome) => {
        commands.delete(cancel);
        running.delete(cancel);
        if (!outcome.ok) return outcome.message;
        return outcome.stdout.split('\n').flatMap((line) => {
          const record = parseNdjsonLine(line);
          return record ? [record] : [];
        });
      });
    }

    function replayRange(id: RequestId, params: unknown): void {
      const target = isJsonObject(params) ? params : {};
      const { workspace, platform, slot } = target;
      if (typeof workspace !== 'string' || !RECORDING_PLATFORMS.includes(platform as RecordingPlatform)) {
        return error(
          id,
          'bad-request',
          'replay.range needs params.workspace and params.platform (ios, android or web).',
        );
      }
      if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
        return error(id, 'bad-request', 'params.slot must be 1-64 letters, digits, underscores or hyphens.');
      }
      const cwd = workspaceDir(id, workspace, true);
      if (!cwd) return;
      if (commands.size + 2 > MAX_COMMANDS) {
        return error(id, 'limit-exceeded', `A connection can run ${MAX_COMMANDS} requests at a time.`);
      }
      const slotName = slot ?? 'default';
      const spans = recordedSpans(listSegments(recordingDir(workspace, platform as RecordingPlatform, slotName)));
      const replayTarget = { workspace, platform: platform as RecordingPlatform, slot: slotName };
      const state = {
        enabled: recorder?.enabled(workspace) ?? false,
        recording: recorder?.recording(replayTarget) ?? false,
        spans,
      };
      if (!spans.length) return send(socket, { id, result: { ...state, markers: [] } });
      const since = `--since=${Math.ceil((Date.now() - spans[0]!.start) / 60_000) + 1}m`;
      void Promise.all([
        collect(['logs', '--json', '--source', 'agent', since, '--tail=5000'], cwd),
        collect(
          ['logs', '--json', '--source', 'metro', 'client', 'build', 'device', '--level=error', since, '--tail=5000'],
          cwd,
        ),
      ]).then(([actions, errors]) => {
        const failed = [actions, errors].find((result) => typeof result === 'string');
        if (typeof failed === 'string') return error(id, 'stim-failed', failed);
        const records = [...(actions as NdjsonRecord[]), ...(errors as NdjsonRecord[])];
        const markers = timelineMarkers(records, platform as RecordingPlatform, slotName, spans[0]!.start);
        return send(socket, { id, result: { ...state, markers } });
      });
    }

    function replayKeyframe(id: RequestId, params: unknown): void {
      const target = isJsonObject(params) ? params : {};
      const { workspace, platform, slot, at } = target;
      if (typeof workspace !== 'string' || !RECORDING_PLATFORMS.includes(platform as RecordingPlatform)) {
        return error(
          id,
          'bad-request',
          'replay.keyframe needs params.workspace and params.platform (ios, android or web).',
        );
      }
      if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
        return error(id, 'bad-request', 'params.slot must be 1-64 letters, digits, underscores or hyphens.');
      }
      if (typeof at !== 'number' || !Number.isFinite(at))
        return error(id, 'bad-request', 'at must be epoch milliseconds.');
      if (!workspaceDir(id, workspace, true)) return;
      if (keyframeReads >= MAX_KEYFRAME_READS) {
        return error(id, 'limit-exceeded', `A connection can read ${MAX_KEYFRAME_READS} keyframes at a time.`);
      }
      keyframeReads++;
      void segmentKeyframe(recordingDir(workspace, platform as RecordingPlatform, slot ?? 'default'), at).then(
        (found) => {
          keyframeReads--;
          if (!found) return error(id, 'no-recording', 'Nothing was recorded for this device.');
          const { segment, unit } = found;
          return send(socket, {
            id,
            result: {
              start: segment.start,
              end: segment.end,
              at: unit.capturedAt,
              width: unit.width,
              height: unit.height,
              ...(unit.posture ? { posture: unit.posture } : {}),
              data: unit.data.toString('base64'),
            },
          });
        },
      );
    }

    function setRecording(id: RequestId, params: unknown, session: PairedDevice): void {
      const enabled = isJsonObject(params) ? params.enabled : undefined;
      const record: AuditRecord = {
        at: new Date().toISOString(),
        device: { id: session.id, name: session.name },
        action: 'recording.set',
        workspace: null,
        ok: false,
      };
      const audit = (outcome: Pick<AuditRecord, 'ok' | 'error'>) => {
        try {
          appendAudit({ ...record, ...outcome });
        } catch (cause) {
          console.error(`stim-server: could not append to the action log: ${(cause as Error).message}`);
        }
      };
      const refuseSetting = (code: ErrorCode, message: string) => {
        audit({ ok: false, error: { code, message } });
        error(id, code, message);
      };
      if (
        !readDevices()
          .find((entry) => entry.id === session.id)
          ?.capabilities.includes('control')
      ) {
        return refuseSetting(
          'forbidden',
          `This device can only read. On the Mac, run \`stim-server devices grant ${session.id} --control\` to let it change settings.`,
        );
      }
      if (typeof enabled !== 'boolean') return refuseSetting('bad-request', 'params.enabled must be true or false.');
      recordingTurn = cancelling.track(
        recordingTurn
          .catch(() => {})
          .then(async () => {
            if (closing) return;
            const run = runStim(
              options.stimCli,
              options.env,
              ['settings', 'set', 'recording.enabled', String(enabled), '--scope', 'machine', '--json'],
              homedir(),
              actionLimits,
            );
            let stop!: () => void;
            const stopped = new Promise<null>((resolve) => {
              stop = () => resolve(null);
            });
            const cancel = () => {
              stop();
              return run.cancel();
            };
            running.add(cancel);
            const outcome = await Promise.race([run.outcome, stopped]);
            running.delete(cancel);
            if (!outcome) return;
            const printed = actionOutcome(outcome);
            if (!printed.ok) return refuseSetting('action-failed', printed.error.message);
            audit({ ok: true });
            const deleted = printed.output.recordingsDeleted;
            const recordingsDeleted = Array.isArray(deleted) ? deleted.filter((path) => typeof path === 'string') : [];
            return send(socket, { id, result: { enabled, recordingsDeleted } });
          }),
      );
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

    function registerPush(id: RequestId, params: unknown, session: PairedDevice): void {
      const value = isJsonObject(params) ? params : {};
      const { token, events, ref } = value;
      const agentOnly = value.agentOnly ?? false;
      const stuckMinutes = value.stuckMinutes ?? DEFAULT_STUCK_MINUTES;
      const quietHours = value.quietHours === undefined ? null : parseQuietHours(value.quietHours);
      const levels = value.levels === undefined ? undefined : parseLevels(value.levels);
      if (
        typeof token !== 'string' ||
        !pushToken.test(token) ||
        !Array.isArray(events) ||
        events.length === 0 ||
        !events.every((event) => ([...PUSH_EVENTS, ...LEGACY_PUSH_EVENTS] as readonly unknown[]).includes(event)) ||
        typeof agentOnly !== 'boolean' ||
        typeof ref !== 'string' ||
        ref.length === 0 ||
        ref.length > 128 ||
        !validStuckMinutes(stuckMinutes) ||
        (value.quietHours !== undefined && quietHours === null) ||
        levels === null
      ) {
        return error(
          id,
          'bad-request',
          'push.register takes an Expo push token, one or more events from ' +
            `${PUSH_EVENTS.join(', ')}, a ref of 1 to 128 characters, and optionally stuckMinutes from 1 to 240 and ` +
            'quietHours { start, end, timeZone } in minutes after midnight and an IANA time zone, and levels ' +
            `mapping events to ${NOTIFICATION_LEVELS.join(' or ')}.`,
        );
      }
      const registered = setDevicePush(session.id, {
        token,
        events: pushEvents(events),
        ...(levels ? { levels } : {}),
        ref,
        registeredAt: new Date().toISOString(),
        stuckMinutes,
        quietHours,
      });
      if (!registered) return error(id, 'unauthorized', 'This device is no longer paired.');
      push.refresh();
      send(socket, { id, result: {} });
    }

    async function buildMethod(id: RequestId, method: string, params: unknown, session: PairedDevice): Promise<void> {
      if (!buildAllowed(session)) {
        return error(id, 'forbidden', `${method} needs build access, which this Mac has not granted this device.`);
      }
      buildSession ??= builds.session(session.id, socket, (event) => send(socket, event));
      const answer =
        method === 'build.offer'
          ? await builds.offer(session.id, params)
          : method === 'build.sync'
            ? buildSession.sync(params)
            : method === 'build.start'
              ? await buildSession.start(params)
              : method === 'build.cancel'
                ? buildSession.cancel(params)
                : method === 'build.attach'
                  ? buildSession.attach(params)
                  : await buildSession.artifact(params);
      send(socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
    }

    function desktopMethod(
      id: RequestId,
      method: string,
      params: unknown,
      session: PairedDevice,
    ): Promise<void> | null {
      if (method !== 'route.setup' && method !== 'machines.update.start' && method !== 'machines.update.status')
        return null;
      if (!localControl || session.identity.kind !== 'local' || !session.capabilities.includes('control')) {
        return Promise.resolve(
          error(
            id,
            'forbidden',
            method === 'route.setup'
              ? 'Phone connection setup requires an authenticated local Desktop control connection.'
              : 'Updating another Mac requires an authenticated local Desktop control connection.',
          ),
        );
      }
      return method === 'route.setup' ? setupRoute(id, params) : updateMachine(id, method, params);
    }

    async function setupRoute(id: RequestId, params: unknown): Promise<void> {
      if (params !== undefined && (!isJsonObject(params) || Object.keys(params).length)) {
        return error(id, 'bad-request', 'route.setup takes no parameters.');
      }
      const { binary, state } = tailscaleNow();
      settingUpRoute ??= setupServeRoute(binary, options.env, addresses[0]!.port, state).finally(() => {
        settingUpRoute = null;
      });
      try {
        return send(socket, { id, result: await settingUpRoute });
      } catch (cause) {
        return error(id, 'action-failed', (cause as Error).message);
      }
    }

    async function updateMachine(id: RequestId, method: string, params: unknown): Promise<void> {
      const machine = isJsonObject(params) ? params.machine : undefined;
      if (typeof machine !== 'string' || !machine) return error(id, 'bad-request', 'params.machine names the Mac.');
      const answer =
        method === 'machines.update.start' ? await machineUpdates.start(machine) : await machineUpdates.status(machine);
      return send(socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
    }

    function machineMethod(
      id: RequestId,
      method: string,
      params: unknown,
      session: PairedDevice,
    ): Promise<void> | null {
      if ((BUILD_METHODS as readonly string[]).includes(method)) return buildMethod(id, method, params, session);
      if ((SERVER_UPDATE_METHODS as readonly string[]).includes(method))
        return updateMethod(id, method, params, session);
      return null;
    }

    async function updateMethod(id: RequestId, method: string, params: unknown, session: PairedDevice): Promise<void> {
      const approved =
        session.identity.kind === 'tailnet' &&
        (readBuildClients().some((entry) => entry.id === session.id && entry.capabilities.includes('build')) ||
          readDeviceHostClients().some(
            (entry) => entry.id === session.id && entry.capabilities.includes('device-host'),
          ));
      if (!approved) {
        return error(
          id,
          'forbidden',
          `${method} needs this Mac's build or device-host approval of the requesting Mac.`,
        );
      }
      if (method === 'server.update.status') return send(socket, { id, result: await updates.status() });
      const answer =
        method === 'server.update.start'
          ? await updates.start({ id: session.id, name: session.name }, params)
          : updates.chunk(session.id, params);
      send(socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
    }

    function handleBinary(frame: Buffer): void {
      if (socket.readyState !== socket.OPEN) return;
      if (!device || !buildSession) {
        return void socket.close(CLOSE_BAD_REQUEST, 'unexpected binary frame');
      }
      const refused = buildSession.blob(frame);
      if (refused) socket.close(CLOSE_BAD_REQUEST, refused.slice(0, 120));
    }

    async function hostedMethod(id: RequestId, method: string, raw: unknown, session: PairedDevice): Promise<void> {
      const params = isJsonObject(raw) ? raw : {};
      if (method === 'device-host.frames.subscribe' || method === 'device-host.control.begin') {
        if (typeof params.session !== 'string') return error(id, 'bad-request', 'A hosted session is required.');
        if (
          method === 'device-host.control.begin' &&
          params.takeOver !== undefined &&
          typeof params.takeOver !== 'boolean'
        )
          return error(id, 'bad-request', 'takeOver must be true or false.');
        if (method === 'device-host.frames.subscribe' && (params.at !== undefined || params.rate !== undefined))
          return error(id, 'bad-request', 'Hosted recorded replay is not supported.');
        try {
          const hostedSession = params.session;
          if (method === 'device-host.frames.subscribe') {
            const view = hostedViews.target(session.id, hostedSession);
            return subscribeFrames(
              id,
              { ...params, workspace: view.workspace, platform: view.device.platform, slot: view.slot },
              { client: session.id, session: hostedSession, view },
            );
          }
          const owner = controller(session);
          const outcome = await hostedViews.begin(
            session.id,
            hostedSession,
            owner,
            params.takeOver === true,
            () => socket.readyState === socket.OPEN && controllers.get(socket) === owner,
          );
          return 'code' in outcome ? error(id, outcome.code, outcome.message) : send(socket, { id, result: outcome });
        } catch (cause) {
          return error(id, 'action-failed', (cause as Error).message);
        }
      }
      if (method === 'device-host.frames.keyframe') {
        const name = params.subscription;
        const keyframe = typeof name === 'string' ? keyframes.get(name) : undefined;
        if (!keyframe) return error(id, 'unknown-subscription', `No video subscription ${String(name)}.`);
        keyframe();
        return send(socket, { id, result: {} });
      }
      if (method === 'device-host.frames.congested') {
        const name = params.subscription;
        const congested = typeof name === 'string' ? congestion.get(name) : undefined;
        if (!congested) return error(id, 'unknown-subscription', `No video subscription ${String(name)}.`);
        congested();
        return send(socket, { id, result: {} });
      }
      if (method === 'device-host.unsubscribe') {
        const name = params.subscription;
        const unsubscribe = typeof name === 'string' ? subscriptions.get(name) : undefined;
        if (!unsubscribe) return error(id, 'unknown-subscription', `No subscription ${String(name)}.`);
        unsubscribe();
        subscriptions.delete(name as string);
        return send(socket, { id, result: {} });
      }
      if (method === 'device-host.control.end') {
        const name = params.session;
        if (typeof name !== 'string' || !control.endById(controller(session), name))
          return error(id, 'unknown-session', `No control session ${String(name)} on this connection.`);
        return send(socket, { id, result: {} });
      }
      if (method.startsWith('device-host.input.')) {
        const inputMethod = method.slice('device-host.'.length) as (typeof INPUT_METHODS)[number];
        return input(id, inputMethod, raw, session);
      }
      const answer =
        method === 'device-host.offer'
          ? await hostedDevices.offer(session.id, raw)
          : method === 'device-host.reserve'
            ? hostedDevices.reserve(session.id, raw)
            : method === 'device-host.attach'
              ? hostedDevices.attach(session.id, raw)
              : method === 'device-host.stop'
                ? hostedDevices.stop(session.id, raw)
                : method === 'device-host.app.offer'
                  ? hostedDevices.appOffer(session.id, raw)
                  : method === 'device-host.app.chunk'
                    ? await hostedDevices.appChunk(session.id, raw)
                    : method === 'device-host.app.handoff'
                      ? await hostedDevices.appHandoff(session.id, raw)
                      : method === 'device-host.app.launch'
                        ? hostedDevices.appLaunch(session.id, raw)
                        : method === 'device-host.app.attach'
                          ? hostedDevices.appAttach(session.id, raw)
                          : method === 'device-host.logs.query'
                            ? hostedDevices.logsQuery(session.id, raw)
                            : method === 'device-host.metro.open'
                              ? await hostedDevices.metroOpen(session.id, raw, peer)
                              : await hostedDevices.metroClose(session.id, raw);
      return send(socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
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
      if ((DEVICE_HOST_METHODS as readonly string[]).includes(message.method)) {
        if (!device.capabilities.includes('device-host'))
          return error(id, 'forbidden', 'Explicit device-host approval is required.');
        return hostedMethod(id, message.method, message.params, device);
      }
      const approvedMachine = machineMethod(id, message.method, message.params, device);
      if (approvedMachine) return approvedMachine;
      if (!device.capabilities.includes('read')) {
        return error(id, 'forbidden', `${message.method} needs read access, which this connection does not have.`);
      }
      const desktop = desktopMethod(id, message.method, message.params, device);
      if (desktop) return desktop;
      if (message.method === 'status.subscribe') return subscribeStatus(id);
      if (message.method === 'logs.subscribe') return subscribeLogs(id, message.params);
      if (message.method === 'logs.query') return queryLogs(id, message.params);
      if (message.method === 'frames.subscribe') return subscribeFrames(id, message.params);
      if (message.method === 'frames.keyframe') {
        const name = isJsonObject(message.params) ? message.params.subscription : undefined;
        if (typeof name === 'string' && relay.keyframe(id, name)) return;
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
      if (message.method === 'frames.seek' || message.method === 'frames.live') {
        const params = isJsonObject(message.params) ? message.params : {};
        const replayable = typeof params.subscription === 'string' ? replays.get(params.subscription) : undefined;
        if (!replayable) {
          return error(id, 'unknown-subscription', `No video subscription ${String(params.subscription)}.`);
        }
        if (message.method === 'frames.live') {
          const refused = replayable.live();
          return refused ? error(id, 'frames-failed', refused) : send(socket, { id, result: {} });
        }
        const parsed = parseReplay(params.at, params.rate);
        if (!parsed || typeof parsed === 'string') {
          return error(id, 'bad-request', parsed ?? 'frames.seek needs params.at and params.rate.');
        }
        const shown = replayable.seek(parsed.at, parsed.rate);
        if (shown === null) return error(id, 'no-recording', 'Nothing was recorded for this device.');
        return send(socket, { id, result: { at: shown } });
      }
      if (message.method === 'replay.range') return replayRange(id, message.params);
      if (message.method === 'replay.keyframe') return replayKeyframe(id, message.params);
      if (message.method === 'recording.set') return setRecording(id, message.params, device);
      if (message.method === 'build.plan') return planBuild(id, message.params);
      if (message.method === 'machine.get') return send(socket, { id, result: await readMachineUsage() });
      if (message.method === 'machine.details') {
        const machinesPart = buildMachines.snapshot(runDetailsCommand, doctorTarget());
        void machineDetails.get().then((result) => send(socket, { id, result: { ...result, ...machinesPart } }));
        return;
      }
      if (message.method === 'machine.history') {
        const params = message.params ?? {};
        const sinceMs = isJsonObject(params) ? params.sinceMs : undefined;
        if (!isJsonObject(params) || (sinceMs !== undefined && typeof sinceMs !== 'number')) {
          return error(id, 'bad-request', 'machine.history takes an optional numeric sinceMs.');
        }
        return send(socket, { id, result: sampler.history(sinceMs) });
      }
      if (isWorkspaceChangeMethod(message.method)) {
        return workspaceChanges(id, message.method, message.params);
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
        if (relay.control(id, message.method, message.params)) return;
        const name = isJsonObject(message.params) ? message.params.session : undefined;
        if (typeof name !== 'string' || !control.endById(controller(device), name)) {
          return error(id, 'unknown-session', `No control session ${String(name)} on this connection.`);
        }
        return send(socket, { id, result: {} });
      }
      const inputMethod = INPUT_METHODS.find((method) => method === message.method);
      if (inputMethod) {
        void input(id, inputMethod, message.params, device);
        return;
      }
      if (message.method === 'push.register') return registerPush(id, message.params, device);
      if (message.method === 'notifications.list') {
        const params = message.params ?? {};
        const since = isJsonObject(params) ? params.since : undefined;
        if (!isJsonObject(params) || (since !== undefined && !(Number.isInteger(since) && (since as number) >= 0))) {
          return error(id, 'bad-request', 'notifications.list takes an optional since, a cursor of 0 or more.');
        }
        listeners.add(socket);
        return send(socket, { id, result: notificationLog.list(device.id, since as number | undefined) });
      }
      if (message.method === 'push.unregister') {
        setDevicePush(device.id, null);
        push.refresh();
        return send(socket, { id, result: {} });
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

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
        queue = queue.then(() => handleBinary(frame)).catch(() => socket.close(1011, 'internal error'));
        return;
      }
      const raw = data.toString();
      queue = queue.then(() => handle(raw)).catch(() => socket.close(1011, 'internal error'));
    });
    socket.on('close', (code) => {
      relay.close();
      relays.delete(socket);
      clearTimeout(timer);
      buildSession?.close(code === CLOSE_ABNORMAL && device !== null && buildAllowed(device));
      sessions.delete(socket);
      listeners.delete(socket);
      if (sessions.size === 0) sampler.stop();
      const owner = controllers.get(socket);
      if (owner) control.endFor(owner, null, 'The client disconnected.');
      controllers.delete(socket);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      for (const cancel of commands) {
        running.delete(cancel);
        void cancelling.track(cancel());
      }
      commands.clear();
    });
  }

  function upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    if (startup.state !== 'ready') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const peer = peerAddress(request);
    if (limiter.blocked(peer ?? 'local')) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const host = request.headers.host?.replace(/:\d+$/, '');
    const localControl =
      isLoopback(request.socket.remoteAddress) &&
      (host === '127.0.0.1' || host === 'localhost') &&
      ['origin', 'sec-fetch-site', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].every(
        (header) => request.headers[header] === undefined,
      );
    wss.handleUpgrade(request, socket, head, (ws) => connection(ws, peer, localControl));
  }

  const tailscaleNow = (): TailscaleSnapshot =>
    options.tailscaleMonitor?.current() ?? { binary: options.tailscale, state: options.tailscaleState };
  const health = {
    server: 'stim-server',
    name: options.name,
    version: options.serverVersion,
    stim: options.stimVersion,
    stimBuild: ownStimBuild,
    protocol: PROTOCOL_VERSION,
    stimHome: configDir(),
  } as const;
  const answerHealth = async (response: ServerResponse) => {
    const { binary, state: tailscale } = tailscaleNow();
    const route =
      tailscale.state === 'running' && tailscale.dnsName
        ? await serveRoute(binary, options.env, addresses[0]!.port, tailscale.ips, HEALTH_ROUTE_TIMEOUT_MS)
        : undefined;
    const body: ServerHealth = {
      ...health,
      startup,
      ...(options.host ? { host: await hostHealth() } : {}),
      busy: { builds: builds.running(), hostedSessions: hostedDevices.active() },
      tailscale: healthTailscale(tailscale),
      route,
      nativeViewerOpened,
    };
    response
      .writeHead(startup.state === 'ready' ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify(body));
  };
  const servers = new Map<string, { server: Server; sockets: Set<Socket> }>();
  const addresses: RunningServer['addresses'] = [];
  const close = async () => {
    closing = true;
    if (startupRetry) clearTimeout(startupRetry);
    startupProbe?.cancel();
    watcher?.close();
    if (revocationPoll) clearInterval(revocationPoll);
    if (revocationCheck) clearTimeout(revocationCheck);
    await builds.close();
    for (const client of wss.clients) client.terminate();
    hostConnections.close();
    if (startup.state === 'ready') {
      push.close();
      helperAbort.abort();
      sampler.stop();
      await control.close();
      await agentDrivers.close();
      await hostedDevices.close();
      updates.close();
      recorder?.close();
      await Promise.all([
        frames.close(),
        feeds.close(),
        ...[...running].map((cancel) => cancel()),
        cancelling.settled(),
      ]);
    }
    wss.close();
    await Promise.all([...servers.values()].map(closeListener));
  };
  async function listenOn(host: string): Promise<void> {
    const server = createServer((request, response) => {
      if (localHealthRequest(request)) {
        void answerHealth(response);
        return;
      }
      if (
        request.method === 'GET' &&
        request.url === '/health' &&
        peerAddress(request) !== null &&
        request.headers.origin === undefined &&
        request.headers['sec-fetch-site'] === undefined
      ) {
        const peerHealth = { server: health.server, version: health.version, protocol: health.protocol };
        response
          .writeHead(startup.state === 'ready' ? 200 : 503, { 'content-type': 'application/json' })
          .end(JSON.stringify(peerHealth));
        return;
      }
      const agent = /^\/device-host\/agent\/([a-f0-9-]{36})(?:[/?]|$)/.exec(request.url ?? '');
      if (agent && startup.state !== 'ready') {
        response.writeHead(503, { 'content-type': 'text/plain' }).end('stim-server is not ready.\n');
        return;
      }
      if (agent) {
        answerAgent(request, response, agent[1]!).catch(() => {
          if (response.headersSent) response.destroy();
          else response.writeHead(500, { 'content-type': 'text/plain' }).end('Agent control failed.\n');
        });
        return;
      }
      response.writeHead(426, { 'content-type': 'text/plain' }).end('stim-server speaks WebSocket only.\n');
    });
    server.on('upgrade', upgrade);
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(addresses[0]?.port ?? options.port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    servers.set(host, { server, sockets });
    addresses.push({ host, port: (server.address() as AddressInfo).port });
  }
  try {
    for (const host of options.hosts) await listenOn(host);
  } catch (error) {
    await close();
    throw error;
  }
  const monitor = options.tailscaleMonitor;
  const listenFailures = new Set<string>();
  const reconcile = async (snapshot: TailscaleSnapshot) => {
    const tailnet = snapshot.state.state === 'running' ? snapshot.state.ips : [];
    const wanted = new Set([...options.hosts, ...tailnet]);
    for (const [host, listener] of servers) {
      if (wanted.has(host)) continue;
      servers.delete(host);
      addresses.splice(
        addresses.findIndex((address) => address.host === host),
        1,
      );
      await closeListener(listener);
    }
    let failed = false;
    for (const host of wanted) {
      if (servers.has(host) || closing) continue;
      try {
        await listenOn(host);
      } catch (error) {
        failed = true;
        if (!listenFailures.has(host)) {
          listenFailures.add(host);
          console.error(`stim-server: could not listen on ${host}: ${(error as Error).message}`);
        }
      }
    }
    if (failed && !closing) {
      retry = setTimeout(() => queueReconcile(), options.listenRetryMs ?? LISTEN_RETRY_MS);
      retry.unref();
    }
  };
  let retry: NodeJS.Timeout | null = null;
  let reconciling = Promise.resolve();
  const queueReconcile = () => {
    if (retry) clearTimeout(retry);
    retry = null;
    if (monitor) reconciling = reconciling.then(() => reconcile(monitor.current()));
  };
  queueReconcile();
  await reconciling;
  const stopWatching = monitor?.onChange(queueReconcile);
  let settle!: (state: StartupState) => void;
  const ready = new Promise<StartupState>((resolve) => {
    settle = resolve;
  });
  const checkHome = async (): Promise<void> => {
    const directories = [configDir(), serverDir(), join(configDir(), 'workspaces')];
    if (options.record !== false) {
      const recorderRoot = join(serverDir(), 'recorder');
      directories.push(exclusiveClaimDir(recorderRoot), sharedClaimDir(recorderRoot));
    }
    startupProbe = probeDirectories(directories, options.env, options.startupProbeMs ?? STARTUP_PROBE_MS, configDir());
    let reason = await startupProbe.result;
    startupProbe = null;
    if (closing) return settle(startup);
    if (reason === null) {
      try {
        becomeReady();
      } catch (error) {
        reason = (error as Error).message;
      }
    }
    if (reason === null) {
      if (startup.state === 'degraded') console.error('stim-server: the Stim home answers again; serving clients.');
      startup = { state: 'ready' };
      return settle(startup);
    }
    if (startup.state !== 'degraded' || startup.reason !== reason) {
      console.error(`stim-server: listening, but not serving clients until the Stim home answers. ${reason}`);
    }
    startup = { state: 'degraded', reason };
    settle(startup);
    startupRetry = setTimeout(() => void checkHome(), options.startupRetryMs ?? STARTUP_RETRY_MS);
  };
  void checkHome();
  return {
    addresses,
    ready,
    close: async () => {
      stopWatching?.();
      const closed = close();
      if (retry) clearTimeout(retry);
      await Promise.all([reconciling, closed]);
      await Promise.all([...servers.values()].map(closeListener));
    },
  };
}
