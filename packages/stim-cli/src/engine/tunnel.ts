import type { StimContext } from '@stim-cli/core';
import { cancellableSleep, throwIfCancelled } from '../cancellation.ts';
import type { ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';
import { getConfigDir } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import { pidExists, signalProcessTree, signalProcessTreeAsync } from '../metro.ts';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { createLineReader } from '../process-output.ts';
import { resolveTailscaleBinary, type ManagedProvider } from './metro-reach.ts';
import { probePublicHttp } from './public-http-probe.ts';
import {
  clearClaimChild,
  markClaimChildPending,
  processGroupAlive,
  readClaimSet,
  setClaimChild,
  type ClaimHandle,
} from '../ownership-claim.ts';
import {
  withWorkspaceProcessLock,
  WorkspaceProcessCleanupError,
  workspaceProcessLockPath,
  type WorkspaceProcessLockOptions,
} from './workspace-process-lock.ts';

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

export interface TunnelRecord {
  provider: ManagedProvider;
  pid: number;
  url: string;
  port: number;
  startedAt: string;
  processToken: string | null;
  logFile?: string | null;
}

function tunnelArgv(
  provider: ManagedProvider,
  port: number,
  ngrokUrl?: string | null,
  logFile?: string | null,
  tailscaleBinary = 'tailscale',
): { bin: string; args: string[] } {
  if (provider === 'tailscale') {
    return { bin: tailscaleBinary, args: ['serve', `--https=${port}`, `http://127.0.0.1:${port}`] };
  }
  if (provider === 'cloudflared') {
    return {
      bin: 'cloudflared',
      args: ['tunnel', '--url', `http://127.0.0.1:${port}`, ...(logFile ? ['--logfile', logFile] : [])],
    };
  }
  return {
    bin: 'ngrok',
    args: [
      'http',
      String(port),
      `--log=${logFile || 'stdout'}`,
      '--log-format=json',
      ...(ngrokUrl ? ['--url', ngrokUrl] : []),
    ],
  };
}

const CLOUDFLARED_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function parseCloudflaredLine(line: string): string | null {
  // cloudflared prints the quick-tunnel URL inside a stderr banner.
  const match = line.match(CLOUDFLARED_URL_RE);
  return match ? match[0] : null;
}

export function parseNgrokLine(line: string): string | null {
  // ngrok --log-format=json emits the public URL in a line-level url field.
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const url = (data as Record<string, unknown>).url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

function parseTailscaleLine(line: string): string | null {
  return /^https:\/\/[^\s/]+\.ts\.net(:\d+)?\/?$/.test(line) ? line : null;
}

function parserFor(provider: ManagedProvider): (line: string) => string | null {
  if (provider === 'tailscale') return parseTailscaleLine;
  return provider === 'cloudflared' ? parseCloudflaredLine : parseNgrokLine;
}

const URL_TIMEOUT_MS = 15_000;

// Cloudflare quick tunnels can take minutes to become routable after printing their URL.
const REACHABLE_TIMEOUT_MS = 4 * 60_000;
const REACHABLE_POLL_MS = 2_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withManagedTunnelLock<T>(
  root: string,
  fn: (claim: ClaimHandle) => Promise<T>,
  options: WorkspaceProcessLockOptions = {},
): Promise<T> {
  const lockRoot = managedTunnelLockRoot(root);
  try {
    return await withWorkspaceProcessLock(lockRoot, 'metro-tunnel', fn, {
      ...options,
      rejectOwnerPurposes: ['workspace removal'],
    });
  } finally {
    removeEmptyDirs([join(lockRoot, '.stim'), lockRoot]);
  }
}

export async function withManagedTunnelRemovalLock<T>(
  root: string,
  fn: () => Promise<T>,
  options: WorkspaceProcessLockOptions = {},
): Promise<T> {
  const lockRoot = managedTunnelLockRoot(root);
  try {
    return await withWorkspaceProcessLock(lockRoot, 'metro-tunnel', fn, {
      ...options,
      ownerPurpose: 'workspace removal',
    });
  } finally {
    removeEmptyDirs([join(lockRoot, '.stim'), lockRoot]);
  }
}

export async function withManagedRemoteWorktreeLock<T>(
  worktreeRoot: string,
  fn: () => Promise<T>,
  options: WorkspaceProcessLockOptions = {},
): Promise<T> {
  const lockRoot = managedRemoteWorktreeLockRoot(worktreeRoot);
  try {
    return await withWorkspaceProcessLock(lockRoot, 'managed-remote', fn, {
      ...options,
      external: true,
      rejectOwnerPurposes: ['worktree removal'],
    });
  } finally {
    removeEmptyDirs([lockRoot]);
  }
}

export async function withManagedRemoteWorktreeRemovalLock<T>(
  worktreeRoot: string,
  fn: () => Promise<T>,
  options: WorkspaceProcessLockOptions = {},
): Promise<T> {
  const lockRoot = managedRemoteWorktreeLockRoot(worktreeRoot);
  try {
    return await withWorkspaceProcessLock(lockRoot, 'managed-remote', fn, {
      ...options,
      external: true,
      ownerPurpose: 'worktree removal',
    });
  } finally {
    removeEmptyDirs([lockRoot]);
  }
}

export function managedLockHolders(root: string): string[] {
  const locks = [
    { label: 'managed tunnel', path: workspaceProcessLockPath(managedTunnelLockRoot(root), 'metro-tunnel', false) },
    {
      label: 'managed remote',
      path: workspaceProcessLockPath(managedRemoteWorktreeLockRoot(root), 'managed-remote', true),
    },
  ];
  const reasons: string[] = [];
  for (const { label, path } of locks) {
    const claims = readClaimSet(path);
    const holder = claims.live[0];
    if (holder) {
      const purpose = typeof holder.details.purpose === 'string' ? ` for ${holder.details.purpose}` : '';
      reasons.push(`the ${label} lock is held${purpose}`);
    } else if (claims.unresolved[0]) {
      reasons.push(`the ${label} lock cannot be resolved: ${claims.unresolved[0].reason}`);
    }
  }
  return reasons;
}

function removeEmptyDirs(dirs: string[]): void {
  for (const dir of dirs) {
    try {
      rmdirSync(dir);
    } catch {}
  }
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

export function pruneEmptyProcessLockDirs(): number {
  const base = join(getConfigDir(), 'process-locks');
  let removed = 0;
  for (const top of childDirs(base)) {
    const entries = basename(top) === 'worktrees' ? childDirs(top) : [top];
    for (const entry of entries) {
      removeEmptyDirs(entry === top ? [join(top, '.stim'), top] : [entry]);
      if (!existsSync(entry)) removed++;
    }
  }
  return removed;
}

function managedTunnelLockRoot(root: string): string {
  const key = createHash('sha256').update(resolvePath(root)).digest('hex');
  return join(getConfigDir(), 'process-locks', key);
}

function managedRemoteWorktreeLockRoot(worktreeRoot: string): string {
  const key = createHash('sha256').update(resolvePath(worktreeRoot)).digest('hex');
  return join(getConfigDir(), 'process-locks', 'worktrees', key);
}

async function defaultProbeReachable(url: string, signal: AbortSignal): Promise<boolean> {
  const status = await probePublicHttp(url, signal);
  return status !== null && status > 0;
}

function waitForUrl(
  child: ChildProcess,
  parseLine: (line: string) => string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ url: string | null; exited: boolean; lastLine?: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let lastLine: string | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let onOut: (chunk: unknown) => void;
    let onErr: (chunk: unknown) => void;
    let onError: () => void;
    let onExit: () => void;
    const finish = (url: string | null, exited = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener('data', onOut);
      child.stderr?.removeListener('data', onErr);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      signal?.removeEventListener('abort', onAbort);
      resolve({ url, exited, lastLine });
    };
    const onAbort = () => finish(null);
    const onLine = (line: string) => {
      if (settled) return;
      if (line.trim()) lastLine = line.trim();
      const url = parseLine(line);
      if (url) finish(url);
    };
    const outReader = createLineReader(onLine);
    const errReader = createLineReader(onLine);
    onOut = (chunk: unknown) => outReader.push(chunk);
    onErr = (chunk: unknown) => errReader.push(chunk);
    onError = () => finish(null);
    onExit = () => {
      outReader.flush();
      errReader.flush();
      finish(null, true);
    };
    child.stdout?.setEncoding?.('utf-8');
    child.stderr?.setEncoding?.('utf-8');
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onErr);
    child.on('error', onError);
    child.on('exit', onExit);
    timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function waitForFileUrl(
  child: ChildProcess,
  logFile: string,
  parseLine: (line: string) => string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ url: string | null; exited: boolean; lastLine?: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let watcher: FSWatcher | null = null;
    const finish = (url: string | null, exited = false) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      clearInterval(interval);
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      signal?.removeEventListener('abort', onAbort);
      resolve({ url, exited });
    };
    const onAbort = () => finish(null);
    const probe = () => {
      try {
        for (const line of readFileSync(logFile, 'utf-8').split(/\r?\n/)) {
          const url = parseLine(line);
          if (url) return finish(url);
        }
      } catch {}
    };
    const onError = () => finish(null);
    const onExit = () => finish(null, true);
    child.on('error', onError);
    child.on('exit', onExit);
    try {
      watcher = watch(dirname(logFile), (_event, name) => {
        if (name === null || name.toString() === basename(logFile)) probe();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
      watcher.unref();
    } catch {}
    const interval = setInterval(probe, Math.min(1000, timeoutMs));
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else probe();
  });
}

function createTunnelLogFile(provider: ManagedProvider): string {
  const dir = join(getConfigDir(), 'tunnel-logs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${provider}-${randomUUID()}.log`);
  closeSync(openSync(path, 'wx', 0o600));
  return path;
}

function removeTunnelLogFile(path: string | null | undefined): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {}
}

function removeRecordedTunnelLogFile(path: string | null | undefined): void {
  if (!path) return;
  const dir = resolvePath(join(getConfigDir(), 'tunnel-logs'));
  const resolved = resolvePath(path);
  if (!resolved.startsWith(`${dir}${sep}`) || resolvePath(join(dir, basename(resolved))) !== resolved) return;
  removeTunnelLogFile(resolved);
}

async function waitUntilReachable({
  url,
  now,
  sleep,
  probe,
  timeoutMs,
  signal,
}: {
  signal?: AbortSignal;
  url: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  probe: (url: string, signal: AbortSignal) => Promise<boolean>;
  timeoutMs: number;
}): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    throwIfCancelled(signal, 'Metro tunnel startup');
    const controller = new AbortController();
    const ok = await probe(url, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal).catch(
      () => false,
    );
    throwIfCancelled(signal, 'Metro tunnel startup');
    if (ok) return true;
    if (now() >= deadline) return false;
    if (sleep === defaultSleep) await cancellableSleep(REACHABLE_POLL_MS, { signal, what: 'Metro tunnel startup' });
    else await sleep(REACHABLE_POLL_MS);
  }
}

