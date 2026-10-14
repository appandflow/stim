import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AgentDriverUnavailable,
  type HostedAgentApp,
  type HostedAgentDevice,
  type HostedAgentDriver,
} from '@stim-cli/agent-driver';
import type { HostedAgentGrant } from '@stim-cli/core/state';

type Resolved = HostedAgentDriver | null | Promise<HostedAgentDriver | null>;

export type AgentAccess = { grant: HostedAgentGrant; notice?: string };

interface Entry {
  app: HostedAgentApp;
  grant: HostedAgentGrant;
  digest: Buffer;
  notice?: string;
}

export interface HostedAgentHostOptions {
  /**
   * The driver the host's `hosting.agentDriver` names right now, or null for none. Read when no driver runs. An
   * `AgentDriverUnavailable` rejection leaves the app without agent control and carries the reason to the client.
   */
  resolve: () => Resolved;
  resolveDevice?: (app: HostedAgentDevice, stopping?: boolean) => Resolved;
  /** Whether the client still has its device-host approval. */
  approved: (client: string) => boolean;
  strictStop?: boolean;
  restartDelayMs?: number;
  maxRestarts?: number;
}

const digest = (token: string): Buffer => createHash('sha256').update(token).digest();

const none = (notice?: string): AgentAccess => ({ grant: { driver: 'none' }, ...(notice ? { notice } : {}) });

/**
 * Reference-counts a driver on live hosted macOS apps and owns a separate driver lifetime per native device session. It starts the driver with the first app that gets a
 * grant and stops it after the last one, on revocation and on close. Grants live only here, in memory:
 * a driver restart drops the leases they name, so a restart issues new grants that the client reads
 * again through `app.attach`.
 */
export class HostedAgentHost {
  private readonly options: HostedAgentHostOptions;
  private readonly entries = new Map<string, Entry>();
  private active: HostedAgentDriver | null = null;
  private readonly devices = new Map<string, HostedAgentHost>();
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
    const child = this.devices.get(session);
    if (child) return child.access(session);
    const entry = this.entries.get(session);
    return entry ? { grant: entry.grant, ...(entry.notice ? { notice: entry.notice } : {}) } : undefined;
  }

  /** The session's app is installed and running. Issues its grant, starting the driver when it is the first. */
  appRunning(app: HostedAgentApp): Promise<AgentAccess> {
    return this.serialize(async () => {
      if ((app.udid !== undefined || app.serial !== undefined) && this.options.resolveDevice) {
        if (this.closed) return none();
        let child = this.devices.get(app.session);
        if (!child) {
          child = new HostedAgentHost({
            ...this.options,
            resolveDevice: undefined,
            strictStop: true,
            resolve: () => this.options.resolveDevice!(app),
          });
          this.devices.set(app.session, child);
        }
        return child.appRunning(app);
      }
      const existing = this.entries.get(app.session);
      if (
        existing &&
        existing.grant.driver !== 'none' &&
        existing.app.pid === app.pid &&
        existing.app.bundleId === app.bundleId &&
        existing.app.udid === app.udid &&
        existing.app.serial === app.serial &&
        existing.app.avdName === app.avdName
      )
        return this.access(app.session)!;
      if (existing) await this.drop(app.session, false);
      if (this.closed) return none();
      let driver: HostedAgentDriver | null;
      try {
        driver = this.active ?? (await this.options.resolve());
      } catch (error) {
        return this.remember(app, none(this.reason(error)));
      }
      if (!driver) return this.remember(app, none());
      if (this.active !== driver) {
        try {
          await driver.start();
        } catch (error) {
          if (this.options.strictStop) {
            this.active = driver;
            await this.stopDriver();
          }
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
      digest: 'token' in access.grant ? digest(access.grant.token) : Buffer.alloc(0),
      ...(access.notice ? { notice: access.notice } : {}),
    });
    return access;
  }

  private reason(error: unknown): string {
    if (error instanceof AgentDriverUnavailable) return error.message;
    process.stderr.write(`Hosted agent driver failed: ${(error as Error).message}\n`);
    return 'Agent control failed to start on the hosting Mac. Check its stim-server log.';
  }

  appStopped(session: string, device?: string | { serial: string; avdName: string }): Promise<void> {
    return this.serialize(async () => {
      let child = this.devices.get(session);
      if (!child && device && this.options.resolveDevice) {
        const driver = await this.options.resolveDevice(
          { session, ...(typeof device === 'string' ? { udid: device } : device) },
          true,
        );
        if (driver) {
          child = new HostedAgentHost({ ...this.options, resolveDevice: undefined, strictStop: true });
          child.active = driver;
          this.devices.set(session, child);
        }
      }
      if (child) {
        await child.close();
        this.devices.delete(session);
      } else await this.drop(session);
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
    if (!this.options.strictStop) this.active = null;
    if (!driver) return;
    try {
      await driver.stop();
      if (this.options.strictStop) this.active = null;
    } catch (error) {
      if (this.options.strictStop) throw error;
      process.stderr.write(`Hosted agent driver did not stop cleanly: ${(error as Error).message}\n`);
    }
  }

  private lost(driver: HostedAgentDriver): Promise<void> {
    return this.serialize(async () => {
      if (this.active !== driver || this.closed) return;
      const apps = this.live().map((entry) => entry.app);
      if (this.options.strictStop)
        for (const app of apps)
          this.remember(app, none('Agent control is restarting. Reattach to obtain a new grant.'));
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
      if (!started) {
        if (!this.options.strictStop) this.active = null;
        for (const app of apps)
          this.remember(app, none('Agent control stopped: its daemon exited and could not be restarted.'));
        return;
      }
      if (this.closed) return;
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

  /** Agent control authenticates by the session's token alone, never by the network address it arrives from. */
  authorize(session: string, token: string | null): 'ok' | 'unknown' | 'forbidden' {
    const child = this.devices.get(session);
    if (child) return child.authorize(session, token);
    const entry = this.entries.get(session);
    if (!entry || entry.grant.driver === 'none') return 'unknown';
    if (!token || !this.options.approved(entry.app.client)) return 'forbidden';
    const presented = digest(token);
    return presented.length === entry.digest.length && timingSafeEqual(presented, entry.digest) ? 'ok' : 'forbidden';
  }

  forward(
    session: string,
    token: string | null,
    request: IncomingMessage,
    response: ServerResponse,
  ): 'ok' | 'unknown' | 'forbidden' {
    const child = this.devices.get(session);
    if (child) return child.forward(session, token, request, response);
    const verdict = this.authorize(session, token);
    if (verdict === 'ok' && this.active) this.active.forward(session, request, response);
    else if (verdict === 'ok')
      response.writeHead(503, { 'content-type': 'text/plain' }).end('Agent control is not running.\n');
    else
      response
        .writeHead(verdict === 'unknown' ? 404 : 403, { 'content-type': 'text/plain' })
        .end(verdict === 'unknown' ? 'Not found.\n' : 'Forbidden.\n');
    return verdict;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.serialize(async () => {
      const children = [...this.devices.entries()];
      const results = await Promise.allSettled(children.map(([, child]) => child.close()));
      const failures: unknown[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') this.devices.delete(children[index]![0]);
        else failures.push(result.reason);
      }
      const sessions = [...this.entries.keys()];
      for (const session of sessions) await this.drop(session, false);
      try {
        await this.stopDriver();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          `Hosted agent drivers did not stop cleanly: ${failures.map((error) => (error as Error).message).join('; ')}`,
        );
    });
  }
}
