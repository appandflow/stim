import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  claimRemoveCommand,
  clearClaimChild,
  markClaimChildPending,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import {
  captureProcessIdentity,
  inspectProcessIdentity,
  waitForProcessExit,
  type ProcessRecord,
} from '@stim-cli/core/process-identity';
import { isJsonObject, type HostedAgentGrant, type HostedAgentLease } from '@stim-cli/core/state';
import {
  AGENT_ROUTE_PREFIX,
  AgentDriverUnavailable,
  agentRoute,
  newAgentToken,
  type HostedAgentApp,
  type HostedAgentDriver,
} from './agent-driver.ts';

const UNSCOPED =
  'Agent control is unavailable: the agent-device on the hosting Mac has no macos-app lease to limit a client to one app, and Stim never hands a client the hosting Mac desktop.';

/** Names an agent-device binary to use instead of the fixed install locations. */
const AGENT_DEVICE_BIN_ENV = 'STIM_AGENT_DEVICE_BIN';

const CANDIDATES = (home: string): string[] => [
  join(home, '.local', 'bin', 'agent-device'),
  '/opt/homebrew/bin/agent-device',
  '/usr/local/bin/agent-device',
];

/**
 * The daemon policy Stim starts agent-device with (agent-device ADR 0029): every request must run under a
 * host-allocated `macos-app` lease, and only these commands run at all.
 */
const POLICY = {
  version: 1,
  leases: { require: 'macos-app' },
  commands: {
    allow: [
      'open',
      'close',
      'snapshot',
      'diff',
      'wait',
      'find',
      'get',
      'is',
      'click',
      'fill',
      'press',
      'type',
      'focus',
      'scroll',
      'screenshot',
      'batch',
    ],
  },
};

/** agent-device caps a lease's inactivity window at ten minutes; the host renews well inside it. */
const LEASE_TTL_MS = 600_000;
const MAX_RPC_BYTES = 1024 * 1024;
const COMMAND_METHODS = new Set(['agent_device.command', 'agent-device.command']);
const LEASE_METHODS = new Set([
  'agent_device.lease.heartbeat',
  'agent-device.lease.heartbeat',
  'agent_device.lease.release',
  'agent-device.lease.release',
]);

export interface AgentDeviceInvocation {
  command: string;
  args: string[];
}

/**
 * Finds agent-device at a fixed path: the stim-server LaunchAgent's PATH holds only system directories, and
 * agent-device's `#!/usr/bin/env node` script cannot find Node there, so a JavaScript entry runs under the
 * server's own Node.
 */
export function resolveAgentDevice(env: NodeJS.ProcessEnv): AgentDeviceInvocation {
  const explicit = env[AGENT_DEVICE_BIN_ENV]?.trim();
  const candidates = explicit ? [explicit] : CANDIDATES(env.HOME || homedir());
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      accessSync(real, constants.R_OK);
      return /\.(mjs|cjs|js)$/.test(real) ? { command: process.execPath, args: [real] } : { command: real, args: [] };
    } catch {}
  }
  throw new AgentDriverUnavailable(
    explicit
      ? `${AGENT_DEVICE_BIN_ENV} names ${explicit}, which is not a readable agent-device on the hosting Mac.`
      : `agent-device is not installed on the hosting Mac (looked in ${candidates.join(', ')}). Install it with: npm install --global --prefix "$HOME/.local" agent-device`,
  );
}

export interface AgentDeviceDriverOptions {
  env: NodeJS.ProcessEnv;
  /** agent-device's own state directory for this host; created with mode 0700. */
  stateDir: string;
  /** Ownership claim root held for as long as the daemon runs. */
  claimRoot: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  watchMs?: number;
  leaseRenewMs?: number;
}

interface Running {
  reported: boolean;
  proxy: ChildProcess;
  proxyRecord: ProcessRecord;
  daemon: ProcessRecord;
  url: URL;
  token: string;
  admin: DaemonAdmin;
  watch: NodeJS.Timeout;
}

/** The daemon's own loopback listener and token, which serve agent-device's host-only `/admin` routes. */
interface DaemonAdmin {
  port: number;
  token: string;
}

