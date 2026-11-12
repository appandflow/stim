import { hkdfSync } from 'node:crypto';
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { isIP, Socket, type AddressInfo } from 'node:net';
import { type Duplex } from 'node:stream';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { configDir, type MetroLink } from '@stim-cli/core';
import {
  archiveDir,
  deviceHostArea,
  deviceHostAreas,
  readArchive,
  readBuildLedger,
  isGcLogRecord,
  readGcLog,
  queryLogs as queryMachineLogs,
  readSetupJournal,
  isJournalExpired,
  isJsonObject,
  loadConfig,
  stimBuildDigest,
  type StatusPayload,
  statusViews,
  type StatusViews,
  readShareLinks,
  shareLinkKey,
  shareRouteClaimRoot,
} from '@stim-cli/core/state';
import { createRequestLog } from './request-log.ts';
import { loadAudit } from './actions.ts';
import { cachedPeerNode } from './peer-node.ts';
import { configuredAgentDriver, recoverAgentDrivers, stoppingAgentDriver } from './agent-drivers.ts';
import { HostedAgentHost } from './agent-driver.ts';
import { DeviceHost } from './device-host.ts';
import { HOSTED_IDLE_SWEEP_MS } from './hosted-idle.ts';
import { HostedPresence } from './hosted-presence.ts';
import { HostedPresenceBridge } from './hosted-presence-bridge.ts';
import { HostedViews } from './hosted-view.ts';
import { HostConnections, HostedRelay } from './hosted-relay.ts';
import { BuildWorkerRoot } from './build.ts';
import { OffloadJobs } from './offload-jobs.ts';
import type { WorkerRootUsage } from './worker-areas.ts';
import { ControlHub, type Controller } from './control.ts';
import { Recorder } from './recorder.ts';
import { pruneSetupJournals, setupJournalForClient } from './setup-journal.ts';
import { type DesktopSetup } from './desktop-setup.ts';
import {
  probeDirectories,
  STARTUP_PROBE_MS,
  STARTUP_RETRY_MS,
  type StartupCause,
  type StartupState,
} from './startup.ts';
import { exclusiveClaimDir, sharedClaimDir } from '@stim-cli/core/ownership-claim';
import { FeedPool, type JsonObject } from './feed.ts';
import { StatusFeed } from './status-feed.ts';
import { buildFoldHelper, buildFrameHelper } from './frame-helper.ts';
import { DEFAULT_FRAME_LIMITS, FramePool, type FrameLimits } from './frames.ts';
import { type LogLimits } from './logs.ts';
import { readDiskVolumes, readMachineUsage, readMemoryPressure, UsageSampler } from './machine.ts';
import {
  BuildMachinesCache,
  doctorWorkspace,
  loadMachineDetails,
  MachineDetailsCache,
  type DetailsRead,
  type DoctorTarget,
} from './machine-details.ts';
import { UsageRecorder } from './usage-history.ts';
import { DesktopReports } from './desktop-reports.ts';
import {
  DEVICE_HOST_METHODS,
  MAX_INPUT_TEXT,
  PROTOCOL_VERSION,
  type ErrorCode,
  type ProtocolError,
  type HelloHost,
  type Methods,
  type RequestId,
  type VideoCodec,
} from './protocol.ts';
import { StimError } from 'stim';
import { createStim } from 'stim/api-self';
import { worktreePullRequests } from 'stim/pull-requests';
import { pauseShareLinkAsync } from 'stim/share-links';
import { holdNativeRun, SHARE_CLAIM_WAIT_MS } from './share-claim.ts';
import { restoreSavedShares } from './share-restore.ts';
import { savedLinkIs } from './share-save.ts';
import { digest } from './share-identity.ts';
import { NotificationLog, notificationLogFile, publicEntry } from './notification-log.ts';
import { EXPO_PUSH_API, PushNotifier } from './push.ts';
import {
  buildClientsReadable,
  dropPushToken,
  readRegistries,
  recordsForKey,
  RegistryUnavailable,
  secretPsk,
  serverIdentity,
  setDevicePush,
  serverDir,
  spendSecret,
  type KeyRecords,
  type PairedDevice,
  type Registries,
} from './registry.ts';
import {
  acceptNoise,
  HandshakeRefusal,
  HOME_UNAVAILABLE_MESSAGE,
  CLOSE_REFUSED,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_FIRST_MESSAGE_BYTES,
  MODE_FIRST_CONTACT,
  TRANSPORT_OVERHEAD_BYTES,
} from '@stim-cli/core/noise-session';
import { EngineUpdates } from './server-update.ts';
import { MachineUpdates } from './machine-update.ts';
import { Pending, type CommandLimits } from './stim-command.ts';
import { readHostPermissions } from './stim-host.ts';
import type { Transport, TransportIdentity } from '@stim-cli/transport';
import type { TailscaleState } from '@stim-cli/transport-tailscale';
import type { DesktopPlanRefusal, ServeRoute } from '@stim-cli/core/protocol';
import { DeviceViewers } from './viewers.ts';
import { HostedShareSource } from './share-hosted.ts';
import { ShareHub } from './share.ts';
import { androidScreen, simulatorScreen } from './device-screen.ts';
import { LocalAgentPresence } from './local-agent-presence.ts';
import { PresenceHub, presenceKey } from './presence.ts';
import { ExposedRoute, tailscaleHost, tailscaleLoggedIn } from './share-exposure.ts';
import { createKeepAwake, type KeepAwakeStatus } from './keep-awake.ts';
import { runsAsService } from './service.ts';
import { ShareRoute, tailscaleFunnel } from './share-route.ts';
import { serverTransports } from './server-transports.ts';
import {
  type RequestLimits,
  type ControlLimits,
  type ServerOptions,
  readFailure,
  type ServerSocket,
  type AgentLink,
  auditSafely,
  registeredWorkspace,
  AUDIT_FIELD_CHARS,
  send,
  type Replayable,
  trackers,
  INPUT_METHODS,
  type ConnectionContext,
} from './handlers/context.ts';
import { DETAILS_TIMEOUT_MS, authenticateDesktop, desktopMethod } from './handlers/desktop.ts';
import { markSavedStopped, parseShareStart, shareMethod } from './handlers/share.ts';
import { LOCAL_DEVICE_ID, CLOSE_BAD_REQUEST, hello } from './handlers/hello.ts';
import { parseReplay, subscribeFrames } from './handlers/frames.ts';
import {
  subscribeWorkspaces,
  subscribeWorkspace,
  subscribeMachine,
  readBuildsHistory,
  listArchived,
  statusRead,
} from './handlers/status.ts';
import { publishPresence, recordPresence } from './handlers/presence.ts';
import { hostedMethod } from './handlers/device-host.ts';
import { machineMethod, planBuild } from './handlers/build.ts';
import { subscribeLogs, queryLogs } from './handlers/logs.ts';
import { replayRange, archiveDetail, replayKeyframe, setRecording } from './handlers/replay.ts';
import { workspaceChanges, workspaceCommand } from './handlers/workspace.ts';
import { runAction } from './handlers/lifecycle.ts';
import { beginControl, input } from './handlers/control.ts';
import { registerPush } from './handlers/push.ts';
export type { ServerOptions } from './handlers/context.ts';

const SHARE_SERVER_GRACE_MS = 2 * 60_000;

interface ServerHealth {
  host?: HelloHost['app'];
  startup: StartupState;
  server: 'stim-server';
  name: string;
  version: string;
  stim: string;
  /** The digest of the `stim` build this server runs, which offload compares between machines. */
  stimBuild: string | null;
  protocol: number;
  stimHome: string;
  /**
   * The work a restart would cut off: offloaded builds and hosted sessions running now. `hostedWork` counts the hosted
   * sessions a restart would stop, because a native step is in flight or they cannot be resumed; the others are left
   * running for the next server, which `resumes` says this one does.
   */
  busy: { builds: number; hostedSessions: number; hostedWork: number; resumes: true };
  tailscale: { state: TailscaleState['state']; dnsName?: string | null; backendState?: string; reason?: string };
  route?: ServeRoute;
  nativeViewerOpened: boolean;
  /** Present and true when the server serves this machine only, so a paired phone or another machine cannot connect. */
  loopbackOnly?: true;
  /** The local network addresses the server listens on now, from `server.lanAddresses`; absent when there are none. */
  lan?: { addresses: string[]; port: number };
  keepAwake: KeepAwakeStatus;
  /** The last measurement of `server.workerRoot`; null before the first, and on Windows. */
  workerRoot: WorkerRootUsage | null;
}

function healthTailscale(tailscale: TailscaleState): ServerHealth['tailscale'] {
  if (tailscale.state === 'running') return { state: 'running', dnsName: tailscale.dnsName };
  if (tailscale.state === 'not-running') return { state: 'not-running', backendState: tailscale.backendState };
  return { state: 'unavailable', reason: tailscale.reason };
}

/** Only a request made to this machine's loopback name, so a DNS-rebound web page cannot read the health payload. */
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
  /**
   * Serves one connection from this machine's own user, such as Stim Desktop, without Noise: stimd hands over the
   * connections its CLI socket admits, where the kernel's check on the 0600 socket stands in for a peer uid.
   */
  acceptLocal: (stream: Duplex) => void;
  /** Shows one agent action's presence, as `presence.publish` from a local client does. */
  publishPresence: (params: unknown) => string | null;
  /** Settles once the first read of the Stim home finished: `ready`, or `degraded` while a read does not return. */
  ready: Promise<StartupState>;
  close: () => Promise<void>;
}

