import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostedAgentIssuedGrant, NdjsonRecord } from '@stim-cli/core/state';

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

/**
 * The host side of one driving tool. stim-server's `HostedAgentHost` calls it; a driver never decides which
 * client or session may use it.
 */
export interface HostedAgentDriver {
  /** The module's `id`. */
  readonly name: string;
  /** Starts the host daemon under an ownership claim whose child is the daemon; idempotent. */
  start(): Promise<void>;
  /** Stops the daemon with identity-checked signals and releases its claim; resolves only once it is gone. */
  stop(): Promise<void>;
  /** Issues a grant scoped to exactly one hosted app. Refuses with `AgentDriverUnavailable` when it cannot scope. */
  issue(app: HostedAgentApp): Promise<HostedAgentIssuedGrant>;
  /** Invalidates a session's grant and lease. */
  revoke(session: string): Promise<void>;
  /** Forwards one request the host already authenticated to the loopback daemon. */
  forward(session: string, request: IncomingMessage, response: ServerResponse): void;
  /** Calls `listener` once for each daemon run that exits without `stop()`; a driver keeps one listener. */
  onExit(listener: () => void): void;
}

/** The driver cannot run or cannot scope an app; the message is safe to show a client. */
export class AgentDriverUnavailable extends Error {}

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

export interface AgentClientAccessInput {
  /** A grant naming this driver, as the client parsed it. */
  grant: HostedAgentIssuedGrant;
  /** `https://<host>[:<port>]` followed by the grant's path. */
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
  /** The file name the client writes in the placement's state directory. */
  configFile: string;
  access(input: AgentClientAccessInput): AgentClientAccess | null;
}

/** Reads the driver's recorded agent actions from a workspace or archive directory, as `agent` log records. */
export interface AgentDriverActions {
  read(input: { workspaceDir: string }): NdjsonRecord[];
}

/** The module shape a driver package exports. The loader rejects any other `apiVersion`. */
export interface AgentDriverModule {
  apiVersion: typeof AGENT_DRIVER_API_VERSION;
  id: string;
  createAgentDriver(input: AgentDriverInput): HostedAgentDriver;
  client?: AgentDriverClient;
  actions?: AgentDriverActions;
}

export type LoadAgentDriverModuleResult = { module: AgentDriverModule } | { unavailable: string };

export type LoadAgentDriverResult = { driver: HostedAgentDriver } | { unavailable: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\n[\s\S]*$/, '').trim() || 'unknown error';
}

function moduleError(candidate: unknown, id: string): string | null {
  if (!isRecord(candidate) || candidate.apiVersion !== AGENT_DRIVER_API_VERSION)
    return `expected apiVersion ${AGENT_DRIVER_API_VERSION}, found ${JSON.stringify(isRecord(candidate) ? candidate.apiVersion : candidate)}`;
  if (candidate.id !== id) return `expected id ${JSON.stringify(id)}, found ${JSON.stringify(candidate.id)}`;
  if (typeof candidate.createAgentDriver !== 'function') return 'the module does not export createAgentDriver()';
  const client = candidate.client;
  if (
    client !== undefined &&
    (!isRecord(client) || typeof client.configFile !== 'string' || typeof client.access !== 'function')
  )
    return 'the client capability must name configFile and implement access()';
  const actions = candidate.actions;
  if (actions !== undefined && (!isRecord(actions) || typeof actions.read !== 'function'))
    return 'the actions capability must implement read()';
  return null;
}

function driverError(driver: unknown, id: string): string | null {
  if (!isRecord(driver)) return 'createAgentDriver() did not return a driver object';
  if (driver.name !== id) return `the driver is named ${JSON.stringify(driver.name)}, not ${JSON.stringify(id)}`;
  for (const method of ['start', 'stop', 'issue', 'revoke', 'forward', 'onExit'])
    if (typeof driver[method] !== 'function') return `the driver does not implement ${method}()`;
  return null;
}

/**
 * Imports a driver module and checks its shape. Never throws: a failed or slow import, or a module that is not
 * a version 1 driver named `id`, resolves to `{ unavailable }` with a one-line reason.
 */
export async function loadAgentDriverModule(
  id: string,
  load: () => Promise<unknown>,
  timeoutMs: number = AGENT_DRIVER_LOAD_TIMEOUT_MS,
): Promise<LoadAgentDriverModuleResult> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<LoadAgentDriverModuleResult>((resolve) => {
    timer = setTimeout(() => resolve({ unavailable: `the module did not load within ${timeoutMs}ms` }), timeoutMs);
  });
  const loaded = Promise.resolve()
    .then(load)
    .then((namespace): LoadAgentDriverModuleResult => {
      const candidate =
        isRecord(namespace) && !('apiVersion' in namespace) && 'default' in namespace ? namespace.default : namespace;
      const invalid = moduleError(candidate, id);
      return invalid ? { unavailable: invalid } : { module: candidate as AgentDriverModule };
    })
    .catch((error: unknown): LoadAgentDriverModuleResult => ({ unavailable: reason(error) }));
  try {
    return await Promise.race([loaded, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Loads a driver module and creates its driver. Never throws; see `loadAgentDriverModule`. */
export async function loadAgentDriver(
  id: string,
  load: () => Promise<unknown>,
  input: AgentDriverInput,
  timeoutMs?: number,
): Promise<LoadAgentDriverResult> {
  const loaded = await loadAgentDriverModule(id, load, timeoutMs);
  if ('unavailable' in loaded) return loaded;
  let driver: unknown;
  let invalid: string | null;
  try {
    driver = loaded.module.createAgentDriver(input);
    if (driver instanceof Promise) {
      driver.catch(() => undefined);
      return { unavailable: 'createAgentDriver() must return the driver, not a promise' };
    }
    invalid = driverError(driver, id);
  } catch (error) {
    return { unavailable: `createAgentDriver() failed: ${reason(error)}` };
  }
  return invalid ? { unavailable: invalid } : { driver: driver as HostedAgentDriver };
}