export interface StartTunnelOptions {
  claims?: readonly ClaimHandle[];
  signal?: AbortSignal;
  provider: ManagedProvider;
  port: number;
  spawnFn?: SpawnFn | null;
  urlTimeoutMs?: number;
  reachableTimeoutMs?: number;
  probeReachable?: (url: string, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  ngrokUrl?: string | null;
  requireReachable?: boolean;
  cleanupTimeoutMs?: number;
  isChildAlive?: (pid: number) => boolean;
  readProcessToken?: (pid: number) => string | null;
  logFile?: string | null;
}

interface TunnelCleanupResult {
  status: 'stopped' | 'failed';
  reason?: string;
}

export type StartTunnelResult =
  | {
      url: string;
      pid: number;
      processToken: string;
      logFile?: string | null;
      cleanup: () => Promise<TunnelCleanupResult>;
    }
  | { failed: true; reason: string; cleanupFailed?: true };

const CLEANUP_TIMEOUT_MS = 1_000;

export async function startTunnel({
  claims = [],
  signal,
  provider,
  port,
  spawnFn = null,
  urlTimeoutMs = URL_TIMEOUT_MS,
  reachableTimeoutMs = REACHABLE_TIMEOUT_MS,
  probeReachable = defaultProbeReachable,
  now = Date.now,
  sleep = defaultSleep,
  ngrokUrl = null,
  requireReachable = true,
  cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  isChildAlive = pidExists,
  readProcessToken = captureProcessToken,
  logFile = null,
}: StartTunnelOptions): Promise<StartTunnelResult> {
  throwIfCancelled(signal, 'Metro tunnel startup');
  const spawn: SpawnFn = spawnFn || ((cmd, args, opts) => getExecutor().spawn(cmd, args, opts));
  const outputFile = provider === 'tailscale' ? null : logFile || (spawnFn ? null : createTunnelLogFile(provider));

  let child: ChildProcess;
  try {
    const binary =
      provider === 'tailscale' ? resolveTailscaleBinary((bin) => getExecutor().findExecutable(bin)) : provider;
    if (!binary) throw new Error('Install Tailscale and sign in to your tailnet.');
    const { bin, args } = tunnelArgv(provider, port, ngrokUrl, outputFile, binary);
    for (const claim of claims) markClaimChildPending(claim);
    child = spawn(bin, args, {
      stdio: outputFile ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    for (const claim of claims) clearClaimChild(claim);
    removeTunnelLogFile(outputFile);
    return { failed: true, reason: `Could not start ${provider}: ${describe(err)}` };
  }

  let childExited = false;
  let childIdentity: { pid: number; processToken: string } | null = null;
  child.once('exit', () => {
    childExited = true;
  });
  const cleanup = async (alreadyExited = childExited): Promise<TunnelCleanupResult> => {
    if (
      claims.length > 0 &&
      childIdentity &&
      process.platform !== 'win32' &&
      inspectProcessIdentity(childIdentity) === 'same'
    ) {
      try {
        signalProcessTree(childIdentity.pid, 'SIGTERM', { group: true });
      } catch {}
    }
    const stopped = await terminateChild(child, {
      alreadyExited,
      timeoutMs: cleanupTimeoutMs,
      isAlive: isChildAlive,
      waitForGroup: claims.length > 0 && process.platform !== 'win32',
    });
    const drained =
      stopped && (claims.length === 0 || process.platform === 'win32' || !child.pid || !processGroupAlive(child.pid));
    if (drained) {
      for (const claim of claims) clearClaimChild(claim);
      removeTunnelLogFile(outputFile);
    }
    return drained
      ? { status: 'stopped' }
      : {
          status: 'failed',
          reason: `Sent SIGKILL but could not confirm that pid ${child.pid ?? 'unknown'} exited.`,
        };
  };
  const failAfterCleanup = async (reason: string, alreadyExited = childExited): Promise<StartTunnelResult> => {
    const stopped = await cleanup(alreadyExited);
    if (stopped.status === 'failed')
      return { failed: true, reason: `${reason} ${stopped.reason}`, cleanupFailed: true };
    return { failed: true, reason: signal?.aborted ? 'Metro tunnel startup was cancelled.' : reason };
  };
  const pid = child.pid;
  if (!pid) {
    return failAfterCleanup(`${provider} started but reported no pid.`);
  }
  const captureChildIdentity = (): string | null => {
    try {
      return readProcessToken(pid);
    } catch {
      return null;
    }
  };
  const initialProcessToken = captureChildIdentity();
  if (!initialProcessToken) {
    return failAfterCleanup(`${provider} started but its process identity token could not be read.`);
  }
  childIdentity = { pid, processToken: initialProcessToken };
  if (claims.length > 0) {
    try {
      for (const claim of claims) setClaimChild(claim, childIdentity);
    } catch (error) {
      return failAfterCleanup(`Could not record ${provider} process ownership: ${describe(error)}`);
    }
  }

  const { url, exited, lastLine } = outputFile
    ? await waitForFileUrl(child, outputFile, parserFor(provider), urlTimeoutMs, signal)
    : await waitForUrl(child, parserFor(provider), urlTimeoutMs, signal);
  if (!url) {
    return failAfterCleanup(
      exited
        ? provider === 'tailscale' && lastLine
          ? `${provider} exited before printing a tunnel URL: ${lastLine}`
          : `${provider} exited before printing a tunnel URL.`
        : `${provider} did not print a tunnel URL within ${urlTimeoutMs}ms.`,
      exited || childExited,
    );
  }
  if (!outputFile) resumeChildPipes(child);

  if (requireReachable) {
    let reachable: boolean;
    try {
      reachable = await waitUntilReachable({
        url,
        now,
        sleep,
        probe: probeReachable,
        timeoutMs: reachableTimeoutMs,
        signal,
      });
    } catch (cause) {
      return failAfterCleanup(`Could not establish ${provider} tunnel reachability: ${describe(cause)}`);
    }
    if (!reachable) {
      return failAfterCleanup(
        `${url} did not become reachable within ${reachableTimeoutMs}ms; ${provider} may still be registering, or the network path is blocked.`,
      );
    }
  }

  if (signal?.aborted) return failAfterCleanup('Metro tunnel startup was cancelled.');
  const finalProcessToken = captureChildIdentity();
  if (!finalProcessToken || finalProcessToken !== initialProcessToken) {
    return failAfterCleanup(`${provider} process identity changed before its tunnel could be recorded.`);
  }
  if (!outputFile) unrefChildPipes(child);
  child.unref?.();
  if (childExited) {
    return failAfterCleanup(`${provider} exited before its tunnel could be recorded.`, true);
  }
  return { url, pid, processToken: initialProcessToken, logFile: outputFile, cleanup: () => cleanup() };
}

export interface StartTunnelSequenceOptions {
  claims?: readonly ClaimHandle[];
  signal?: AbortSignal;
  providers: readonly ManagedProvider[];
  port: number;
  ngrokUrl?: string | null;
  requireReachable?: boolean;
  start?: (options: StartTunnelOptions) => Promise<StartTunnelResult>;
}

export type StartTunnelSequenceResult =
  | {
      provider: ManagedProvider;
      url: string;
      pid: number;
      processToken: string;
      logFile?: string | null;
      cleanup: () => Promise<TunnelCleanupResult>;
    }
  | { failed: true; reason: string; cleanupFailed?: true };

export async function startTunnelSequence({
  claims = [],
  signal,
  providers,
  port,
  ngrokUrl = null,
  requireReachable = true,
  start = startTunnel,
}: StartTunnelSequenceOptions): Promise<StartTunnelSequenceResult> {
  const failures: string[] = [];
  for (const provider of providers) {
    if (signal?.aborted) return { failed: true, reason: 'Metro tunnel startup was cancelled.' };
    const result = await start({
      claims,
      signal,
      provider,
      port,
      ngrokUrl: provider === 'ngrok' ? ngrokUrl : null,
      requireReachable,
    });
    if (!('failed' in result)) return { provider, ...result };
    failures.push(`${provider}: ${result.reason}`);
    if (result.cleanupFailed) return { failed: true, reason: failures.join(' '), cleanupFailed: true };
  }
  return { failed: true, reason: failures.join(' ') || 'No managed tunnel provider was selected.' };
}

function closeChildPipes(child: TerminableChild): void {
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
}

function unrefChildPipes(child: ChildProcess): void {
  resumeChildPipes(child);
  for (const stream of [child.stdout, child.stderr]) {
    (stream as { unref?: () => void } | null)?.unref?.();
  }
}

function resumeChildPipes(child: ChildProcess): void {
  child.stdout?.resume?.();
  child.stderr?.resume?.();
}

function signalAndWaitForExit(
  child: TerminableChild,
  signal: NodeJS.Signals,
  {
    timeoutMs,
    isAlive,
    platform,
  }: {
    timeoutMs: number;
    isAlive: (pid: number) => boolean;
    platform: NodeJS.Platform;
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onExit = () => finish(true);
    const onError = (error: unknown) => finish(isEsrch(error));
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve(exited);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      // Package-manager shims (choco shimgen, pnpm) run the real tunnel binary as a
      // child; on win32 only taskkill /T reaches it.
      if (platform === 'win32' && child.pid) signalProcessTree(child.pid, signal, { platform });
      child.kill(signal);
    } catch (error) {
      finish(isEsrch(error));
    }
    if (!settled) timer = setTimeout(() => finish(Boolean(child.pid && !isAlive(child.pid))), timeoutMs);
  });
}

export interface TerminableChild {
  pid?: number | undefined;
  stdout: ChildProcess['stdout'];
  stderr: ChildProcess['stderr'];
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export async function terminateChild(
  child: TerminableChild,
  {
    alreadyExited,
    timeoutMs,
    isAlive,
    platform = process.platform,
    waitForGroup = false,
  }: {
    alreadyExited: boolean;
    timeoutMs: number;
    isAlive: (pid: number) => boolean;
    platform?: NodeJS.Platform;
    waitForGroup?: boolean;
  },
): Promise<boolean> {
  let stopped = alreadyExited;
  let deadline = Date.now() + timeoutMs;
  if (!stopped) stopped = await signalAndWaitForExit(child, 'SIGTERM', { timeoutMs, isAlive, platform });
  if (!stopped) {
    deadline = Date.now() + timeoutMs;
    stopped = await signalAndWaitForExit(child, 'SIGKILL', { timeoutMs, isAlive, platform });
  }
  if (stopped && waitForGroup && child.pid) {
    while (processGroupAlive(child.pid) && Date.now() < deadline) await cancellableSleep(25);
    stopped = !processGroupAlive(child.pid);
  }
  closeChildPipes(child);
  return stopped;
}

function describe(err: unknown): string {
  return (err as Error)?.message || String(err);
}

export interface StopTunnelOptions {
  operation?: StimContext;
  isAlive?: (pid: number) => boolean;
  inspectIdentity?: typeof inspectProcessIdentity;
  kill?: (pid: number) => unknown;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

export interface StopTunnelResult {
  status: 'stopped' | 'missing' | 'failed';
  reason?: string;
}

const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_MS = 100;

function isEsrch(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ESRCH';
}

export async function stopTunnel(
  record: TunnelRecord | null | undefined,
  {
    isAlive = pidExists,
    inspectIdentity = inspectProcessIdentity,
    platform = process.platform,
    operation,
    kill = (pid: number) => signalProcessTreeAsync(pid, 'SIGTERM', { platform, operation }),
    now = Date.now,
    sleep = operation
      ? (ms: number) => cancellableSleep(ms, { signal: operation.signal, what: 'tunnel stop' })
      : defaultSleep,
    timeoutMs = STOP_TIMEOUT_MS,
  }: StopTunnelOptions = {},
): Promise<StopTunnelResult> {
  operation?.signal.throwIfAborted();
  const missing = (): StopTunnelResult => {
    removeRecordedTunnelLogFile(record?.logFile);
    return { status: 'missing' };
  };
  const pid = record?.pid;
  if (!pid || !isAlive(pid)) return missing();
  if (!record.processToken) {
    return {
      status: 'failed',
      reason:
        `tunnel pid ${pid} has no process identity token, so Stim cannot verify ownership. ` +
        'Keep the record. Inspect the process, stop it with the provider tooling, remove the stale metroTunnel state, and retry.',
    };
  }

  const identity = inspectIdentity(record);
  if (identity === 'gone' || identity === 'different') return missing();
  if (identity !== 'same') {
    return {
      status: 'failed',
      reason: `could not verify the process identity for tunnel pid ${pid}; refusing to signal it.`,
    };
  }

  try {
    await kill(pid);
  } catch (err) {
    if (err instanceof WorkspaceProcessCleanupError) throw err;
    operation?.signal.throwIfAborted();
    return isEsrch(err) ? missing() : { status: 'failed', reason: describe(err) };
  }

  const deadline = now() + timeoutMs;
  const exited = () => {
    if (!isAlive(pid)) return true;
    const current = inspectIdentity(record);
    return current === 'gone' || current === 'different';
  };
  while (now() < deadline && !exited()) {
    operation?.signal.throwIfAborted();
    await sleep(STOP_POLL_MS);
  }
  operation?.signal.throwIfAborted();
  if (!exited()) return { status: 'failed', reason: `pid ${pid} did not exit within ${timeoutMs}ms.` };
  removeRecordedTunnelLogFile(record.logFile);
  return { status: 'stopped' };
}