const CLOSE_AUTH_TIMEOUT = 4408;

const AGENT_PATH = /^\/device-host\/agent\/([a-f0-9-]{36})(?:[/?]|$)/;

const METRO_END_MS = 30_000;
const MAX_PAYLOAD = 64 * 1024;

const MAX_SUBSCRIPTIONS = 32;

const STATUS_READ_WAIT_MS = 30_000;

const REQUEST_LIMITS: RequestLimits = { connection: 32, device: 16 };
const MAX_REPORT_WAITS = 16;

function isWorkspaceChangeMethod(method: string): method is 'workspace.files' | 'workspace.diff' {
  return method === 'workspace.files' || method === 'workspace.diff';
}

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

const HEALTH_ROUTE_TIMEOUT_MS = 1000;
const LISTEN_RETRY_MS = 5000;
const COMMAND_LIMITS: CommandLimits = { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 };

const ACTION_LIMITS: CommandLimits = { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 };

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * The tailnet address of the peer. `tailscale serve` proxies from loopback and names the peer in
 * X-Forwarded-For; a loopback connection without that header comes from this machine.
 */
function peerAddress(request: IncomingMessage): string | null {
  const remote = request.socket.remoteAddress;
  if (!isLoopback(remote)) return remote ?? null;
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || null;
}

function peerLabel(identity: TransportIdentity | null): string | null {
  return identity ? `${identity.name || identity.id}${identity.user ? ` (${identity.user})` : ''}` : null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * How a connection reached the server: from this machine on loopback, from a tailnet peer through `tailscale serve`
 * (loopback with `X-Forwarded-For`), or straight to one of the server's own network addresses.
 */
type Arrival = 'local' | 'proxied' | 'direct';

function arrival(request: IncomingMessage): Arrival {
  if (!isLoopback(request.socket.remoteAddress)) return 'direct';
  return peerAddress(request) === null ? 'local' : 'proxied';
}

/**
 * Whether a WebSocket upgrade comes from a web page. Browsers send `Sec-Fetch-Site` and the page's own `Origin`.
 * React Native derives `Origin` from the ws URL, so an app's `Origin` names the requested host: over `http:` on loopback
 * and on a local network address, and `https:` through `tailscale serve`. A DNS-rebound page names a host name, so on
 * loopback the host must be a loopback name and on a network address an IP literal. SocketRocket omits the brackets of
 * an IPv6 origin, so an iOS app on `ws://[::1]` is refused.
 */
export function upgradeFromWebPage(headers: IncomingHttpHeaders, via: Arrival): boolean {
  if (headers['sec-fetch-site'] !== undefined) return true;
  if (headers.origin === undefined) return false;
  const scheme = via === 'proxied' ? 'https:' : 'http:';
  try {
    const own = new URL(`${scheme}//${headers.host ?? ''}`);
    if (new URL(headers.origin).origin !== own.origin) return true;
    if (via === 'local') return !LOOPBACK_HOSTS.has(own.hostname);
    return via === 'direct' && isIP(own.hostname.replace(/^\[|\]$/g, '')) === 0;
  } catch {
    return true;
  }
}

const MAX_PENDING_CONNECTIONS = 64;
const MAX_PENDING_PER_PEER = 16;
/** First contacts naming a secret this server does not hold, per address and minute, before it turns the address away. */
const MAX_UNKNOWN_SECRETS = 60;
const HEADERS_TIMEOUT_MS = 10_000;

/** How many peers a failure limiter remembers; past it, the peer seen longest ago is forgotten first. */
const MAX_LIMITED_PEERS = 4096;

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
    const kept = this.recent(key, now);
    this.failures.delete(key);
    const oldest = this.failures.keys().next();
    if (this.failures.size >= MAX_LIMITED_PEERS && !oldest.done) this.failures.delete(oldest.value);
    this.failures.set(key, [...kept, now]);
  }
}

/**
 * Connections to one network listener that have not authenticated yet, bounded overall and per source address, so a
 * peer cannot hold the server's sockets open without a key, and a flood on one listener leaves the others alone.
 * Loopback connections, which include every `tailscale serve` peer, are not counted.
 */
class PendingConnections {
  private readonly peers = new Map<Socket, string>();
  private readonly counts = new Map<string, number>();
  private readonly max: number;
  private readonly perPeer: number;

  constructor(max: number, perPeer: number) {
    this.max = max;
    this.perPeer = perPeer;
  }

  admit(socket: Socket): boolean {
    const peer = socket.remoteAddress ?? '';
    const count = this.counts.get(peer) ?? 0;
    if (this.peers.size >= this.max || count >= this.perPeer) return false;
    this.peers.set(socket, peer);
    this.counts.set(peer, count + 1);
    socket.once('close', () => this.settle(socket));
    return true;
  }

  /** The socket authenticated, or closed: it no longer counts. */
  settle(socket: Socket): void {
    const peer = this.peers.get(socket);
    if (peer === undefined) return;
    this.peers.delete(socket);
    const left = (this.counts.get(peer) ?? 1) - 1;
    if (left > 0) this.counts.set(peer, left);
    else this.counts.delete(peer);
  }
}

function requestId(value: unknown): RequestId | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

