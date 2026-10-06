import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  readdirSync,
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
import { listProcesses } from './processes.ts';

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

const IOS_COMMANDS = [
  ...POLICY.commands.allow,
  'devices',
  'diff',
  'longpress',
  'swipe',
  'back',
  'home',
  'orientation',
  'appstate',
  'alert',
];

function iosPolicy(udid: string) {
  return {
    version: 1,
    devices: { allow: [{ udid }] },
    commands: { allow: IOS_COMMANDS },
    capabilities: { deny: ['device-shutdown'] },
  };
}

// agent-device ADR 0029 stores the digest of normalized policy fields in daemon.json.
function iosPolicyDigest(udid: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        devices: [udid],
        commands: { mode: 'allow', names: IOS_COMMANDS.toSorted() },
        capabilities: ['device-shutdown'],
      }),
    )
    .digest('hex');
}

/** agent-device caps a lease's inactivity window at ten minutes; the host renews well inside it. */
const LEASE_TTL_MS = 600_000;
const MAX_RPC_BYTES = 1024 * 1024;
const MAX_ECHO = 64;
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
  /** agent-device's own host or session state directory; created with mode 0700. */
  stateDir: string;
  /** Ownership claim root held for as long as the daemon runs. */
  claimRoot: string;
  ios?: { session: string; udid: string };
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
  renew?: NodeJS.Timeout;
  renewing: Promise<unknown>;
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
  private readonly options: Required<Omit<AgentDeviceDriverOptions, 'env' | 'ios'>> &
    Pick<AgentDeviceDriverOptions, 'env' | 'ios'>;
  private running: Running | null = null;
  private claim: ClaimHandle | null = null;
  private starting: Promise<void> | null = null;
  private stopping = false;
  private daemonRecord: ProcessRecord | null = null;
  private iosProxy: { child: ChildProcess; record: ProcessRecord | null } | null = null;
  private listener: (() => void) | null = null;
  private readonly leases = new Map<string, Lease>();
  private readonly released = new Set<string>();

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
    writeFileSync(policy, `${JSON.stringify(this.options.ios ? iosPolicy(this.options.ios.udid) : POLICY)}\n`, {
      mode: 0o600,
    });
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
            ...(this.options.ios ? { AGENT_DEVICE_CLAIMS_DIR: join(this.options.stateDir, 'device-claims') } : {}),
          },
          ...(this.options.ios ? { cwd: '/' } : {}),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      if (this.options.ios)
        this.iosProxy = { child: proxy, record: proxy.pid === undefined ? null : this.captured(proxy.pid) };
      const url = await this.listening(proxy);
      const { record: daemon, admin } = this.readDaemon();
      this.daemonRecord = daemon;
      const proxyIdentity = proxy.pid === undefined ? null : captureProcessIdentity(proxy.pid);
      if (!proxyIdentity?.ok) throw new Error('The agent-device proxy identity could not be captured.');
      setClaimChild(claim, daemon);
      if (!(await leasesBackend(url, this.options.ios ? 'ios-instance' : 'macos-app')))
        throw new AgentDriverUnavailable(
          this.options.ios
            ? 'Agent control requires agent-device 0.21.20 or later with the ios-instance backend and daemon policy on the hosting Mac.'
            : UNSCOPED,
        );
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
    if (this.options.ios && value.policyDigest !== iosPolicyDigest(this.options.ios.udid)) {
      this.daemonRecord = record;
      throw new AgentDriverUnavailable(
        'Agent control requires agent-device 0.21.20 or later enforcing this hosted simulator policy.',
      );
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
    const sessions = [...this.released];
    this.released.clear();
    for (const lease of this.leases.values()) clearInterval(lease.renew);
    this.leases.clear();
    const running = this.running;
    this.running = null;
    if (running) clearInterval(running.watch);
    if (running || this.claim) await this.teardown(running?.proxy, running ?? undefined);
    for (const session of sessions) this.removeSessionDirectories(session);
  }

  private async teardown(proxy?: ChildProcess, running?: Running): Promise<void> {
    proxy ??= this.iosProxy?.child;
    if (proxy?.pid !== undefined) {
      const record = running?.proxyRecord ?? (this.options.ios ? this.iosProxy?.record : this.captured(proxy.pid));
      const stopped = record
        ? await this.signalAndWait(record, true)
        : proxy.exitCode != null || proxy.signalCode != null;
      if (this.options.ios && !stopped)
        throw new Error(
          `The agent-device proxy is unresolved; its claim ${this.claim?.path} was kept. Once it is gone, clear it with: ${claimRemoveCommand(this.claim!.path)}`,
        );
    }
    await this.stopDaemon();
    await this.stopIosRunners();
    this.daemonRecord = null;
    this.iosProxy = null;
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
    if (this.iosProxy?.child.pid !== undefined && !this.daemonRecord)
      throw new Error(
        `The agent-device daemon identity is unresolved; its claim ${this.claim?.path} was kept. Once it is gone, clear it with: ${claimRemoveCommand(this.claim!.path)}`,
      );
    if (this.daemonRecord && !(await this.signalAndWait(this.daemonRecord, false)))
      throw new Error(`The agent-device daemon did not stop; its claim ${this.claim?.path} was kept.`);
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

  private async stopIosRunners(): Promise<void> {
    if (!this.options.ios) return;
    const udid = this.options.ios.udid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const destination = new RegExp(`(?:^|\\s)-destination\\s+platform=iOS Simulator,id=${udid}(?=\\s|$)`, 'i');
    const runners = (ps: string) =>
      ps.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (
          !match ||
          !/^(?:[^\n]*\/)?xcodebuild\s/.test(match[3]!) ||
          !/\stest-without-building(?:\s|$)/.test(match[3]!) ||
          !/\s-only-testing\s+AgentDeviceRunnerUITests\/RunnerTests\/testCommand(?:\s|$)/.test(match[3]!) ||
          !destination.test(match[3]!)
        )
          return [];
        return [{ pid: Number(match[1]), group: Number(match[1]) === Number(match[2]) }];
      });
    const candidates = runners(await listProcesses('pid=,pgid=,command=')).map((runner) => ({
      pid: runner.pid,
      group: runner.group,
      record: this.captured(runner.pid),
    }));
    if (!candidates.length) return;
    const current = runners(await listProcesses('pid=,pgid=,command='));
    const failures: number[] = [];
    for (const runner of candidates) {
      if (!current.some((live) => live.pid === runner.pid && live.group === runner.group)) continue;
      if (!runner.record || !(await this.signalAndWait(runner.record, runner.group))) failures.push(runner.pid);
    }
    if (failures.length)
      throw new Error(
        `The agent-device iOS runners did not stop (${failures.join(', ')}); their daemon claim ${this.claim?.path} was kept.`,
      );
  }

  /**
   * Grants one simulator's automatic ios-instance lease or allocates and renews a macos-app lease over
   * agent-device's host-only admin route. Forwarded requests are pinned to the grant's scope.
   */
  async issue(app: HostedAgentApp): Promise<HostedAgentGrant> {
    const running = this.running;
    if (!running) throw new Error('The agent-device daemon is not running.');
    if (this.options.ios) {
      if (app.session !== this.options.ios.session || app.udid !== this.options.ios.udid)
        throw new Error('The agent-device daemon belongs to another hosted simulator.');
      const scope: HostedAgentLease = {
        tenant: `stim.${app.session}`,
        runId: app.session,
        clientId: 'agent',
        deviceKey: `ios:mobile:${app.udid}`,
        backend: 'ios-instance',
      };
      this.leases.set(app.session, { id: app.session, scope, renewing: Promise.resolve() });
      return {
        driver: 'agent-device',
        path: agentRoute(app.session),
        token: newAgentToken(),
        scope: app.session,
        lease: scope,
      };
    }
    const scope: HostedAgentLease = {
      tenant: `stim.${app.session}`,
      runId: app.session,
      clientId: 'agent',
      deviceKey: `${app.bundleId}@${app.pid}`,
    };
    await this.revoke(app.session);
    const id = randomBytes(16).toString('hex');
    await putLease(running.admin, id, scope);
    const lease: Lease = {
      id,
      scope,
      renewing: Promise.resolve(),
      renew: setInterval(() => {
        if (this.running !== running) return;
        lease.renewing = putLease(running.admin, id, scope).catch((error: unknown) =>
          process.stderr.write(`Hosted agent lease renewal failed: ${(error as Error).message}\n`),
        );
      }, this.options.leaseRenewMs),
    };
    lease.renew?.unref();
    this.leases.set(app.session, lease);
    return { driver: 'agent-device', path: agentRoute(app.session), token: newAgentToken(), scope: id, lease: scope };
  }

  async revoke(session: string): Promise<void> {
    const lease = this.leases.get(session);
    if (!lease) return;
    this.leases.delete(session);
    this.released.add(session);
    clearInterval(lease.renew);
    try {
      await lease.renewing;
      if (this.running && !this.options.ios) await adminRequest(this.running.admin, 'DELETE', lease.id);
    } finally {
      this.removeSessionDirectories(session);
    }
  }

  private removeSessionDirectories(session: string): void {
    const sessionsDir = join(this.options.stateDir, 'sessions');
    try {
      for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(`stim.${session}_`)) continue;
        try {
          rmSync(join(sessionsDir, entry.name), { recursive: true, force: true });
        } catch (error) {
          process.stderr.write(
            `Hosted agent session cleanup failed: ${(error as Error).message.replace(/\s+/g, ' ')}\n`,
          );
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        process.stderr.write(`Hosted agent session cleanup failed: ${(error as Error).message.replace(/\s+/g, ' ')}\n`);
    }
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
    const pinned = pinLease(body, lease);
    if (!Buffer.isBuffer(pinned))
      response.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: pinned.id,
          error: {
            code: -32000,
            message: pinned.message,
            data: {
              code: 'UNAUTHORIZED',
              message: pinned.message,
              hint: `The hosted agent connection allows only ${(this.options.ios ? IOS_COMMANDS : POLICY.commands.allow).join(', ')} on the one ${this.options.ios ? 'hosted iOS simulator' : 'leased macOS app'}; retrying will not help.`,
              retriable: false,
              details: { reason: 'STIM_AGENT_REQUEST_REFUSED', rule: pinned.rule, ...pinned.details },
            },
          },
        }),
      );
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

