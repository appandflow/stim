import { loadKind, type PluginSource } from '@stim-cli/core/plugin-loader';
import { randomBytes } from 'node:crypto';
import type { HostedAgentIssuedGrant } from '@stim-cli/core/state';

export type { HostedAgentGrant, HostedAgentIssuedGrant, HostedAgentLease } from '@stim-cli/core/state';

export const AGENT_DRIVER_API_VERSION = 1 as const;

export const AGENT_DRIVER_LOAD_TIMEOUT_MS = 10_000;

export type HostedAgentDevice = { session: string } & (
  | { udid: string; serial?: never; avdName?: never }
  | { serial: string; avdName: string; udid?: never }
);

/** One installed hosted app and its process or owned device. */
export type HostedAgentApp = {
  client: string;
  session: string;
  bundleId: string;
} & ({ pid: number; udid?: never; serial?: never; avdName?: never } | (HostedAgentDevice & { pid?: never }));

/** A grant as the driver issues it. stim-server fills `path` with the session's agent route. */
export type AgentDriverGrant = Omit<HostedAgentIssuedGrant, 'path'>;

/**
 * The driver's own loopback listener for one session. stim-server proxies a request it authenticated under
 * `agentRoute(session)` to `http://127.0.0.1:<port><path><rest>`, where `rest` is what follows the session in the
 * route. The listener must not serve a request whose path does not start with `path`.
 */
export interface AgentDriverTarget {
  port: number;
  path: string;
}

/**
 * The host side of one driving tool. stim-server's `HostedAgentHost` calls it; a driver never decides which
 * client or session may use it. Every argument and result is structured-clone-safe data, so a driver can run in a
 * worker thread behind a `MessagePort`; `onExit`'s listener is the in-thread form of an event the bridge carries.
 */
export interface HostedAgentDriver {
  /** The module's `id`. */
  readonly name: string;
  /** Starts the host daemon under an ownership claim whose child is the daemon; idempotent. */
  start(): Promise<void>;
  /** Stops the daemon with identity-checked signals and releases its claim; resolves only once it is gone. */
  stop(): Promise<void>;
  /** Issues a grant scoped to exactly one hosted app. Refuses with `agent-driver-unavailable` when it cannot scope. */
  issue(app: HostedAgentApp): Promise<AgentDriverGrant>;
  /** Invalidates a session's grant and lease. */
  revoke(session: string): Promise<void>;
  /** Where stim-server proxies `session`'s authenticated requests, or null when the session has no live grant. */
  target(session: string): Promise<AgentDriverTarget | null>;
  /** Calls `listener` once for each daemon run that exits without `stop()`; the result stops the listener. */
  onExit(listener: () => void): () => void;
}

/** The error code of a driver that cannot run or cannot scope an app; the message is safe to show a client. */
export const AGENT_DRIVER_UNAVAILABLE = 'agent-driver-unavailable';

export type AgentDriverUnavailableError = Error & { code: typeof AGENT_DRIVER_UNAVAILABLE };

export function agentDriverUnavailable(message: string): AgentDriverUnavailableError {
  return Object.assign(new Error(message), { code: AGENT_DRIVER_UNAVAILABLE } as const);
}

export function isAgentDriverUnavailable(error: unknown): error is AgentDriverUnavailableError {
  return error instanceof Error && 'code' in error && error.code === AGENT_DRIVER_UNAVAILABLE;
}

export const AGENT_ROUTE_PREFIX = '/device-host/agent/';

export function agentRoute(session: string): string {
  return `${AGENT_ROUTE_PREFIX}${session}/`;
}

/** A 256-bit bearer secret in the alphabet `parseHostedAgentGrant` accepts. */
export function newAgentToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What stim-server hands a driver factory. `stateDir` and `claimRoot` are the driver's own, under the server
 * home for hosted macOS apps or under the session's area for one hosted device, which `device` then names.
 */
export interface AgentDriverInput {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  claimRoot: string;
  device?: HostedAgentDevice;
}

/** What stim-server hands a module's `recover`: the driver state and claim of one hosted session area. */
export type AgentDriverRecoveryInput = Omit<AgentDriverInput, 'device'>;