/** The share hub's recording grace from the control lease's `stim device lock --for` duration, such as `2m`. */
function leaseGrace(leaseFor: string): { leaseGraceMs?: number } {
  const [, amount, unit] = /^(\d+)(s|m|h)$/.exec(leaseFor) ?? [];
  if (amount === undefined || unit === undefined) return {};
  return { leaseGraceMs: Number(amount) * (unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000) };
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

function pruneSetup(): void {
  try {
    pruneSetupJournals();
  } catch (error) {
    console.error(`stim-server: could not prune setup journals: ${(error as Error).message}`);
  }
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { transports, tailnet } = await serverTransports(options);
  const givenName = options.name;
  let resolvedName = typeof givenName === 'string' ? givenName : null;
  const serverName = async () => (resolvedName ??= typeof givenName === 'string' ? givenName : await givenName());
  /**
   * A peer that `tailscale serve` forwarded to loopback comes over the tailnet, so it needs the Tailscale transport for
   * this run. A loopback-only server serves no tailnet peer and never loads it.
   */
  const forwardedPeer = async (request: IncomingMessage) => {
    if (!options.loopbackOnly && isLoopback(request.socket.remoteAddress)) await tailnet.load('forwarded peer');
  };
  /** The addresses each transport that binds some reports now: read when watching starts, then replaced by its `watch` events. */
  const bindings = new Map<Transport, string[]>();
  /** The tailnet node a transport reports for a peer, or null when none identifies it. */
  const peerNode = cachedPeerNode(async (request: IncomingMessage, address: string): Promise<string | null> => {
    await forwardedPeer(request);
    for (const transport of transports) {
      const identity = await transport.identify?.({ address, headers: request.headers }).catch(() => null);
      if (identity) return identity.id;
    }
    console.error(`stim-server: no transport identified the peer ${address}.`);
    return null;
  });
  /**
   * The tailnet node each device-host client's latest authenticated connection came from. Its agent grant's bearer
   * token goes to a host name the client resolves, so the agent route also requires this node: a node that took the
   * name over cannot replay the token. It adds to the token; it never authenticates on its own.
   */
  const agentNodes = new Map<string, string>();
  /** Names a peer for people to read; never decides who a client is. */
  async function describePeer(request: IncomingMessage, address: string): Promise<string> {
    await forwardedPeer(request);
    for (const transport of transports) {
      const label = peerLabel(
        (await transport.identify?.({ address, headers: request.headers }).catch(() => null)) ?? null,
      );
      if (label) return label;
    }
    return address;
  }
  let homeId: string | undefined;
  let hostProbe: Promise<HelloHost['app']> | undefined;
  let hostExpires = 0;
  const hostHealth = (): Promise<HelloHost['app'] | undefined> => {
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
  const requestLog = options.requestLog ?? createRequestLog();
  const limiter = new FailureLimiter(options.maxAuthFailures ?? 5, options.failureWindowMs ?? 60_000);
  const authTimeoutMs = options.authTimeoutMs ?? 5000;
  const unknownSecrets = new FailureLimiter(
    options.maxUnknownSecrets ?? MAX_UNKNOWN_SECRETS,
    options.failureWindowMs ?? 60_000,
  );
  const pendingPools = new WeakMap<Socket, PendingConnections>();
  const feeds = new FeedPool(options.stimCli, options.env);
  const statusFeed = new StatusFeed({
    worker: join(dirname(options.stimCli), 'status-worker.mjs'),
    env: options.env,
    cwd: homedir(),
  });
  const statusViewsCache = new WeakMap<JsonObject, StatusViews>();
  const viewsOf = (payload: JsonObject): StatusViews => {
    let views = statusViewsCache.get(payload);
    if (!views) {
      views = statusViews(payload as unknown as StatusPayload);
      statusViewsCache.set(payload, views);
    }
    return views;
  };
  const currentStatus = (): Promise<{ payload: StatusPayload } | { failed: string }> =>
    new Promise((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (answer: { payload: StatusPayload } | { failed: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe?.();
        resolve(answer);
      };
      const timer = setTimeout(() => finish({ failed: 'stim status did not report in time.' }), STATUS_READ_WAIT_MS);
      unsubscribe = statusFeed.subscribe({
        item: (payload) => finish({ payload: payload as unknown as StatusPayload }),
        failed: (message) => finish({ failed: message }),
      });
      if (done) unsubscribe();
    });
  const hostsDevices = options.hostsDevices ?? process.platform === 'darwin';
  const frameLimits: FrameLimits = { ...DEFAULT_FRAME_LIMITS, ...options.frameLimits };
  let helperPath = options.frameHelper ?? null;
  let helperBuilding = false;
  let helperRetryAt = 0;
  const helperAbort = new AbortController();
  const buildHelper = () => {
    if (!hostsDevices) return;
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
      if (helperPath) frames.helperReady();
    })();
  };
  const frameHelper = () => {
    if (options.frameHelper === undefined && !helperPath && !helperBuilding && Date.now() >= helperRetryAt) {
      buildHelper();
    }
    return helperPath;
  };
  let foldBuild: Promise<string> | null = null;
  const foldHelper = () => {
    if (options.foldHelper !== undefined) return Promise.resolve(options.foldHelper);
    foldBuild ??= buildFoldHelper(options.env, helperAbort.signal).catch((cause: Error) => {
      foldBuild = null;
      throw new Error(`sim-fold could not be built: ${cause.message}`);
    });
    return foldBuild;
  };
  let nativeViewerOpened = false;
  const helperEnv = options.host ? { ...options.env, STIM_CAPTURE_HOST: options.host.name } : options.env;
  const viewers = new DeviceViewers();
  const frames = new FramePool(helperEnv, frameLimits, frameHelper, viewers, undefined, foldHelper);
  let recorder: Recorder | null = null;
  let startup: StartupState = { state: 'pending' };
  let approvals: Registries | null = null;
  let homeLost = false;
  const readApprovals = (): Registries | null => {
    try {
      approvals = readRegistries();
      return approvals;
    } catch (error) {
      if (!(error instanceof RegistryUnavailable)) throw error;
      if (startup.state === 'ready') {
        homeLost = true;
        startup = { state: 'degraded', reason: error.message, cause: 'home-unreadable' };
        console.error(`stim-server: listening, but not serving clients until the Stim home answers. ${error.message}`);
      }
      return null;
    }
  };
  const approved = (): Registries => readApprovals() ?? approvals ?? { devices: [], build: [], deviceHost: [] };
  const buildAllowed = (session: Pick<PairedDevice, 'id'>) =>
    approved().build.some((entry) => entry.id === session.id && entry.capabilities.includes('build'));
  let startupProbe: ReturnType<typeof probeDirectories> | null = null;
  const startupAbort = new AbortController();
  let homeCheck: Promise<void> | undefined;
  let startupRetry: NodeJS.Timeout | null = null;
  let setupPruneTimer: NodeJS.Timeout | null = null;
  let shareServerGrace: NodeJS.Timeout | null = null;
  const running = new Set<() => Promise<void>>();
  const peerCommands = new Map<string, number>();
  const requestLimits: RequestLimits = { ...REQUEST_LIMITS, ...options.requestLimits };
  const cancelling = new Pending();
  const logLimits: LogLimits = { ...LOG_LIMITS, ...options.logLimits };
  const commandLimits: CommandLimits = { ...COMMAND_LIMITS, ...options.commandLimits };
  const actionLimits: CommandLimits = { ...ACTION_LIMITS, ...options.actionLimits };
  const busyWorkspaces = new Set<string>();
  const retainedLifecycles = new Set<() => void>();
  const planQueues = new Map<string, Promise<void>>();
  const readDetailsReport = (
    method: 'stats' | 'gc' | 'doctor' | 'gc-history' | 'builds' | 'remote',
    cwd = homedir(),
    platform?: 'ios' | 'android',
    signal?: AbortSignal,
  ): Promise<DetailsRead> => {
    const abort = new AbortController();
    if (signal?.aborted) abort.abort();
    else signal?.addEventListener('abort', () => abort.abort(), { once: true });
    const timeoutMs = options.commandLimits?.timeoutMs ?? DETAILS_TIMEOUT_MS;
    let task: Promise<DetailsRead>;
    const cancel = async () => {
      abort.abort();
      await task;
    };
    const deadline = setTimeout(() => abort.abort(), timeoutMs);
    task = Promise.resolve()
      .then(async () => {
        const stim = createStim({ projectRoot: cwd, env: options.env, admission: 'none' });
        if (method === 'gc-history' || method === 'builds')
          return {
            records: queryMachineLogs({
              records: method === 'builds' ? readBuildLedger() : readGcLog().filter(isGcLogRecord),
              sources: [method === 'builds' ? 'builds' : 'gc'],
              tail: method === 'builds' ? 500 : 2000,
            }),
          };
        if (method === 'doctor') return await stim.doctor({ signal: abort.signal, platform });
        if (method === 'remote') return await stim.remoteMachines({ signal: abort.signal });
        return method === 'gc'
          ? await stim.gc({ signal: abort.signal, measureBuildState: false })
          : await stim.stats({ signal: abort.signal });
      })
      .then(
        (report): DetailsRead => {
          if (method !== 'stats' && Buffer.byteLength(JSON.stringify(report)) > commandLimits.maxOutputBytes)
            return { ok: false, message: `stim ${method} printed more than ${commandLimits.maxOutputBytes} bytes.` };
          return { ok: true, report: { ...report } };
        },
        (cause: unknown): DetailsRead => ({
          ok: false,
          message:
            abort.signal.aborted && !(cause instanceof StimError && cause.code === 'STIM_CLAIM_UNAVAILABLE')
              ? `stim ${method} did not finish within ${timeoutMs / 1000} s.`
              : readFailure(cause),
        }),
      )
      .finally(() => {
        clearTimeout(deadline);
        running.delete(cancel);
      });
    running.add(cancel);
    return task;
  };
  const desktopReports = new DesktopReports((target, signal) =>
    readDetailsReport(
      target.report,
      target.report === 'doctor' ? target.cwd : undefined,
      target.report === 'doctor' ? target.platform : undefined,
      signal,
    ),
  );
  const machineDetails = new MachineDetailsCache(() =>
    loadMachineDetails(
      () => readDetailsReport('gc'),
      loadAudit,
      () => readDetailsReport('stats'),
    ),
  );
  const buildMachines = new BuildMachinesCache();
  let recordingTurn: Promise<void> = Promise.resolve();
  let closing = false;
  const sessions = new Map<ServerSocket, PairedDevice>();
  const listeners = new Set<ServerSocket>();
  const sampler = new UsageSampler();
  const usage = new UsageRecorder();
  let recorders = 0;
  let stopRecording: (() => void) | null = null;
  const recordUsage = (): (() => void) => {
    recorders += 1;
    stopRecording ??= statusFeed.subscribe({
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
      usage.pause();
    };
  };
  const controllers = new Map<ServerSocket, Controller>();
  const controlLimits: ControlLimits = { ...CONTROL_LIMITS, ...options.controlLimits };
  const adbEmulators = options.env[ADB_EMULATORS_SWITCH] === '1';
  const hostedPresence = new HostedPresence();
  const agentDrivers = new HostedAgentHost({
    resolve: () => configuredAgentDriver(loadConfig()?.hosting?.agentDriver, options.env, serverDir()),
    resolveDevice: (app, stopping) =>
      (stopping ? stoppingAgentDriver : configuredAgentDriver)(
        loadConfig()?.hosting?.agentDriver,
        options.env,
        deviceHostArea(app.session),
        app,
      ),
    approved: (client, from) =>
      ('client' in from ? from.client === client : from.node !== null && agentNodes.get(client) === from.node) &&
      approved().deviceHost.some((entry) => entry.id === client && entry.capabilities.includes('device-host')),
    tokenFor: (session) =>
      Buffer.from(hkdfSync('sha256', serverIdentity().privateKey, session, 'stim hosted agent token v1', 32)).toString(
        'base64url',
      ),
    withdrawn: (session) => {
      hostedPresence.forget(session);
      for (const stream of agentStreams.get(session) ?? []) stream.destroy();
    },
  });
  const hostedDevices = new DeviceHost({
    worker: join(dirname(options.stimCli), 'device-host-worker.mjs'),
    env: options.env,
    agents: agentDrivers,
    limits: options.deviceHostLimits,
    allowed: (client) =>
      approved().deviceHost.some((entry) => entry.id === client && entry.capabilities.includes('device-host')),
    connected: (client) => [...sessions.values()].some((entry) => entry.id === client),
    builtBundle: (client, handoff, sha256) => {
      const host = approved().deviceHost.find(
        (entry) => entry.id === client && entry.capabilities.includes('device-host'),
      )?.publicKey;
      return builds.takeBundle(handoff, sha256, (builder) => {
        const build = approved().build.find(
          (entry) => entry.id === builder && entry.capabilities.includes('build'),
        )?.publicKey;
        return host !== undefined && host === build;
      });
    },
  });
  const agentLimiter = new FailureLimiter(30, options.failureWindowMs ?? 60_000);
  const agentLinks = new WeakMap<object, AgentLink>();
  const agentStreams = new Map<string, Set<Duplex>>();
  async function answerAgent(
    request: IncomingMessage,
    response: ServerResponse,
    session: string,
    link?: AgentLink,
  ): Promise<void> {
    const peer = link ? `client:${link.client}:${link.session}` : (peerAddress(request) ?? 'local');
    const refuse = (status: number, text: string) =>
      void response.writeHead(status, { 'content-type': 'text/plain' }).end(`${text}\n`);
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined)
      return refuse(403, 'Forbidden.');
    if (agentLimiter.blocked(peer)) return refuse(429, 'Too many attempts. Try again in a minute.');
    if (link && link.session !== session) {
      agentLimiter.record(peer);
      return refuse(403, 'Forbidden. This agent link carries another hosted session.');
    }
    const bearer = /^bearer (.+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const header = request.headers['x-agent-device-token'];
    const token = bearer ?? (typeof header === 'string' ? header : null);
    const from = link ? { client: link.client } : { node: peer === 'local' ? null : await peerNode(request, peer) };
    if (request.method === 'POST') hostedPresence.watch(session, response);
    const verdict = agentDrivers.forward(session, token, request, response, from);
    if (verdict === 'forbidden') agentLimiter.record(peer);
    else if (verdict === 'ok') hostedDevices.clientActed(session);
  }
  const agentHttp = createServer((request, response) => {
    const link = agentLinks.get(request.socket);
    const session = AGENT_PATH.exec(request.url ?? '')?.[1];
    if (!link || !session) return void response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found.\n');
    link.busy++;
    response.once('close', () => link.busy--);
    answerAgent(request, response, session, link).catch(() => {
      if (response.headersSent) response.destroy();
      else response.writeHead(500, { 'content-type': 'text/plain' }).end('Agent control failed.\n');
    });
  });
  const setupLimiter = new FailureLimiter(30, options.failureWindowMs ?? 60_000);
  /** The journal holds no secret, so it is served to whoever names it; failures are rate limited by peer. */
  function answerSetup(request: IncomingMessage, response: ServerResponse): void {
    const refuse = (status = 404, text = 'Not found.') =>
      void response.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(`${text}\n`);
    const peer = peerAddress(request) ?? 'local';
    const match = /^\/setup\/([a-f0-9]{64})$/.exec(request.url ?? '');
    if (
      request.method !== 'GET' ||
      !match ||
      match[0] !== request.url ||
      request.headers.origin !== undefined ||
      request.headers['sec-fetch-site'] !== undefined
    )
      return refuse();
    if (startup.state !== 'ready') return refuse(503, 'stim-server is not ready.');
    if (setupLimiter.blocked(peer)) return refuse(429, 'Too many attempts. Try again in a minute.');
    const journal = readSetupJournal(match[1]!);
    if (!journal || isJournalExpired(journal)) {
      setupLimiter.record(peer);
      return refuse();
    }
    response
      .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(setupJournalForClient(journal)));
  }
  const builds: BuildWorkerRoot = new BuildWorkerRoot({
    limits: options.buildLimits,
    ready: () => startup.state === 'ready',
    allowed: (client) => buildAllowed({ id: client }),
    jobs: () => jobs.live(),
    stopJobs: (client) => jobs.stop(client),
  });
  const jobs: OffloadJobs = new OffloadJobs({
    stimCli: options.stimCli,
    get machine() {
      return resolvedName ?? 'this machine';
    },
    attached: options.attached,
    env: () => options.currentEnv?.() ?? options.env,
    limits: builds.limits,
    admit: (client) => {
      builds.maintainAreas();
      if (!buildAllowed({ id: client })) return 'This machine no longer grants this device build access.';
      return builds.drained ?? (builds.removing(client) ? 'This machine is removing this build client.' : null);
    },
    idle: (client) => builds.pruneBlobs(client),
  });
  const presence = new PresenceHub();
  const localAgents = new LocalAgentPresence({
    hub: presence,
    follow: (workspace, onRecord, signal) =>
      createStim({ projectRoot: workspace, env: options.env, admission: 'none' }).followLogs(
        { sources: ['agent'], tail: 0, signal },
        onRecord,
      ),
    screen: (platform, device) =>
      platform === 'ios' ? simulatorScreen(device, options.env) : androidScreen(device, options.env),
  });
  const control = new ControlHub({
    env: options.env,
    stimCli: options.stimCli,
    frames,
    subscribeStatus: (listener) => statusFeed.subscribe(listener),
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
    onInput: (device) => viewers.input(device),
    presence,
  });
  const hostedViews = new HostedViews(hostedDevices, control, helperEnv, frameHelper);
  const funnelTool = tailscaleFunnel(
    () => tailnet.binary(),
    options.env,
    () => tailnet.rawStatus(),
  );
  const funnel = {
    ...funnelTool,
    add: async (route: Parameters<typeof funnelTool.add>[0]) => {
      await funnelTool.add(route);
      if (!options.loopbackOnly) void tailnet.load('funnel share');
    },
  };
  const shareRoute = new ShareRoute(shareRouteClaimRoot(), funnel);
  const exposedRoute = new ExposedRoute(
    shareRoute,
    () => {
      const share = loadConfig()?.share;
      return { exposure: share?.exposure, publicUrl: share?.publicUrl, port: share?.port };
    },
    async () => tailscaleLoggedIn(await tailnet.rawStatus()),
    async () => tailscaleHost(await tailnet.rawStatus()),
  );
  const shares = new ShareHub({
    frames,
    control,
    presence: {
      subscribe: (key, listener) => localAgents.subscribe(key, listener),
      join: (key, who) => presence.join(key, who),
      leave: (key, id) => presence.leave(key, id),
    },
    subscribeStatus: (listener) =>
      statusFeed.subscribe({
        item: (payload) => listener.item(payload as unknown as StatusPayload),
        failed: listener.failed,
      }),
    route: exposedRoute,
    hosted: (host, request) =>
      new HostedShareSource(hostConnections, host, request, auditSafely, {
        hub: presence,
        key: presenceKey(request.workspace, request.platform, request.slot ?? 'default', false),
        follow: (key) => hostedBridge.follow(key, host),
      }),
    lookup: { adbEmulators },
    limits: leaseGrace(controlLimits.leaseFor),
    recordingChanged: () => recorder?.refresh(),
    gaveUp: async (request, link) => {
      const unsaved = await markSavedStopped(() =>
        pauseShareLinkAsync(request.workspace, shareLinkKey(request), (saved) => savedLinkIs(saved, link)),
      );
      if (unsaved !== null) {
        console.error(
          `stim-server: the web share of ${request.workspace} ended, but its saved link could not be marked stopped (${unsaved}), so a restart can start it again`,
        );
      }
    },
    holdWorkspace: (workspace, stop) => holdNativeRun(workspace, { waitMs: SHARE_CLAIM_WAIT_MS, stop }),
    ...(options.shareServer ? { idle: options.shareServer.idle } : {}),
  });
  const restoreShares = () =>
    restoreSavedShares({
      start: async (params) => {
        const parsed = parseShareStart(params);
        if (typeof parsed === 'string') return { code: 'bad-request', message: parsed };
        const resolved = registeredWorkspace(parsed.workspace);
        if ('code' in resolved) return { code: 'bad-request', message: resolved.message };
        const started = await shares.start({ ...parsed, workspace: resolved.dir }, { restore: true });
        return 'code' in started ? started : { started: true, id: started.id };
      },
      refused: async ({ share }) => {
        try {
          return await exposedRoute.admits(share.origin, shares.port !== null);
        } catch (cause) {
          return { why: cause instanceof Error ? cause.message : String(cause), retry: false };
        }
      },
      leave: async ({ workspace, key, share }) => {
        const secret = share.token ?? share.slug ?? '';
        const unsaved = await markSavedStopped(() =>
          pauseShareLinkAsync(workspace, key, (saved) => savedLinkIs(saved, digest(secret).toString('hex'))),
        );
        if (unsaved !== null) {
          console.error(`stim-server: could not mark the saved web share of ${workspace} stopped: ${unsaved}`);
        }
      },
      wanted: ({ workspace, key, share }) => {
        const saved = readShareLinks(workspace)[key];
        return (
          saved?.state === 'live' &&
          saved.token === share.token &&
          saved.slug === share.slug &&
          saved.expiresAt === share.expiresAt
        );
      },
      end: async ({ workspace }, shareId) => {
        await shares.stopOne(workspace, shareId);
      },
      wait: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref();
        }),
      closed: () => closing,
      log: (line) => console.error(`stim-server: ${line}`),
    }).catch((cause: unknown) =>
      console.error(`stim-server: could not restore the saved web shares: ${String(cause)}`),
    );
  const ownStimBuild = stimBuildDigest(dirname(options.stimCli));
  const machineUpdates = new MachineUpdates({
    version: options.serverVersion,
    stimDir: dirname(dirname(options.stimCli)),
    status: () => tailnet.rawStatus(),
    endpoint: options.hostedRelay?.endpoint,
  });
  const updates = new EngineUpdates({
    get name() {
      return resolvedName ?? undefined;
    },
    label: options.service?.label ?? null,
    port: options.port,
    build: { version: options.serverVersion, stimBuild: ownStimBuild },
    node: options.service?.node ?? process.execPath,
    script: options.service?.script ?? '',
    env: process.env,
    runsAsService: options.service?.runsAsService,
    ...(options.service?.detached ? { detached: options.service.detached } : {}),
    acceptsClientBuilds: () => loadConfig()?.server?.acceptClientBuilds === true,
    drain: (reason) => {
      builds.drain(reason);
      hostedDevices.drain(reason);
    },
    audit: ({ by, target, phase, ok, message }) =>
      auditSafely({
        at: new Date().toISOString(),
        device: by,
        action: `engine.update.${phase}`,
        workspace: target,
        ok,
        ...(ok ? {} : { error: { code: 'action-failed', message: message.slice(0, AUDIT_FIELD_CHARS) } }),
      }),
  });
  let serverKey: ReturnType<typeof serverIdentity> | null = null;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(MAX_FIRST_MESSAGE_BYTES, MAX_CLIENT_MESSAGE_BYTES + TRANSPORT_OVERHEAD_BYTES),
  });
  const localWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const notificationLog = new NotificationLog(notificationLogFile(serverDir()));
  const push = new PushNotifier({
    name: serverName,
    endpoint: options.pushEndpoint ?? EXPO_PUSH_API,
    subscribeStatus: (listener) => statusFeed.subscribe(listener),
    readVolumes: readDiskVolumes,
    readPressure: readMemoryPressure,
    pullRequests: options.pullRequests ?? ((worktrees) => worktreePullRequests()(worktrees)),
    ownLeases: () => control.ownLeaseTimes(),
    devices: () => approved().devices,
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

  const relays = new Map<ServerSocket, HostedRelay>();
  /** Local-socket connections that proved the private bootstrap key of the bundled Desktop that started this server. */
  const desktopSessions = new Set<ServerSocket>();
  const hostConnections = new HostConnections(
    {
      ...(options.hostedRelay ?? { status: () => tailnet.rawStatus() }),
      log: requestLog.host,
    },
    options.serverVersion,
  );
  const hostedBridge = new HostedPresenceBridge(hostConnections, presence);
  let revocationCheck: NodeJS.Timeout | null = null;
  let checkedRegistry: string | null = null;
  const checkRevocations = () => {
    const registries = readApprovals();
    if (!registries) {
      if (homeLost) {
        watcher?.close();
        watcher = null;
      }
      return;
    }
    if (homeLost && startup.state === 'degraded') {
      homeLost = false;
      startup = { state: 'ready' };
      watchServerDir();
      console.error('stim-server: the Stim home answers again; serving clients.');
    }
    const devices = [...registries.devices, ...registries.build, ...registries.deviceHost];
    const registry = JSON.stringify(devices);
    if (registry === checkedRegistry) return;
    checkedRegistry = registry;
    const paired = new Map(devices.map((device) => [device.id, device]));
    push.refresh();
    for (const [socket, device] of sessions) {
      if (device.id !== LOCAL_DEVICE_ID && !paired.has(device.id)) socket.close(CLOSE_REFUSED, 'unauthorized');
    }
    hostedDevices.revoke();
    for (const { client } of jobs.live())
      if (!paired.get(client)?.capabilities.includes('build')) void jobs.stop(client);
    builds.abandonDetached(
      (client) => paired.get(client)?.capabilities.includes('build') ?? false,
      buildClientsReadable(),
    );
    void builds.sweepDaemons();
    for (const [socket, controller] of controllers) {
      if (controller.device.id === LOCAL_DEVICE_ID) continue;
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
  let hostedIdleSweep: NodeJS.Timeout | null = null;
  let retireOnce: Promise<void> | undefined;
  let restoredShares: Promise<void> | undefined;
  const watchServerDir = () => {
    if (watcher) return;
    let created: FSWatcher;
    try {
      created = watch(serverDir(), () => {
        revocationCheck ??= setTimeout(() => {
          revocationCheck = null;
          checkRevocations();
        }, 50);
      });
    } catch {
      return;
    }
    created.once('error', () => {
      created.close();
      if (watcher === created) watcher = null;
    });
    watcher = created;
  };
  const becomeReady = () => {
    mkdirSync(serverDir(), { recursive: true, mode: 0o700 });
    watchServerDir();
    // Node's macOS watcher can miss changes before it is ready: https://github.com/nodejs/node/issues/52601.
    revocationPoll ??= setInterval(checkRevocations, 1000).unref();
    hostedIdleSweep ??= setInterval(() => {
      hostedDevices.sweepIdle();
      void hostedDevices.reclaimEndedHomes();
    }, options.hostedIdleSweepMs ?? HOSTED_IDLE_SWEEP_MS).unref();
    push.refresh();
    restoredShares ??= restoreShares();
    retireOnce ??= Promise.resolve()
      .then(() => recoverAgentDrivers(options.env, deviceHostAreas()))
      .then(() => hostedDevices.resumeSessions())
      .then(() => hostedDevices.reconcileStopped())
      .catch((error: unknown) => {
        process.stderr.write(`Hosted device retirement failed: ${(error as Error).message}\n`);
      });
    if (options.frameHelper === undefined && !helperPath && !helperBuilding) buildHelper();
    if (options.statusAtBoot !== false) statusFeed.hold();
    if (options.record !== false) {
      recorder ??= new Recorder({
        frames,
        subscribeStatus: (listener) => statusFeed.subscribe(listener),
        limits: options.recordLimits,
        unrecordedTargets: () => shares.unrecordedTargets(),
      });
    }
  };

  let settingUpRoute: Promise<ServeRoute> | null = null;

  /**
   * One client connection. `local` is the Unix socket, where the kernel admits only this server's own user; every
   * other connection authenticated with Noise as `clientKey`, whose records `hello` reads again so a revocation that
   * lands after the handshake still counts.
   */
  function connection(socket: ServerSocket, peer: string | null, local: boolean, clientKey: string | null): void {
    const limitKey = peer ?? 'local';
    const keyless = local && options.desktopBootstrap === undefined;
    const subscriptions = new Map<string, () => void | Promise<void | ProtocolError>>();
    const setupRuns = new Map<string, DesktopSetup>();
    const keyframes = new Map<string, () => void>();
    const congestion = new Map<string, () => void>();
    const replays = new Map<string, Replayable>();
    let keyframeReads = 0;
    const commands = new Set<() => Promise<void>>();
    const reportWaits = new Set<() => Promise<void>>();
    const holdSlot = (cancel: () => Promise<void>) => {
      commands.add(cancel);
      if (peer !== null) peerCommands.set(peer, (peerCommands.get(peer) ?? 0) + 1);
    };
    const releaseSlot = (cancel: () => Promise<void>) => {
      if (!commands.delete(cancel) || peer === null) return;
      const left = (peerCommands.get(peer) ?? 1) - 1;
      if (left > 0) peerCommands.set(peer, left);
      else peerCommands.delete(peer);
    };
    const slotsFull = (needed = 1) =>
      commands.size + needed > requestLimits.connection ||
      (peer !== null && (peerCommands.get(peer) ?? 0) + needed > requestLimits.device);
    const slotsMessage = (needed = 1) =>
      peer !== null && commands.size + needed <= requestLimits.connection
        ? `A remote device can run ${requestLimits.device} requests at a time.`
        : `A connection can run ${requestLimits.connection} requests at a time.`;
    const planRequests = new Map<
      string,
      { cancel: () => Promise<void>; refusal: () => DesktopPlanRefusal | undefined }
    >();
    const persistentActions = new Set<() => Promise<void>>();
    let nextSubscription = 1;
    let device: PairedDevice | null = null;
    let desktopChallenge: { nonce: string; proof: string } | null = null;
    const tracker = requestLog.track();
    trackers.set(socket, tracker);
    let runId: string | null = null;
    let metroLink: MetroLink | null = null;
    let metroStream: Duplex | null = null;
    let metroPing: NodeJS.Timeout | undefined;
    let clientPing: NodeJS.Timeout | undefined;
    let queue = Promise.resolve();
    let archiveReads = Promise.resolve();
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
      presence,
    );
    relays.set(socket, relay);

    const refuse = (id: RequestId | null, code: ErrorCode, message: string, closeCode: number) => {
      if (!device && code !== 'home-unavailable' && code !== 'protocol-unsupported') limiter.record(limitKey);
      send(socket, { id, error: { code, message } });
      socket.close(closeCode, code);
    };
    const timer = setTimeout(() => {
      limiter.record(limitKey);
      socket.close(CLOSE_AUTH_TIMEOUT, 'authentication timeout');
    }, authTimeoutMs);

    function error(id: RequestId, code: ErrorCode, message: string): void {
      send(socket, { id, error: { code, message } });
    }

    /** Control is re-read from the record each time, so a revoked grant stops at once; the local socket always has it. */
    const canControl = (session: Pick<PairedDevice, 'id'>) =>
      local || approved().devices.some((entry) => entry.id === session.id && entry.capabilities.includes('control'));

    const inputs = { tokens: controlLimits.inputPerSecond, at: Date.now() };
    const characters = { tokens: MAX_INPUT_TEXT, at: Date.now() };
    const shapeChanges = { tokens: controlLimits.shapeChangesPerSecond, at: Date.now() };
    const ctx: ConnectionContext = {
      options,
      tailnet,
      serverName,
      get homeId() {
        return homeId;
      },
      set homeId(value) {
        homeId = value;
      },
      hostHealth,
      statusFeed,
      viewsOf,
      currentStatus,
      hostsDevices,
      frameHelper,
      get nativeViewerOpened() {
        return nativeViewerOpened;
      },
      set nativeViewerOpened(value) {
        nativeViewerOpened = value;
      },
      frames,
      get recorder() {
        return recorder;
      },
      set recorder(value) {
        recorder = value;
      },
      get startup() {
        return startup;
      },
      set startup(value) {
        startup = value;
      },
      readApprovals,
      approved,
      buildAllowed,
      running,
      cancelling,
      logLimits,
      commandLimits,
      actionLimits,
      busyWorkspaces,
      retainedLifecycles,
      planQueues,
      desktopReports,
      get recordingTurn() {
        return recordingTurn;
      },
      set recordingTurn(value) {
        recordingTurn = value;
      },
      get closing() {
        return closing;
      },
      set closing(value) {
        closing = value;
      },
      sessions,
      sampler,
      usage,
      recordUsage,
      controllers,
      controlLimits,
      adbEmulators,
      hostedPresence,
      agentDrivers,
      hostedDevices,
      agentLinks,
      agentStreams,
      agentHttp,
      builds,
      jobs,
      presence,
      localAgents,
      control,
      hostedViews,
      shares,
      machineUpdates,
      updates,
      push,
      desktopSessions,
      hostedBridge,
      get settingUpRoute() {
        return settingUpRoute;
      },
      set settingUpRoute(value) {
        settingUpRoute = value;
      },
      socket,
      local,
      clientKey,
      keyless,
      subscriptions,
      setupRuns,
      keyframes,
      congestion,
      replays,
      get keyframeReads() {
        return keyframeReads;
      },
      set keyframeReads(value) {
        keyframeReads = value;
      },
      holdSlot,
      releaseSlot,
      slotsFull,
      slotsMessage,
      planRequests,
      persistentActions,
      get device() {
        return device;
      },
      set device(value) {
        device = value;
      },
      get desktopChallenge() {
        return desktopChallenge;
      },
      set desktopChallenge(value) {
        desktopChallenge = value;
      },
      tracker,
      get runId() {
        return runId;
      },
      set runId(value) {
        runId = value;
      },
      get metroLink() {
        return metroLink;
      },
      set metroLink(value) {
        metroLink = value;
      },
      get metroStream() {
        return metroStream;
      },
      set metroStream(value) {
        metroStream = value;
      },
      get metroPing() {
        return metroPing;
      },
      set metroPing(value) {
        metroPing = value;
      },
      get clientPing() {
        return clientPing;
      },
      set clientPing(value) {
        clientPing = value;
      },
      relay,
      refuse,
      timer,
      error,
      canControl,
      inputs,
      characters,
      shapeChanges,
      controller,
      workspaceDir,
      readDir,
      openSubscription,
      inProcessRead,
      unsubscribeRequest,
      addresses,
    };

    function controller(session: Pick<PairedDevice, 'id' | 'name'>): Controller {
      let found = controllers.get(socket);
      if (!found) {
        found = { device: session, send: (message) => send(socket, message) };
        controllers.set(socket, found);
      }
      return found;
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

    function readDir(id: RequestId, target: { workspace?: string; archive?: string }): string | null {
      if (target.archive === undefined) return workspaceDir(id, target.workspace, true);
      if (!readArchive(target.archive)) {
        error(id, 'unknown-workspace', `Archive ${target.archive} is not a Stim archive on this machine.`);
        return null;
      }
      return archiveDir(target.archive);
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

    const statusMethods: Partial<Record<string, (id: RequestId, params: unknown) => void | Promise<void>>> = {
      'workspaces.subscribe': (id) => subscribeWorkspaces(ctx, id),
      'workspace.subscribe': (id, params) => subscribeWorkspace(ctx, id, params),
      'machine.subscribe': (id) => subscribeMachine(ctx, id),
      'builds.history': (id, params) => readBuildsHistory(ctx, id, params),
      'archived.list': (id, params) => listArchived(ctx, id, params),
      'worktrees.list': (id) =>
        statusRead<'worktrees.list'>(ctx, id, (payload) => ({ result: { worktrees: payload.unprovisionedWorktrees } })),
      'maintenance.get': (id) =>
        statusRead<'maintenance.get'>(ctx, id, (payload) => ({ result: { maintenance: payload.maintenance ?? null } })),
    };

    function archiveRead(id: RequestId, read: () => void | Promise<void>): void {
      if (slotsFull()) {
        return error(id, 'limit-exceeded', slotsMessage());
      }
      let dropped = false;
      const cancel = async () => {
        dropped = true;
        await task;
      };
      holdSlot(cancel);
      running.add(cancel);
      const task = archiveReads
        .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
        .then(() => {
          if (!dropped && socket.readyState === socket.OPEN) return read();
          return undefined;
        })
        .finally(() => {
          releaseSlot(cancel);
          running.delete(cancel);
        });
      archiveReads = task.catch(() => socket.close(1011, 'internal error'));
    }

    function inProcessRead<
      M extends
        | 'settings.get'
        | 'stats.get'
        | 'logs.query'
        | 'desktop.reports.get'
        | 'desktop.settings.get'
        | 'desktop.doctor.run'
        | 'build.plan'
        | 'desktop.plan.get',
    >(
      id: RequestId,
      label: string,
      read: (signal: AbortSignal) => Promise<Methods[M]['result']>,
      timeoutMs = commandLimits.timeoutMs,
      turn: Promise<void> | null = null,
      report = false,
    ): { done: Promise<void>; cancel: () => Promise<void> } | null {
      if (report ? reportWaits.size >= MAX_REPORT_WAITS : slotsFull()) {
        error(
          id,
          'limit-exceeded',
          report ? `A connection can wait for ${MAX_REPORT_WAITS} reports at a time.` : slotsMessage(),
        );
        return null;
      }
      const abort = new AbortController();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const task = Promise.resolve(turn)
        .then(() => {
          abort.signal.throwIfAborted();
          deadline = setTimeout(() => {
            if (abort.signal.aborted) return;
            abort.abort();
            error(id, 'stim-failed', `${label} did not finish within ${timeoutMs / 1000} s.`);
          }, timeoutMs);
          return read(abort.signal);
        })
        .then(
          (result) => {
            if (abort.signal.aborted) return undefined;
            if (Buffer.byteLength(JSON.stringify(result)) > commandLimits.maxOutputBytes) {
              error(id, 'stim-failed', `${label} printed more than ${commandLimits.maxOutputBytes} bytes.`);
            } else send(socket, { id, result });
            return undefined;
          },
          (cause: unknown) => {
            if (!abort.signal.aborted) error(id, 'stim-failed', readFailure(cause));
            return undefined;
          },
        )
        .finally(() => {
          clearTimeout(deadline);
          releaseSlot(cancel);
          reportWaits.delete(cancel);
          running.delete(cancel);
        });
      const cancel = async () => {
        abort.abort();
        await task;
      };
      if (report) reportWaits.add(cancel);
      else holdSlot(cancel);
      running.add(cancel);
      return { done: task, cancel };
    }

    function handleBinary(frame: Buffer): Promise<void> | void {
      if (metroStream) {
        const stream = metroStream;
        if (stream.destroyed || stream.write(frame)) return;
        socket.pause();
        return new Promise<void>((resolve) => {
          const resume = () => {
            stream.off('drain', resume);
            stream.off('close', resume);
            socket.resume();
            resolve();
          };
          stream.on('drain', resume);
          stream.on('close', resume);
        });
      }
      if (socket.readyState !== socket.OPEN) return;
      const received = device ? jobs.receive(socket, frame) : false;
      if (received === false) return void socket.close(CLOSE_BAD_REQUEST, 'unexpected binary frame');
      if (typeof received === 'string') socket.close(CLOSE_BAD_REQUEST, received.slice(0, 120));
    }

    async function unsubscribeRequest(id: RequestId, name: unknown): Promise<void> {
      if (typeof name !== 'string') return error(id, 'unknown-subscription', `No subscription ${String(name)}.`);
      const unsubscribe = subscriptions.get(name);
      if (!unsubscribe) return error(id, 'unknown-subscription', `No subscription ${name}.`);
      subscriptions.delete(name);
      const failure = await unsubscribe();
      send(socket, failure ? { id, error: failure } : { id, result: {} });
    }

    const localMethods: Partial<Record<string, (id: RequestId, params: unknown) => void | Promise<void>>> = {
      'share.start': (id, params) => shareMethod(ctx, id, 'share.start', params),
      'share.stop': (id, params) => shareMethod(ctx, id, 'share.stop', params),
      'share.list': (id, params) => shareMethod(ctx, id, 'share.list', params),
      'presence.publish': (id, params) => publishPresence(ctx, id, params),
    };

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
      tracker.begin(id, message.method);
      if (message.method === 'hello') return hello(ctx, id, message.params);
      if (!device) return refuse(id, 'unauthorized', 'Send hello first.', CLOSE_REFUSED);
      if (message.method === 'desktop.authenticate') return authenticateDesktop(ctx, id, message.params);
      for (const reconcile of retainedLifecycles) reconcile();
      if ((DEVICE_HOST_METHODS as readonly string[]).includes(message.method)) {
        if (!device.capabilities.includes('device-host'))
          return error(id, 'forbidden', 'Explicit device-host approval is required.');
        return hostedMethod(ctx, id, message.method, message.params, device);
      }
      const approvedMachine = machineMethod(ctx, id, message.method, message.params, device);
      if (approvedMachine) return approvedMachine;
      const localMethod = Object.hasOwn(localMethods, message.method) ? localMethods[message.method] : undefined;
      if (localMethod) return localMethod(id, message.params);
      const desktop = desktopMethod(ctx, id, message.method, message.params, device);
      if (desktop) return desktop;
      if (!device.capabilities.includes('read')) {
        return error(id, 'forbidden', `${message.method} needs read access, which this connection does not have.`);
      }
      if (isJsonObject(message.params) && typeof message.params.archive === 'string') {
        const params = message.params;
        const reads: Partial<Record<string, (id: RequestId, params: unknown) => void | Promise<void>>> = {
          'logs.subscribe': (...args) => subscribeLogs(ctx, ...args),
          'logs.query': (...args) => queryLogs(ctx, ...args),
          'frames.subscribe': (...args) => subscribeFrames(ctx, ...args),
          'replay.range': (...args) => replayRange(ctx, ...args),
          'archive.detail': (...args) => archiveDetail(ctx, ...args),
          'replay.keyframe': (...args) => replayKeyframe(ctx, ...args),
        };
        const read = reads[message.method];
        if (read) return archiveRead(id, () => read(id, params));
      }
      const statusMethod = statusMethods[message.method];
      if (statusMethod) return void statusMethod(id, message.params);
      if (message.method === 'logs.subscribe') return subscribeLogs(ctx, id, message.params);
      if (message.method === 'logs.query') return queryLogs(ctx, id, message.params);
      if (message.method === 'frames.subscribe') return subscribeFrames(ctx, id, message.params);
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
      if (message.method === 'replay.range') return replayRange(ctx, id, message.params);
      if (message.method === 'archive.detail') return archiveDetail(ctx, id, message.params);
      if (message.method === 'replay.keyframe') {
        void replayKeyframe(ctx, id, message.params);
        return;
      }
      if (message.method === 'recording.set') return setRecording(ctx, id, message.params, device);
      if (message.method === 'build.plan') return planBuild(ctx, id, message.params);
      if (message.method === 'machine.get') return send(socket, { id, result: await readMachineUsage() });
      if (message.method === 'machine.details') {
        const machinesPart = buildMachines.snapshot((cwd) => readDetailsReport('doctor', cwd), doctorTarget());
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
        return workspaceChanges(ctx, id, message.method, message.params);
      }
      if (message.method === 'stats.get' || message.method === 'settings.get') {
        return workspaceCommand(ctx, id, message.method, message.params);
      }
      if (message.method === 'action') return runAction(ctx, id, message.params, device);
      if (message.method === 'control.begin') {
        void beginControl(ctx, id, message.params, device);
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
        void input(ctx, id, inputMethod, message.params, device);
        return;
      }
      if (message.method === 'push.register') return registerPush(ctx, id, message.params, device);
      if (message.method === 'notifications.list') {
        const params = message.params ?? {};
        const since = isJsonObject(params) ? params.since : undefined;
        if (
          !isJsonObject(params) ||
          (since !== undefined && !(typeof since === 'number' && Number.isInteger(since) && since >= 0))
        ) {
          return error(id, 'bad-request', 'notifications.list takes an optional since, a cursor of 0 or more.');
        }
        listeners.add(socket);
        return send(socket, { id, result: notificationLog.list(device.id, since) });
      }
      if (message.method === 'push.unregister') {
        setDevicePush(device.id, null);
        push.refresh();
        return send(socket, { id, result: {} });
      }
      if (message.method === 'unsubscribe')
        return unsubscribeRequest(id, isJsonObject(message.params) ? message.params.subscription : undefined);
      send(socket, { id, error: { code: 'unknown-method', message: `Unknown method ${message.method}.` } });
    }

    socket.on('message', (data, isBinary) => {
      if (jobs.owns(socket)) {
        const frame = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
        return jobs.deliver(socket, frame, isBinary);
      }
      if (isBinary) {
        const frame = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
        queue = queue.then(() => handleBinary(frame)).catch(() => socket.close(1011, 'internal error'));
        return;
      }
      const raw = data.toString();
      queue = queue.then(() => handle(raw)).catch(() => socket.close(1011, 'internal error'));
    });
    socket.on('close', (code) => {
      clearInterval(metroPing);
      clearInterval(clientPing);
      if (metroLink) hostedDevices.metroUnlink(metroLink);
      const stream = metroStream;
      if (stream && code === 1000 && !stream.destroyed) {
        queue = queue.then(() => void stream.end());
        let ending: NodeJS.Timeout | undefined;
        const arm = () => {
          clearTimeout(ending);
          ending = setTimeout(() => stream.destroy(), METRO_END_MS);
          ending.unref();
        };
        arm();
        stream.on('drain', arm);
        stream.once('close', () => {
          clearTimeout(ending);
          stream.off('drain', arm);
        });
      } else if (stream && !stream.destroyed) {
        if (stream instanceof Socket) stream.resetAndDestroy();
        else stream.destroy();
      }
      relay.close();
      relays.delete(socket);
      clearTimeout(timer);
      jobs.disconnected(socket, code);
      sessions.delete(socket);
      desktopSessions.delete(socket);
      listeners.delete(socket);
      if (sessions.size === 0) sampler.stop();
      const owner = controllers.get(socket);
      if (owner) control.endFor(owner, null, 'The client disconnected.');
      controllers.delete(socket);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      for (const cancel of [...commands, ...reportWaits]) {
        if (persistentActions.has(cancel)) {
          releaseSlot(cancel);
          continue;
        }
        running.delete(cancel);
        void cancelling.track(cancel());
      }
    });
  }

  function upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    // Node's http server drops its own socket error listener once it emits 'upgrade'; without one, a peer that resets
    // the connection after a refusal would raise an uncaught ECONNRESET.
    socket.on('error', () => socket.destroy());
    if (startup.state !== 'ready') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const peer = peerAddress(request);
    if (options.loopbackOnly && peer !== null) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (upgradeFromWebPage(request.headers, arrival(request))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (limiter.blocked(peer ?? 'local') || unknownSecrets.blocked(peer ?? 'local')) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const idle = setTimeout(() => {
        limiter.record(peer ?? 'local');
        ws.close(CLOSE_AUTH_TIMEOUT, 'authentication timeout');
      }, authTimeoutMs);
      ws.once('close', () => clearTimeout(idle));
      ws.once('message', (data, isBinary) => {
        clearTimeout(idle);
        void authenticate(ws, request, peer, data, isBinary);
      });
    });
  }

  /**
   * Runs the Noise handshake on a network connection and finds the client's records: a first-contact client spends
   * its pairing token or setup ticket, a returning client must already have a record for its key. The network address
   * only keys rate limits and labels the record.
   */
  async function authenticate(
    ws: WebSocket,
    request: IncomingMessage,
    peer: string | null,
    data: unknown,
    isBinary: boolean,
  ): Promise<void> {
    const limitKey = peer ?? 'local';
    /**
     * `unknown-secret` is not a failure: a requester polls with its setup ticket until `stim setup` stores it,
     * and a 16-byte lookup reveals nothing without the PSK. It has its own, far higher, limit per address.
     */
    const refuse = (code: string) => {
      if (code !== 'home-unavailable') (code === 'unknown-secret' ? unknownSecrets : limiter).record(limitKey);
      if (ws.readyState === ws.OPEN) ws.close(CLOSE_REFUSED, code);
    };
    try {
      serverKey ??= serverIdentity();
    } catch (error) {
      console.error(`stim-server: cannot read the server key: ${(error as Error).message}`);
      return void ws.close(1011, 'server key unavailable');
    }
    let accepted;
    try {
      accepted = await acceptNoise(ws, data, isBinary, {
        keyPair: serverKey,
        psk: (lookup) => {
          try {
            return secretPsk(lookup);
          } catch (error) {
            if (!(error instanceof RegistryUnavailable)) throw error;
            readApprovals();
            throw new HandshakeRefusal('home-unavailable', HOME_UNAVAILABLE_MESSAGE);
          }
        },
        timeoutMs: authTimeoutMs,
      });
    } catch (error) {
      if (error instanceof HandshakeRefusal && error.code === 'home-unavailable') return;
      (error instanceof HandshakeRefusal && error.code === 'unknown-secret' ? unknownSecrets : limiter).record(
        limitKey,
      );
      return;
    }
    // @ref LLP 0008#authenticate-the-key -- approval follows the proved key across transports
    const publicKey = accepted.clientKey.toString('base64url');
    let records: KeyRecords | null;
    if (accepted.mode === MODE_FIRST_CONTACT) {
      let name = '';
      try {
        const payload = JSON.parse(accepted.payload.toString('utf8')) as { name?: unknown };
        if (typeof payload.name === 'string') name = payload.name;
      } catch {
        return refuse('bad-request');
      }
      const from = peer ? await describePeer(request, peer) : 'this machine';
      if (ws.readyState !== ws.OPEN) return;
      try {
        records = spendSecret(accepted.lookup!, publicKey, name, from);
      } catch (error) {
        if (!(error instanceof RegistryUnavailable)) throw error;
        console.error(`stim-server: could not record a new client: ${error.message}`);
        readApprovals();
        return refuse('home-unavailable');
      }
      if (!records) return refuse('unknown-secret');
      if (!records.device && !records.build && !records['device-host']) return refuse('unauthorized');
    } else {
      const registries = readApprovals();
      if (!registries) return refuse('home-unavailable');
      records = recordsForKey(publicKey, registries);
      if (!records.device && !records.build && !records['device-host']) return refuse('unauthorized');
    }
    if (ws.readyState !== ws.OPEN) return;
    pendingPools.get(request.socket)?.settle(request.socket);
    const host = records['device-host'];
    if (host) {
      const node = peer ? await peerNode(request, peer) : null;
      if (node) agentNodes.set(host.id, node);
      else if (!peer) agentNodes.delete(host.id);
      if (ws.readyState !== ws.OPEN) return;
    }
    connection(accepted.socket, peer, false, publicKey);
  }

  function upgradeLocal(request: IncomingMessage, socket: Socket, head: Buffer): void {
    // Node's http server drops its own socket error listener once it emits 'upgrade'; without one, a peer that resets
    // the connection after a refusal would raise an uncaught ECONNRESET.
    socket.on('error', () => socket.destroy());
    if (startup.state !== 'ready') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    localWss.handleUpgrade(request, socket, head, (ws) => connection(ws, null, true, null));
  }

  const health = {
    server: 'stim-server',
    version: options.serverVersion,
    stim: options.stimVersion,
    stimBuild: ownStimBuild,
    protocol: PROTOCOL_VERSION,
    stimHome: configDir(),
  } as const;
  const lanHealth = (): Pick<ServerHealth, 'lan'> => {
    const wanted = new Set(
      transports.filter((transport) => transport.id === 'local').flatMap((transport) => bindings.get(transport) ?? []),
    );
    const bound = addresses.filter(({ host }) => wanted.has(host));
    const [first] = bound;
    return first ? { lan: { addresses: bound.map(({ host }) => host), port: first.port } } : {};
  };
  const answerHealth = async (response: ServerResponse) => {
    const { state, route } = await tailnet.health(addresses[0]!.port, HEALTH_ROUTE_TIMEOUT_MS);
    const body: ServerHealth = {
      ...health,
      name: await serverName(),
      startup,
      ...(options.host ? { host: await hostHealth() } : {}),
      busy: {
        builds: jobs.running(),
        hostedSessions: hostedDevices.active(),
        hostedWork: hostedDevices.working(),
        resumes: true,
      },
      tailscale: healthTailscale(state),
      route,
      nativeViewerOpened,
      ...(options.loopbackOnly ? { loopbackOnly: true as const } : {}),
      ...lanHealth(),
      keepAwake: keepAwake.status(),
      workerRoot: builds.workerRootUsage(),
    };
    response
      .writeHead(startup.state === 'ready' ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify(body));
  };
  const servers = new Map<string, { server: Server; sockets: Set<Socket> }>();
  const addresses: RunningServer['addresses'] = [];
  const keepAwake = createKeepAwake({
    setting: () => false,
    ...options.keepAwake,
    loopbackOnly: options.loopbackOnly === true,
    remoteListening: () => [...servers.keys()].some((host) => !options.hosts.includes(host)),
  });
  const close = async () => {
    const failures: unknown[] = [];
    const settle = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (error) {
        failures.push(error);
      }
    };
    closing = true;
    keepAwake.close();
    desktopReports.close();
    if (startupRetry) clearTimeout(startupRetry);
    if (setupPruneTimer) clearInterval(setupPruneTimer);
    if (shareServerGrace) clearTimeout(shareServerGrace);
    startupProbe?.cancel();
    startupAbort.abort();
    await settle(homeCheck ?? Promise.resolve());
    watcher?.close();
    if (revocationPoll) clearInterval(revocationPoll);
    if (hostedIdleSweep) clearInterval(hostedIdleSweep);
    if (revocationCheck) clearTimeout(revocationCheck);
    await settle(jobs.close());
    await settle(builds.close());
    for (const client of [...wss.clients, ...localWss.clients]) client.terminate();
    hostConnections.close();
    if (startup.state === 'ready' || homeLost) {
      push.close();
      helperAbort.abort();
      sampler.stop();
      await settle(shares.close());
      presence.close();
      hostedPresence.close();
      await settle(control.close());
      await settle(hostedDevices.close());
      await settle(agentDrivers.close({ keep: hostedDevices.detached() }));
      updates.close();
      recorder?.close();
      await Promise.all(
        [
          frames.close(),
          feeds.close(),
          statusFeed.close(),
          ...[...running].map((cancel) => cancel()),
          cancelling.settled(),
        ].map(settle),
      );
    }
    wss.close();
    localWss.close();
    await Promise.all([...servers.values()].map((listener) => settle(closeListener(listener))));
    if (failures.length) throw new AggregateError(failures, 'Server resources did not close cleanly.');
  };
  async function listenOn(host: string): Promise<void> {
    const network = !isLoopback(host);
    const headersTimeout = options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
    const limits = network
      ? {
          headersTimeout,
          requestTimeout: headersTimeout * 3,
          connectionsCheckingInterval: Math.min(1000, headersTimeout),
        }
      : {};
    const pending = network
      ? new PendingConnections(
          options.pendingConnections?.max ?? MAX_PENDING_CONNECTIONS,
          options.pendingConnections?.perPeer ?? MAX_PENDING_PER_PEER,
        )
      : null;
    const server = createServer(limits, (request, response) => {
      if (options.loopbackOnly && peerAddress(request) !== null) {
        response.writeHead(403, { 'content-type': 'text/plain' }).end('This stim-server serves this machine only.\n');
        return;
      }
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
        const peerHealth = {
          version: health.version,
          ...(startup.state === 'ready'
            ? {}
            : {
                startup:
                  startup.state === 'degraded' ? { state: 'degraded', cause: startup.cause } : { state: 'pending' },
              }),
        };
        response
          .writeHead(startup.state === 'ready' ? 200 : 503, { 'content-type': 'application/json' })
          .end(JSON.stringify(peerHealth));
        return;
      }
      if (request.url?.startsWith('/setup')) {
        answerSetup(request, response);
        return;
      }
      const agent = AGENT_PATH.exec(request.url ?? '');
      if (agent && arrival(request) === 'direct') {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found.\n');
        return;
      }
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
      if (pending) {
        if (!pending.admit(socket)) return void socket.destroy();
        pendingPools.set(socket, pending);
        socket.setTimeout(headersTimeout, () => socket.destroy());
      }
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
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'server startup cleanup could not be verified', { cause: cleanup });
    }
    throw error;
  }
  const listenFailures = new Set<string>();
  const reconcile = async () => {
    const extra = options.loopbackOnly ? [] : [...bindings.values()].flat();
    const wanted = new Set([...options.hosts, ...extra]);
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
    keepAwake.sync();
  };
  let retry: NodeJS.Timeout | null = null;
  let reconciling = Promise.resolve();
  const queueReconcile = () => {
    if (retry) clearTimeout(retry);
    retry = null;
    if (bindings.size) reconciling = reconciling.then(reconcile);
  };
  const stopWatching: (() => void)[] = [];
  const bind = (transport: Transport) => {
    if (!transport.bindAddresses || bindings.has(transport)) return;
    if (transport.watch)
      stopWatching.push(
        transport.watch((event) => {
          bindings.set(transport, event.addresses);
          queueReconcile();
        }),
      );
    bindings.set(transport, transport.bindAddresses());
  };
  try {
    for (const transport of transports) bind(transport);
  } catch (error) {
    for (const stop of stopWatching) stop();
    throw error;
  }
  if (options.tailnet)
    tailnet.onLoad((transport) => {
      if (closing || transports.includes(transport)) return;
      transports.push(transport);
      bind(transport);
      queueReconcile();
    });
  queueReconcile();
  await reconciling;
  keepAwake.sync();
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
    let cause: StartupCause = 'home-unreadable';
    startupProbe = null;
    if (closing) return settle(startup);
    if (reason === null) {
      try {
        homeId = await createStim({ projectRoot: homedir(), env: options.env, admission: 'none' }).identity({
          signal: startupAbort.signal,
        });
        if (closing) return settle(startup);
        becomeReady();
      } catch (error) {
        reason = (error as Error).message;
        cause = 'start-failed';
      }
    }
    if (closing) return settle(startup);
    if (reason === null) {
      if (startup.state === 'degraded') console.error('stim-server: the Stim home answers again; serving clients.');
      startup = { state: 'ready' };
      pruneSetup();
      if (options.shareServer && !shareServerGrace) {
        const { idle, graceMs = SHARE_SERVER_GRACE_MS } = options.shareServer;
        const idleWhenRestored = () => {
          void (restoredShares ?? Promise.resolve()).then(() => (shares.isIdle() ? idle() : undefined));
        };
        shareServerGrace = setTimeout(idleWhenRestored, graceMs);
        shareServerGrace.unref?.();
      }
      if (!options.shareServer && options.service?.label) {
        void (options.service.runsAsService ?? runsAsService)(options.service.label, options.port).then((installed) =>
          installed && !closing ? shares.keep() : undefined,
        );
      }
      void shareRoute
        .recover()
        .catch((failure: Error) =>
          console.error(`stim-server: could not remove a web share route left behind: ${failure.message}`),
        );
      setupPruneTimer ??= setInterval(pruneSetup, 60 * 60_000).unref();
      return settle(startup);
    }
    if (startup.state !== 'degraded' || startup.reason !== reason) {
      console.error(`stim-server: listening, but not serving clients until the Stim home answers. ${reason}`);
    }
    startup = { state: 'degraded', reason, cause };
    settle(startup);
    startupRetry = setTimeout(() => {
      homeCheck = checkHome();
    }, options.startupRetryMs ?? STARTUP_RETRY_MS);
  };
  homeCheck = checkHome();
  const localHttp = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') return void answerHealth(response);
    response.writeHead(426, { 'content-type': 'text/plain' }).end('stim-server speaks WebSocket only.\n');
  });
  localHttp.on('upgrade', upgradeLocal);
  return {
    addresses,
    acceptLocal: (stream) => {
      if (closing) return void stream.destroy();
      localHttp.emit('connection', stream);
    },
    publishPresence: (params) => recordPresence(localAgents, params)?.message ?? null,
    ready,
    close: async () => {
      for (const stop of stopWatching) stop();
      const closed = close();
      if (retry) clearTimeout(retry);
      await Promise.all([reconciling, closed]);
      await Promise.all([...servers.values()].map(closeListener));
    },
  };
}