interface Refusal {
  id: string | number | null;
  rule: 'command' | 'method' | 'request' | 'host-path' | 'device';
  message: string;
  details: { command?: string; method?: string };
}

/**
 * Rewrites one JSON-RPC body so it can act only under the session's lease. The proxy token is one credential
 * for every client, so the lease, its owner scope and tenant session isolation come from the host, never from
 * the client. Methods other than commands and lease renewal or release are refused.
 */
function pinLease(body: Buffer | null, lease: Lease): Buffer | Refusal {
  let rpc: unknown;
  try {
    rpc = body === null ? undefined : JSON.parse(body.toString('utf8'));
  } catch {}
  const id = isJsonObject(rpc) && (typeof rpc.id === 'string' || typeof rpc.id === 'number') ? rpc.id : null;
  if (!isJsonObject(rpc) || typeof rpc.method !== 'string' || !isJsonObject(rpc.params))
    return {
      id,
      rule: 'request',
      message:
        'Refused request: expected a JSON object with a string method and object params within the body size limit.',
      details: {},
    };
  if (lease.scope.backend === 'ios-instance') return pinIosRequest(rpc, id, lease);
  const { tenant, runId, clientId, deviceKey } = lease.scope;
  const owner = { runId, leaseId: lease.id, clientId, deviceKey, leaseProvider: 'proxy' };
  if (COMMAND_METHODS.has(rpc.method)) {
    const { runtime: _runtime, meta, flags, input, ...params } = rpc.params;
    const refuseCommand = (value: unknown) => {
      const command = typeof value === 'string' ? value.slice(0, MAX_ECHO) : undefined;
      return {
        id,
        rule: 'command' as const,
        message: `Refused command${command === undefined ? '' : ` "${command}"`}. Allowed commands: ${POLICY.commands.allow.join(', ')}.`,
        details: command === undefined ? {} : { command },
      };
    };
    if (!isAllowedCommand(params.command)) return refuseCommand(params.command);
    const steps = isJsonObject(flags) && Array.isArray(flags.batchSteps) ? flags.batchSteps : [];
    for (const step of steps)
      if (!isJsonObject(step) || !isAllowedCommand(step.command))
        return refuseCommand(isJsonObject(step) ? step.command : undefined);
    rpc.params = {
      ...params,
      flags: {
        ...withoutDeviceSelectors(flags),
        platform: 'macos',
        ...(steps.length ? { batchSteps: steps.map(pinStep) } : {}),
      },
      ...(isJsonObject(input) ? { input: withoutDeviceSelectors(input) } : {}),
      meta: {
        ...pickClientMeta(meta),
        ...owner,
        tenantId: tenant,
        leaseBackend: 'macos-app',
        sessionIsolation: 'tenant',
      },
    };
  } else if (LEASE_METHODS.has(rpc.method)) {
    const { tenant: _tenant, provider: _provider, ...params } = rpc.params;
    rpc.params = { ...params, ...owner, tenantId: tenant, backend: 'macos-app' };
  } else {
    const method = rpc.method.slice(0, MAX_ECHO);
    return { id, rule: 'method', message: `Refused method "${method}".`, details: { method } };
  }
  return Buffer.from(JSON.stringify(rpc));
}