export interface AgentClientAccessInput {
  /** A grant naming this driver, as the client parsed it. */
  grant: HostedAgentIssuedGrant;
  /** `https://<host>[:<port>]`, or the client's loopback relay `http://127.0.0.1:<port>`, followed by the grant's path. */
  baseUrl: string;
  /** Where the client writes `config`, with mode 0600. */
  file: string;
  platform: 'macos' | 'ios' | 'android';
}

/** The client's file holding the grant's secret, and the command line that addresses the hosted app through it. */
export interface AgentClientAccess {
  config: string;
  command: string;
}

/**
 * The client side of a driver, run by the Stim CLI on the Mac that placed the app. `access` returns null for a
 * grant it cannot use on `platform`; `command` must name `file` and never carry the token.
 */
export interface AgentDriverClient {
  access(input: AgentClientAccessInput): AgentClientAccess | null;
}

/** The file a driver's client writes in the placement's state directory. */
export function agentClientConfigFile(id: string): string {
  return `${id}-remote.json`;
}

/** The module shape a driver package exports. `stimPlugin.kinds` declares its supported contract. */
export interface AgentDriverModule {
  id: string;
  createAgentDriver(input: AgentDriverInput): HostedAgentDriver | Promise<HostedAgentDriver>;
  client?: AgentDriverClient;
  /**
   * Called when stim-server starts, once for each hosted session area this driver has state in. Stops what a driver
   * run left behind for a stim-server process that is gone; rejects naming what it could not resolve.
   */
  recover?(input: AgentDriverRecoveryInput): Promise<void>;
}

export type LoadAgentDriverModuleResult = { module: AgentDriverModule } | { unavailable: string };

export type LoadAgentDriverResult = { driver: HostedAgentDriver } | { unavailable: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function moduleError(candidate: Record<string, unknown>, id: string): string | null {
  if (candidate.id !== id) return `expected id ${JSON.stringify(id)}, found ${JSON.stringify(candidate.id)}`;
  if (typeof candidate.createAgentDriver !== 'function') return 'the module does not export createAgentDriver()';
  const client = candidate.client;
  if (client !== undefined && (!isRecord(client) || typeof client.access !== 'function'))
    return 'the client capability must implement access()';
  if (candidate.recover !== undefined && typeof candidate.recover !== 'function')
    return 'the recover capability must be a function';
  return null;
}

function driverError(driver: unknown, id: string): string | null {
  if (!isRecord(driver)) return 'createAgentDriver() did not return a driver object';
  if (driver.name !== id) return `the driver is named ${JSON.stringify(driver.name)}, not ${JSON.stringify(id)}`;
  for (const method of ['start', 'stop', 'issue', 'revoke', 'target', 'onExit'])
    if (typeof driver[method] !== 'function') return `the driver does not implement ${method}()`;
  return null;
}

/** Loads a driver module whose manifest and shape match. Failures resolve to `unavailable`. */
export async function loadAgentDriverModule(
  id: string,
  source: PluginSource,
  timeoutMs: number = AGENT_DRIVER_LOAD_TIMEOUT_MS,
): Promise<LoadAgentDriverModuleResult> {
  const loaded = await loadKind<AgentDriverModule>({
    reference: id,
    kind: 'agent-driver',
    version: AGENT_DRIVER_API_VERSION,
    source,
    factory: 'createAgentDriver',
    instantiate: false,
    accept: (module) => module as AgentDriverModule,
    validateModule: (module) => moduleError(module, id),
    timeoutMs,
  });
  return 'value' in loaded ? { module: loaded.value } : loaded;
}

/** Loads a driver and awaits its factory. Failures resolve to `unavailable`. */
export async function loadAgentDriver(
  id: string,
  source: PluginSource,
  input: AgentDriverInput,
  timeoutMs: number = AGENT_DRIVER_LOAD_TIMEOUT_MS,
): Promise<LoadAgentDriverResult> {
  const loaded = await loadKind<HostedAgentDriver>({
    reference: id,
    kind: 'agent-driver',
    version: AGENT_DRIVER_API_VERSION,
    source,
    factory: 'createAgentDriver',
    input,
    validateModule: (module) => moduleError(module, id),
    accept(driver) {
      const invalid = driverError(driver, id);
      if (invalid) throw new Error(invalid);
      return driver as HostedAgentDriver;
    },
    dispose: (driver) => driver.stop(),
    timeoutMs,
  });
  return 'value' in loaded ? { driver: loaded.value } : loaded;
}
