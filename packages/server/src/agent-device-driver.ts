import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
import { isJsonObject, type HostedAgentGrant } from '@stim-cli/core/state';
import {
  AGENT_ROUTE_PREFIX,
  AgentDriverUnavailable,
  newAgentToken,
  type HostedAgentApp,
  type HostedAgentDriver,
} from './agent-driver.ts';

/**
 * agent-device (0.21.x, upstream main) maps no remote lease backend to the macOS desktop host, so a proxy
 * client that opens an app on a Mac gets the whole desktop or nothing. Until agent-device can lease one
 * macOS app, this adapter refuses to start and to issue, and never hands out unscoped desktop access.
 */
const AGENT_DEVICE_SCOPED_MACOS_LEASE = false;

const UNSCOPED =
  'Agent control is unavailable: agent-device has no remote lease limited to one macOS app yet, and Stim never hands a client the hosting Mac desktop.';

const CANDIDATES = (home: string): string[] => [
  join(home, '.local', 'bin', 'agent-device'),
  '/opt/homebrew/bin/agent-device',
  '/usr/local/bin/agent-device',
];

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
  const candidates = CANDIDATES(env.HOME || homedir());
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      accessSync(real, constants.R_OK);
      return /\.(mjs|cjs|js)$/.test(real) ? { command: process.execPath, args: [real] } : { command: real, args: [] };
    } catch {}
  }
  throw new AgentDriverUnavailable(
    `agent-device is not installed on the hosting Mac (looked in ${candidates.join(', ')}). Install it with: npm install --global --prefix "$HOME/.local" agent-device`,
  );
}

export interface AgentDeviceDriverOptions {
  env: NodeJS.ProcessEnv;
  /** agent-device's own state directory for this host; created with mode 0700. */
  stateDir: string;
  /** Ownership claim root held for as long as the daemon runs. */
  claimRoot: string;
  scopedMacosLease?: boolean;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  watchMs?: number;
}

interface Running {
  reported: boolean;
  proxy: ChildProcess;
  proxyRecord: ProcessRecord;
  daemon: ProcessRecord;
  url: URL;
  token: string;
  watch: NodeJS.Timeout;
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

  constructor(options: AgentDeviceDriverOptions) {
    this.options = {
      startTimeoutMs: 60_000,
      stopTimeoutMs: 20_000,
      watchMs: 5000,
      ...options,
      scopedMacosLease: options.scopedMacosLease ?? AGENT_DEVICE_SCOPED_MACOS_LEASE,
    };
  }

  onExit(listener: () => void): void {
    this.listener = listener;
  }

  start(): Promise<void> {
    if (!this.options.scopedMacosLease) return Promise.reject(new AgentDriverUnavailable(UNSCOPED));
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
            AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
          },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const url = await this.listening(proxy);
      const daemon = this.readDaemon();
      this.daemonRecord = daemon;
      const proxyIdentity = proxy.pid === undefined ? null : captureProcessIdentity(proxy.pid);
      if (!proxyIdentity?.ok) throw new Error('The agent-device proxy identity could not be captured.');
      setClaimChild(claim, daemon);
      const watch = setInterval(() => this.watchDaemon(), this.options.watchMs);
      watch.unref();
      const running: Running = {
        reported: false,
        proxy,
        proxyRecord: { pid: proxy.pid, processToken: proxyIdentity.token },
        daemon,
        url,
        token,
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
          this.daemonRecord = this.readDaemon();
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

  private readDaemon(): ProcessRecord {
    const value: unknown = JSON.parse(readFileSync(join(this.options.stateDir, 'daemon.json'), 'utf8'));
    if (!isJsonObject(value) || typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid < 2)
      throw new Error('The agent-device daemon record has no pid.');
    const identity = captureProcessIdentity(value.pid);
    if (!identity.ok) throw new Error('The agent-device daemon identity could not be captured.');
    return { pid: value.pid, processToken: identity.token };
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

  issue(_app: HostedAgentApp): Promise<HostedAgentGrant> {
    return Promise.reject(new AgentDriverUnavailable(UNSCOPED));
  }

  revoke(): Promise<void> {
    return Promise.resolve();
  }

  forward(session: string, request: IncomingMessage, response: ServerResponse): void {
    const running = this.running;
    if (!running) {
      response.writeHead(503, { 'content-type': 'text/plain' }).end('Agent control is not running.\n');
      return;
    }
    const target = daemonPath(session, request.url ?? '');
    if (!target) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found.\n');
      return;
    }
    const headers: Record<string, string> = { authorization: `Bearer ${running.token}` };
    for (const name of FORWARDED) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
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
    request.pipe(upstream);
  }
}

const DAEMON_PATHS = /^\/(?:rpc|health|upload|artifacts|sessions)(?:\/[\w.~-]+)*\/?$/;

/** The proxy path behind a session route, only for the routes agent-device's proxy serves; null otherwise. */
function daemonPath(session: string, url: string): string | null {
  const prefix = `${AGENT_ROUTE_PREFIX}${session}`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const query = rest.indexOf('?');
  const path = query < 0 ? rest : rest.slice(0, query);
  return DAEMON_PATHS.test(path) && !path.includes('..') ? rest : null;
}