const IOS_LEASE_METHODS = new Set([...LEASE_METHODS, 'agent_device.lease.allocate', 'agent-device.lease.allocate']);

// agent-device's buildRequestFlags sends client-local state and routing alongside command options.
const IOS_CLIENT_AMBIENT_INPUTS = [
  'cwd',
  'stateDir',
  'config',
  'remoteConfig',
  'daemonBaseUrl',
  'daemonAuthToken',
  'daemonTransport',
  'daemonServerMode',
  'tenant',
  'tenantId',
  'runId',
  'clientId',
  'deviceKey',
  'leaseBackend',
  'sessionIsolation',
  'leaseProvider',
  'provider',
];

// agent-device's macos-app lease rejects these host inputs; ios-instance does not (ADR 0007).
const HOST_INPUTS = [
  'out',
  'saveScript',
  'sessionSaveScript',
  'baseline',
  'launchConsole',
  'launchArgs',
  'launchUrl',
  'bundleUrl',
  'artifactsDir',
  'stepsFile',
  'searchPath',
  'retainPaths',
  'installSource',
  'metroProjectRoot',
  'metroRuntimeFile',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
  'developerDir',
  'artifact',
  'dsym',
  'reportJunit',
  'recordAs',
  'keyframes',
];

function pinIosRequest(rpc: Record<string, unknown>, id: Refusal['id'], lease: Lease): Buffer | Refusal {
  const params = rpc.params as Record<string, unknown>;
  const { tenant, runId, clientId, deviceKey } = lease.scope;
  const owner = { tenantId: tenant, runId, clientId, deviceKey, leaseProvider: 'proxy' };
  if (COMMAND_METHODS.has(rpc.method as string)) {
    const refusal = inspectIosCommand(params, id, deviceKey.slice('ios:mobile:'.length));
    if (refusal) return refusal;
    rpc.params = {
      ...pinIosCommand(params, deviceKey.slice('ios:mobile:'.length)),
      meta: {
        ...pickClientMeta(params.meta),
        ...owner,
        ...(isJsonObject(params.meta) && typeof params.meta.leaseId === 'string'
          ? { leaseId: params.meta.leaseId }
          : {}),
        leaseBackend: 'ios-instance',
        sessionIsolation: 'tenant',
      },
    };
  } else if (IOS_LEASE_METHODS.has(rpc.method as string)) {
    rpc.params = {
      ...owner,
      backend: 'ios-instance',
      ...(typeof params.leaseId === 'string' ? { leaseId: params.leaseId } : {}),
      ...(typeof params.session === 'string' ? { session: params.session } : {}),
      ...(typeof params.ttlMs === 'number' ? { ttlMs: params.ttlMs } : {}),
    };
  } else return { id, rule: 'method', message: 'Refused method.', details: {} };
  return Buffer.from(JSON.stringify(rpc));
}