interface Lease {
  id: string;
  scope: HostedAgentLease;
  renew: NodeJS.Timeout;
}

const FORWARDED = [
  'content-type',
  'content-length',
  'content-range',
  'range',
  'accept',
  'x-request-id',
  'x-artifact-type',
  'x-artifact-filename',
  'x-artifact-hash',
  'x-artifact-hash-algorithm',
];
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate']);
const LISTENING = /Proxy listening at (http:\/\/127\.0\.0\.1:\d+)/;

export class AgentDeviceDriver implements HostedAgentDriver {
  readonly name = 'agent-device';
  private readonly options: Required<Omit<AgentDeviceDriverOptions, 'env'>> & { env: NodeJS.ProcessEnv };
  private running: Running | null = null;
  private claim: ClaimHandle | null = null;
  private starting: Promise<void> | null = null;
  private stopping = false;
  private daemonRecord: ProcessRecord | null = null;
  private listener: (() => void) | null = null;
  private readonly leases = new Map<string, Lease>();

  constructor(options: AgentDeviceDriverOptions) {
    this.options = {
      startTimeoutMs: 60_000,
      stopTimeoutMs: 20_000,
      watchMs: 5000,
      leaseRenewMs: 120_000,
      ...options,
    };
  }

  onExit(listener: () => void): void {
    this.listener = listener;
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    if (this.claim) {
      try {
        await this.teardown();
      } catch {
        throw new Error(
          `The previous agent-device daemon is unresolved. Once it is gone, clear its claim with: ${claimRemoveCommand(this.claim.path)}`,
        );
      }
    }
    const invocation = resolveAgentDevice(this.options.env);
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(this.options.stateDir, 0o700);
    const attempt = tryAcquireClaim({ root: this.options.claimRoot, mode: 'exclusive', label: 'agent-device daemon' });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired)
      throw new Error(`The agent-device daemon is held by another process: ${this.options.claimRoot}`);
    const claim = attempt.acquired;
    this.claim = claim;
    this.stopping = false;
    rmSync(join(this.options.stateDir, 'daemon.json'), { force: true });
    const policy = join(this.options.stateDir, 'policy.json');
    writeFileSync(policy, `${JSON.stringify(POLICY)}\n`, { mode: 0o600 });
    markClaimChildPending(claim);
    const token = newAgentToken();
    let proxy: ChildProcess | undefined;
    try {
      proxy = spawn(
        invocation.command,
        [...invocation.args, 'proxy', '--host', '127.0.0.1', '--state-dir', this.options.stateDir],
        {
          env: {
            ...this.options.env,
            PATH: [dirname(process.execPath), this.options.env.PATH].filter(Boolean).join(delimiter),
            AGENT_DEVICE_DAEMON_AUTH_TOKEN: token,
            AGENT_DEVICE_DAEMON_POLICY: policy,
            AGENT_DEVICE_MACOS_APP_BACKEND: 'native',
            AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
          },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const url = await this.listening(proxy);
      const { record: daemon, admin } = this.readDaemon();
      this.daemonRecord = daemon;
      const proxyIdentity = proxy.pid === undefined ? null : captureProcessIdentity(proxy.pid);
      if (!proxyIdentity?.ok) throw new Error('The agent-device proxy identity could not be captured.');
      setClaimChild(claim, daemon);
      if (!(await leasesMacosApps(url))) throw new AgentDriverUnavailable(UNSCOPED);
      const watch = setInterval(() => this.watchDaemon(), this.options.watchMs);
      watch.unref();
      const running: Running = {
        reported: false,
        proxy,
        proxyRecord: { pid: proxy.pid, processToken: proxyIdentity.token },
        daemon,
        url,
        token,
        admin,
        watch,
      };
      this.running = running;
      proxy.once('exit', () => {
        if (this.running === running) this.exited();
      });
    } catch (error) {
      this.running = null;
      if (!this.daemonRecord) {
        try {
          this.daemonRecord = this.readDaemon().record;
        } catch {}
      }
      await this.teardown(proxy).catch(() => undefined);
      throw error;
    }
  }

  private listening(proxy: ChildProcess): Promise<URL> {
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => finish(new Error('The agent-device proxy did not report a listening address.')),
        this.options.startTimeoutMs,
      );
      const finish = (result: Error | URL) => {
        clearTimeout(timer);
        proxy.stdout?.off('data', onData);
        proxy.off('exit', onExit);
        proxy.off('error', finish);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        const match = LISTENING.exec(output);
        if (match) finish(new URL(match[1]!));
      };
      const onExit = (code: number | null) =>
        finish(new Error(`The agent-device proxy exited with ${String(code)} before it was ready.`));
      proxy.stdout?.on('data', onData);
      proxy.stderr?.resume();
      proxy.once('exit', onExit);
      proxy.once('error', finish);
    });
  }

  private readDaemon(): { record: ProcessRecord; admin: DaemonAdmin } {
    const value: unknown = JSON.parse(readFileSync(join(this.options.stateDir, 'daemon.json'), 'utf8'));
    if (!isJsonObject(value) || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid < 2)
      throw new Error('The agent-device daemon record has no pid.');
    const identity = captureProcessIdentity(value.pid);
    if (!identity.ok) throw new Error('The agent-device daemon identity could not be captured.');
    const record = { pid: value.pid, processToken: identity.token };
    if (
      typeof value.httpPort !== 'number' ||
      !Number.isInteger(value.httpPort) ||
      typeof value.token !== 'string' ||
      !value.token
    ) {
      this.daemonRecord = record;
      throw new Error('The agent-device daemon record has no HTTP listener.');
    }
    return { record, admin: { port: value.httpPort, token: value.token } };
  }

  private watchDaemon(): void {
    const running = this.running;
    if (running && !this.stopping && inspectProcessIdentity(running.daemon) === 'gone') this.exited();
  }

  private exited(): void {
    const running = this.running;
    if (this.stopping || !running || running.reported) return;
    running.reported = true;
    clearInterval(running.watch);
    this.listener?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.starting?.catch(() => undefined);
    for (const lease of this.leases.values()) clearInterval(lease.renew);
    this.leases.clear();
    const running = this.running;
    if (!running && !this.claim) return;
    this.running = null;
    if (running) clearInterval(running.watch);
    await this.teardown(running?.proxy, running ?? undefined);
  }

  private async teardown(proxy?: ChildProcess, running?: Running): Promise<void> {
    if (proxy?.pid !== undefined) {
      const record = running?.proxyRecord ?? this.captured(proxy.pid);
      if (record) await this.signalAndWait(record, true);
    }
    await this.stopDaemon();
    if (!this.claim) return;
    clearClaimChild(this.claim);
    if (!releaseClaim(this.claim)) throw new Error(`The agent-device claim could not be released: ${this.claim.path}`);
    this.claim = null;
  }

  private captured(pid: number): ProcessRecord | null {
    const identity = captureProcessIdentity(pid);
    return identity.ok ? { pid, processToken: identity.token } : null;
  }

  private async stopDaemon(): Promise<void> {
    try {
      const invocation = resolveAgentDevice(this.options.env);
      await new Promise<void>((resolve) => {
        execFile(
          invocation.command,
          [...invocation.args, 'daemon', 'stop', '--state-dir', this.options.stateDir],
          { env: { ...this.options.env, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' }, timeout: this.options.stopTimeoutMs },
          () => resolve(),
        );
      });
    } catch {}
    if (this.daemonRecord && !(await this.signalAndWait(this.daemonRecord, false)))
      throw new Error('The agent-device daemon did not stop; its claim was kept.');
    this.daemonRecord = null;
  }

  private async signalAndWait(record: ProcessRecord, group: boolean): Promise<boolean> {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const status = inspectProcessIdentity(record);
      if (status === 'gone' || status === 'different') return true;
      if (status === 'same') {
        try {
          process.kill(group ? -(record.pid as number) : (record.pid as number), signal);
        } catch {}
      }
      if (await waitForProcessExit(record, signal === 'SIGTERM' ? 3000 : 2000)) return true;
    }
    return false;
  }

  /**
   * Allocates a `macos-app` lease for exactly this app process over agent-device's host-only admin route, and
   * renews it for as long as the app is hosted. The client names the lease; the forward pins it.
   */
  async issue(app: HostedAgentApp): Promise<HostedAgentGrant> {
    const running = this.running;
    if (!running) throw new Error('The agent-device daemon is not running.');
    const scope: HostedAgentLease = {
      tenant: `stim.${app.session}`,
      runId: app.session,
      clientId: 'agent',
      deviceKey: `${app.bundleId}@${app.pid}`,
    };
    const id = randomBytes(16).toString('hex');
    await putLease(running.admin, id, scope);
    await this.revoke(app.session);
    const renew = setInterval(() => {
      if (this.running !== running) return;
      putLease(running.admin, id, scope).catch((error: unknown) =>
        process.stderr.write(`Hosted agent lease renewal failed: ${(error as Error).message}\n`),
      );
    }, this.options.leaseRenewMs);
    renew.unref();
    this.leases.set(app.session, { id, scope, renew });
    return { driver: 'agent-device', path: agentRoute(app.session), token: newAgentToken(), scope: id, lease: scope };
  }

  async revoke(session: string): Promise<void> {
    const lease = this.leases.get(session);
    if (!lease) return;
    this.leases.delete(session);
    clearInterval(lease.renew);
    if (this.running) await adminRequest(this.running.admin, 'DELETE', lease.id);
  }

  forward(session: string, request: IncomingMessage, response: ServerResponse): void {
    const running = this.running;
    const lease = this.leases.get(session);
    if (!running || !lease) {
      response.writeHead(503, { 'content-type': 'text/plain' }).end('Agent control is not running.\n');
      return;
    }
    const target = daemonPath(session, request.url ?? '', request.method);
    if (!target) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found.\n');
      return;
    }
    if (!target.startsWith('/rpc')) {
      this.relay(running, lease, request, response, target);
      return;
    }
    void this.relayPinned(running, lease, request, response, target);
  }

  private async relayPinned(
    running: Running,
    lease: Lease,
    request: IncomingMessage,
    response: ServerResponse,
    target: string,
  ): Promise<void> {
    let body: Buffer | null;
    try {
      body = await readBody(request, MAX_RPC_BYTES);
    } catch {
      response.destroy();
      return;
    }
    const pinned = body === null ? null : pinLease(body, lease);
    if (pinned === null) response.writeHead(400, { 'content-type': 'text/plain' }).end('Unsupported request.\n');
    else this.relay(running, lease, request, response, target, pinned);
  }

  private relay(
    running: Running,
    lease: Lease,
    request: IncomingMessage,
    response: ServerResponse,
    target: string,
    body?: Buffer,
  ): void {
    const headers: Record<string, string> = {
      authorization: `Bearer ${running.token}`,
      'x-agent-device-tenant': lease.scope.tenant,
    };
    for (const name of FORWARDED) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    if (body) headers['content-length'] = String(body.length);
    const upstream = httpRequest(
      { host: running.url.hostname, port: running.url.port, method: request.method, path: target, headers },
      (answer) => {
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(answer.headers))
          if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
        response.writeHead(answer.statusCode ?? 502, out);
        answer.pipe(response);
        answer.once('error', () => response.destroy());
      },
    );
    upstream.once('error', () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { 'content-type': 'text/plain' }).end('Agent control is unavailable.\n');
    });
    response.once('close', () => {
      if (!response.writableFinished) upstream.destroy();
    });
    if (body) upstream.end(body);
    else request.pipe(upstream);
  }
}

