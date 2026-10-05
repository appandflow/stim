import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostedAgentGrant } from '@stim-cli/core/state';

/** One hosted macOS app a driver may be handed: a single client, session, hosted bundle id and process. */
export interface HostedAgentApp {
  client: string;
  session: string;
  bundleId: string;
  pid: number;
}

/**
 * The host side of one driving tool. `HostedAgentHost` calls it; a driver never decides which client or
 * session may use it.
 */
export interface HostedAgentDriver {
  readonly name: Exclude<HostedAgentGrant['driver'], 'none'>;
  /** Starts the host daemon under an ownership claim whose child is the daemon; idempotent. */
  start(): Promise<void>;
  /** Stops the daemon with identity-checked signals and releases its claim; resolves only once it is gone. */
  stop(): Promise<void>;
  /** Issues a grant scoped to exactly one hosted app. Refuses with `AgentDriverUnavailable` when it cannot scope. */
  issue(app: HostedAgentApp): Promise<HostedAgentGrant>;
  /** Invalidates a session's grant and lease. */
  revoke(session: string): Promise<void>;
  /** Forwards one request the host already authenticated to the loopback daemon. */
  forward(session: string, request: IncomingMessage, response: ServerResponse): void;
  /** Calls `listener` when the daemon exits without `stop()`; a driver keeps one listener. */
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

export type AgentAccess = { grant: HostedAgentGrant; notice?: string };

interface Entry {
  app: HostedAgentApp;
  grant: HostedAgentGrant;
  digest: Buffer;
  notice?: string;
}

export interface HostedAgentHostOptions {
  /** The driver the host's `hosting.agentDriver` names right now, or null for none. Read when no driver runs. */
  resolve: () => HostedAgentDriver | null;
  /** The tailnet node a client's approved device-host credential is pinned to, or null once it is not approved. */
  nodeOf: (client: string) => string | null;
  restartDelayMs?: number;
  maxRestarts?: number;
}

const digest = (token: string): Buffer => createHash('sha256').update(token).digest();

const none = (notice?: string): AgentAccess => ({ grant: { driver: 'none' }, ...(notice ? { notice } : {}) });

/**
 * Reference-counts a driver on live hosted macOS apps. It starts the driver with the first app that gets a
 * grant and stops it after the last one, on revocation and on close. Grants live only here, in memory:
 * a driver restart drops the leases they name, so a restart issues new grants that the client reads
 * again through `app.attach`.
 */
export class HostedAgentHost {
  private readonly options: HostedAgentHostOptions;
  private readonly entries = new Map<string, Entry>();
  private active: HostedAgentDriver | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: HostedAgentHostOptions) {
    this.options = options;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private live(): Entry[] {
    return [...this.entries.values()].filter((entry) => entry.grant.driver !== 'none');
  }

  /** What `app.launch` and `app.attach` hand a client for this session; undefined before the app runs. */
  access(session: string): AgentAccess | undefined {
    const entry = this.entries.get(session);
    return entry ? { grant: entry.grant, ...(entry.notice ? { notice: entry.notice } : {}) } : undefined;
  }

  /** The session's app is installed and running. Issues its grant, starting the driver when it is the first. */
  appRunning(app: HostedAgentApp): Promise<AgentAccess> {
    return this.serialize(async () => {
      const existing = this.entries.get(app.session);
      if (existing && existing.app.pid === app.pid && existing.app.bundleId === app.bundleId)
        return this.access(app.session)!;
      if (existing) await this.drop(app.session, false);
      if (this.closed) return none();
      const driver = this.active ?? this.options.resolve();
      if (!driver) return this.remember(app, none());
      if (this.active !== driver) {
        try {
          await driver.start();
        } catch (error) {
          return this.remember(app, none(this.reason(error)));
        }
        this.active = driver;
        driver.onExit(() => void this.lost(driver));
      }
      try {
        const grant = await driver.issue(app);
        return this.remember(app, { grant });
      } catch (error) {
        if (this.live().length === 0) await this.stopDriver();
        return this.remember(app, none(this.reason(error)));
      }
    });
  }

  private remember(app: HostedAgentApp, access: AgentAccess): AgentAccess {
    this.entries.set(app.session, {
      app,
      grant: access.grant,
      digest: access.grant.driver === 'none' ? Buffer.alloc(0) : digest(access.grant.token),
      ...(access.notice ? { notice: access.notice } : {}),
    });
    return access;
  }

  private reason(error: unknown): string {
    if (error instanceof AgentDriverUnavailable) return error.message;
    process.stderr.write(`Hosted agent driver failed: ${(error as Error).message}\n`);
    return 'Agent control failed to start on the hosting Mac. Check its stim-server log.';
  }

  /** The session's app stopped or its client lost approval. Revokes its grant and stops the driver after the last. */
  appStopped(session: string): Promise<void> {
    return this.serialize(async () => {
      await this.drop(session);
    });
  }

  private async drop(session: string, stopAfterLast = true): Promise<void> {
    const entry = this.entries.get(session);
    if (!entry) return;
    this.entries.delete(session);
    if (entry.grant.driver === 'none' || !this.active) return;
    try {
      await this.active.revoke(session);
    } catch (error) {
      process.stderr.write(`Hosted agent grant revoke failed: ${(error as Error).message}\n`);
    }
    if (stopAfterLast && this.live().length === 0) await this.stopDriver();
  }

  private async stopDriver(): Promise<void> {
    const driver = this.active;
    this.active = null;
    if (!driver) return;
    try {
      await driver.stop();
    } catch (error) {
      process.stderr.write(`Hosted agent driver did not stop cleanly: ${(error as Error).message}\n`);
    }
  }

  private lost(driver: HostedAgentDriver): Promise<void> {
    return this.serialize(async () => {
      if (this.active !== driver || this.closed) return;
      const apps = this.live().map((entry) => entry.app);
      const delay = this.options.restartDelayMs ?? 1000;
      const attempts = this.options.maxRestarts ?? 3;
      let started = false;
      await driver.stop().catch(() => undefined);
      for (let attempt = 0; attempt < attempts && !started && !this.closed; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, delay * 2 ** attempt));
        try {
          await driver.start();
          started = true;
        } catch {
          await driver.stop().catch(() => undefined);
        }
      }
      if (!started || this.closed) {
        this.active = null;
        for (const app of apps)
          this.remember(app, none('Agent control stopped: its daemon exited and could not be restarted.'));
        return;
      }
      for (const app of apps) {
        try {
          this.remember(app, { grant: await driver.issue(app) });
        } catch (error) {
          this.remember(app, none(this.reason(error)));
        }
      }
      if (this.live().length === 0) await this.stopDriver();
    });
  }

  /**
   * Whether `token` is this session's grant, presented from the tailnet node its client's approval is pinned
   * to, while its app runs.
   */
  authorize(session: string, token: string | null, node: string | null): 'ok' | 'unknown' | 'forbidden' {
    const entry = this.entries.get(session);
    if (!entry || entry.grant.driver === 'none') return 'unknown';
    const expected = this.options.nodeOf(entry.app.client);
    if (!token || !expected || node !== expected) return 'forbidden';
    const presented = digest(token);
    return presented.length === entry.digest.length && timingSafeEqual(presented, entry.digest) ? 'ok' : 'forbidden';
  }

  /** Forwards an authorized request; any other request is answered 404 or 403 and never reaches the driver. */
  forward(
    session: string,
    token: string | null,
    node: string | null,
    request: IncomingMessage,
    response: ServerResponse,
  ): 'ok' | 'unknown' | 'forbidden' {
    const verdict = this.authorize(session, token, node);
    if (verdict === 'ok' && this.active) this.active.forward(session, request, response);
    else if (verdict === 'ok')
      response.writeHead(503, { 'content-type': 'text/plain' }).end('Agent control is not running.\n');
    else
      response
        .writeHead(verdict === 'unknown' ? 404 : 403, { 'content-type': 'text/plain' })
        .end(verdict === 'unknown' ? 'Not found.\n' : 'Forbidden.\n');
    return verdict;
  }

  /** Server shutdown: revokes every grant and stops the driver. */
  close(): Promise<void> {
    this.closed = true;
    return this.serialize(async () => {
      const sessions = [...this.entries.keys()];
      for (const session of sessions) await this.drop(session);
      await this.stopDriver();
    });
  }
}