// agent-device rewrites remote screenshot destinations to this temp shape before downloading the artifact.
function remoteScreenshot(value: unknown): boolean {
  return typeof value === 'string' && /^\/tmp\/agent-device-screenshot-\d+-[a-z0-9]+\.png$/.test(value);
}

function inspectIosCommand(params: Record<string, unknown>, id: Refusal['id'], udid: string): Refusal | null {
  const refuse = (rule: Refusal['rule'], message: string): Refusal => ({ id, rule, message, details: {} });
  if (typeof params.command !== 'string' || !IOS_COMMANDS.includes(params.command))
    return refuse(
      'command',
      'Refused command: this connection allows only hosted simulator inspection and interaction.',
    );
  const screenshot = params.command === 'screenshot';
  for (const fields of [params.flags, params.input]) {
    if (!isJsonObject(fields)) continue;
    if (typeof fields.udid === 'string' && fields.udid.trim() !== udid)
      return refuse('device', 'Another simulator is refused; this connection targets one hosted simulator.');
    if (
      HOST_INPUTS.some(
        (key) =>
          fields[key] !== undefined &&
          fields[key] !== false &&
          !(screenshot && key === 'out' && remoteScreenshot(fields[key])),
      )
    )
      return refuse('host-path', 'Host paths and launch inputs are refused.');
    if (fields.shutdown === true) return refuse('command', 'Simulator shutdown is refused; use stim stop.');
  }
  const positionals = Array.isArray(params.positionals) ? params.positionals : [];
  if (screenshot && positionals.some((value) => !remoteScreenshot(value)))
    return refuse('host-path', 'Screenshots use only agent-device remote artifacts.');
  if (
    (params.command === 'open' || params.command === 'close') &&
    positionals.some(
      (value) =>
        typeof value !== 'string' ||
        /[\\:]/.test(value) ||
        value.includes('/') ||
        value.includes(String.fromCharCode(0)),
    )
  )
    return refuse('host-path', 'Open and close accept only installed simulator app names or bundle ids.');
  for (const fields of [params.flags, params.input]) {
    if (!isJsonObject(fields) || fields.batchSteps === undefined) continue;
    if (!Array.isArray(fields.batchSteps)) return refuse('request', 'Invalid batch steps.');
    for (const step of fields.batchSteps) {
      if (!isJsonObject(step)) return refuse('request', 'Invalid batch step.');
      const failure = inspectIosCommand(step, id, udid);
      if (failure) return failure;
    }
  }
  return null;
}