/**
 * Rewrites one JSON-RPC body so it can act only under the session's lease. The proxy token is one credential
 * for every client, so the lease, its owner scope and tenant session isolation come from the host, never from
 * the client. Methods other than commands and lease renewal or release are refused.
 */
function pinLease(body: Buffer, lease: Lease): Buffer | null {
  let rpc: unknown;
  try {
    rpc = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!isJsonObject(rpc) || typeof rpc.method !== 'string' || !isJsonObject(rpc.params)) return null;
  const { tenant, runId, clientId, deviceKey } = lease.scope;
  const owner = { runId, leaseId: lease.id, clientId, deviceKey, leaseProvider: 'proxy' };
  if (COMMAND_METHODS.has(rpc.method)) {
    const meta = isJsonObject(rpc.params.meta) ? rpc.params.meta : {};
    rpc.params = {
      ...rpc.params,
      meta: { ...meta, ...owner, tenantId: tenant, leaseBackend: 'macos-app', sessionIsolation: 'tenant' },
    };
  } else if (LEASE_METHODS.has(rpc.method)) {
    const { tenant: _tenant, provider: _provider, ...params } = rpc.params;
    rpc.params = { ...params, ...owner, tenantId: tenant, backend: 'macos-app' };
  } else return null;
  return Buffer.from(JSON.stringify(rpc));
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    request.once('end', () => resolve(size > limit ? null : Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

/** Whether the daemon behind a proxy advertises agent-device's `macos-app` lease backend in `/health`. */
function leasesMacosApps(url: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = httpRequest(
      { host: url.hostname, port: url.port, method: 'GET', path: '/health', timeout: 10_000 },
      (answer) => {
        let text = '';
        answer.on('data', (chunk: Buffer) => (text += chunk.toString()));
        answer.once('end', () => {
          try {
            const health: unknown = JSON.parse(text);
            const backends =
              isJsonObject(health) && isJsonObject(health.upstream) ? health.upstream.leaseBackends : null;
            resolve(Array.isArray(backends) && backends.includes('macos-app'));
          } catch {
            resolve(false);
          }
        });
      },
    );
    probe.once('timeout', () => probe.destroy());
    probe.once('error', () => resolve(false));
    probe.end();
  });
}

function putLease(admin: DaemonAdmin, id: string, scope: HostedAgentLease): Promise<void> {
  return adminRequest(admin, 'PUT', id, {
    tenantId: scope.tenant,
    runId: scope.runId,
    clientId: scope.clientId,
    leaseBackend: 'macos-app',
    leaseProvider: 'proxy',
    deviceKey: scope.deviceKey,
    ttlMs: LEASE_TTL_MS,
  });
}

/** One call to agent-device's host-only `/admin/leases` route on the daemon's loopback listener. */
function adminRequest(admin: DaemonAdmin, method: 'PUT' | 'DELETE', id: string, body?: object): Promise<void> {
  const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        host: '127.0.0.1',
        port: admin.port,
        method,
        path: `/admin/leases/${id}`,
        timeout: 10_000,
        headers: {
          authorization: `Bearer ${admin.token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        },
      },
      (answer) => {
        let text = '';
        answer.on('data', (chunk: Buffer) => (text += chunk.toString()));
        answer.once('end', () =>
          answer.statusCode === 200
            ? resolve()
            : reject(new Error(`agent-device refused the lease (${String(answer.statusCode)}): ${text.slice(0, 200)}`)),
        );
      },
    );
    call.once('timeout', () => call.destroy(new Error('agent-device did not answer the lease request.')));
    call.once('error', reject);
    call.end(payload);
  });
}

const DAEMON_PATHS = /^\/(?:rpc|health|artifacts)(?:\/[\w.~-]+)*\/?$/;

/**
 * The proxy path behind a session route, only for commands (`/rpc`), health and artifact downloads; null
 * otherwise. Uploads serve installs, which a macos-app lease refuses, and session diagnostics are not scoped
 * to one client.
 */
function daemonPath(session: string, url: string, method: string | undefined): string | null {
  const prefix = `${AGENT_ROUTE_PREFIX}${session}`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const query = rest.indexOf('?');
  const path = query < 0 ? rest : rest.slice(0, query);
  if (!DAEMON_PATHS.test(path) || path.includes('..')) return null;
  return (path.startsWith('/rpc') ? method === 'POST' : method === 'GET') ? rest : null;
}