function pinIosCommand(params: Record<string, unknown>, udid: string): Record<string, unknown> {
  const { runtime: _runtime, meta: _meta, flags, input, ...rest } = params;
  const fields = (value: unknown): Record<string, unknown> => {
    const source = withoutDeviceSelectors(value);
    for (const key of IOS_CLIENT_AMBIENT_INPUTS) delete source[key];
    return {
      ...source,
      platform: 'ios',
      udid,
      ...(Array.isArray(source.batchSteps)
        ? { batchSteps: source.batchSteps.map((step) => pinIosCommand(step, udid)) }
        : {}),
    };
  };
  return {
    command: rest.command,
    ...(rest.session !== undefined ? { session: rest.session } : {}),
    ...(rest.positionals !== undefined ? { positionals: rest.positionals } : {}),
    flags: fields(flags),
    ...(isJsonObject(input) ? { input: fields(input) } : {}),
  };
}

/**
 * Flags that pick a device. The host forces `platform: macos` so a first `open` cannot resolve to a host
 * simulator, emulator or phone; agent-device's `macos-app` admission enforces the same rule.
 */
const DEVICE_SELECTORS = ['device', 'udid', 'serial', 'target', 'iosSimulatorDeviceSet', 'androidDeviceAllowlist'];

function withoutDeviceSelectors(fields: unknown): Record<string, unknown> {
  if (!isJsonObject(fields)) return {};
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !DEVICE_SELECTORS.includes(key)));
}

function pinStep(step: unknown): unknown {
  if (!isJsonObject(step)) return step;
  const { runtime: _runtime, flags, input, ...rest } = step;
  return {
    ...rest,
    flags: { ...withoutDeviceSelectors(flags), platform: 'macos' },
    ...(isJsonObject(input) ? { input: withoutDeviceSelectors(input) } : {}),
  };
}

function isAllowedCommand(command: unknown): boolean {
  return typeof command === 'string' && POLICY.commands.allow.includes(command);
}

/**
 * The request metadata a client may set: reporting preferences and the local paths its own artifacts land
 * at. Host paths (`cwd`, `developerDir`), install sources, lock and lease options and runtime hints stay with
 * the host.
 */
const CLIENT_META = ['requestId', 'debug', 'includeCost', 'responseLevel', 'sessionExplicit', 'clientArtifactPaths'];

function pickClientMeta(meta: unknown): Record<string, unknown> {
  if (!isJsonObject(meta)) return {};
  return Object.fromEntries(CLIENT_META.filter((key) => meta[key] !== undefined).map((key) => [key, meta[key]]));
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

function leasesBackend(url: URL, backend: string): Promise<boolean> {
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
            resolve(Array.isArray(backends) && backends.includes(backend));
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
