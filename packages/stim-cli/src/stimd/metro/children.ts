import { closeSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { IDLE_STOP_KEY, isJsonObject, readJsonObject } from '@stim-cli/core/state';
import {
  markClaimChildPending,
  processGroupAlive,
  readClaimSet,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  updateClaimDetails,
  type ClaimHandle,
  type ClaimHolder,
} from '@stim-cli/core/ownership-claim';
import { getExecutor } from '../../exec.ts';
import { recordForeignMetro, resolveProjectMetro, signalProcessTree } from '../../metro.ts';
import { createNdjsonWriter, type NdjsonWriter } from '../../ndjson.ts';
import { isMetroRunning } from '../../ports.ts';
import { captureProcessToken, inspectProcessIdentity } from '../../process-identity.ts';
import { resolveMetroSharedCache } from '../../optimizations.ts';
import { clearSupervisor, loadConfig, setSupervisor } from '../../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../../workspace/paths.ts';
import { detectIsExpo } from '../../workspace/project.ts';
import { idleMinutesSetting, resolveProjectSettings, runnableMetroCommand } from '../../workspace/settings.ts';
import { clearWorkspaceStateKeys, writeWorkspaceState } from '../../workspace/workspace-state.ts';
import { ownStoreEngine } from '../../daemon/engine-switch.ts';
import type { ManagedProvider } from '../../engine/metro-reach.ts';
import { metroRequestAt } from '../passes/idle-stop.ts';
import {
  childRecords,
  openChildOutput,
  superviseChildServer,
  tailChildOutput,
  type ChildOutput,
  type ChildServerHandle,
} from './child-server.ts';
import { workspaceIdleProbe } from './idle-stop.ts';
import { injectedDigest, injectedDir } from './injected.ts';
import { metroStoreRoot, registerMetroStore } from './metro-store.ts';
import { projectNodeLine, withProjectNode } from './project-node.ts';
import { startCommandServer } from './server-command.ts';
import { recordFromLine, repositoryRoot, startExpoServer } from './server-expo.ts';
import { clearWorkspaceSupervisor, MODE_BARE, MODE_COMMAND, MODE_EXPO } from './state.ts';

type Log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, msg: string) => void;
type Answer = Record<string, unknown>;

const HEARTBEAT_FRESH_MS = 3000;
const PROBE_MS = 500;
const READY_MS = 120_000;
const STOP_MS = 5000;
const IDLE_POINT_MS = 2 * 60_000;
const GROUPS = process.platform !== 'win32';
const PROVIDERS: ManagedProvider[] = ['cloudflared', 'ngrok', 'tailscale'];

interface MetroChild {
  root: string;
  port: number;
  mode: string;
  digest: string | null;
  pid: number;
  processToken: string;
  startedAt: string;
  claim: ClaimHandle;
  writer: NdjsonWriter;
  /** The handle of a child this stimd spawned; null for one it adopted from an earlier stimd. */
  handle: ChildServerHandle | null;
  stopTail: (() => void) | null;
  gone: boolean;
}

interface TunnelChild {
  claim: ClaimHandle;
  pid: number;
  processToken: string;
  url: string;
}

const children = new Map<string, MetroChild>();
const tunnels = new Map<string, TunnelChild>();
const busy = new Map<string, Promise<Answer>>();

const claimRoot = (root: string, kind: 'metro' | 'tunnel') => join(workspaceDir(root), `${kind}.claim`);
const heartbeatFile = (root: string) => join(workspaceDir(root), 'metro.heartbeat');
const outputFiles = (root: string): ChildOutput => ({
  stdout: join(workspaceLogsDir(root), 'metro.stdout.log'),
  stderr: join(workspaceLogsDir(root), 'metro.stderr.log'),
});

/** The child's `metro.ndjson` writer, which stamps its records with the child's injected digest. */
function metroWriter(root: string, digest: string | null): NdjsonWriter {
  // compat C6 permanent
  const fields = digest ? { inj: digest } : {};
  // compat end
  return createNdjsonWriter(join(workspaceLogsDir(root), 'metro.ndjson'), { maxBytes: LOG_ROTATE_BYTES, fields });
}

function heartbeatFresh(child: MetroChild, now = Date.now()): boolean {
  if (child.mode === MODE_COMMAND) return false;
  const beat = readJsonObject(heartbeatFile(child.root));
  return beat !== null && beat.port === child.port && now - Number(beat.at) < HEARTBEAT_FRESH_MS;
}

/** Whether the child still runs: its handle's exit state when this stimd spawned it, its identity when adopted. */
function running(child: MetroChild): boolean {
  if (child.gone) return false;
  if (child.handle) return child.handle.child.exitCode === null && child.handle.child.signalCode === null;
  return inspectProcessIdentity(child) === 'same';
}

function answer(child: MetroChild, state = 'running'): Answer {
  const own = injectedDigest();
  return {
    op: 'metro',
    state,
    pid: child.pid,
    port: child.port,
    mode: child.mode,
    // compat C6 permanent
    ...(child.digest !== own ? { foreign: true } : {}),
    // compat end
  };
}

function lastLine(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').at(-1)?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Forgets a child that exited or was stopped: its record, its claim and its tail. */
function forget(child: MetroChild, msg: string, level: 'info' | 'warn' = 'info'): void {
  if (child.gone) return;
  child.gone = true;
  child.stopTail?.();
  if (children.get(child.root) === child) children.delete(child.root);
  const identity = { pid: child.pid, processToken: child.processToken };
  try {
    clearWorkspaceSupervisor(child.root, identity);
    clearSupervisor(child.root, identity);
  } catch {}
  rmSync(heartbeatFile(child.root), { force: true });
  releaseClaim(child.claim);
  child.writer.write({ src: 'metro', level, event: 'supervisor_stopped', msg });
  child.writer.close();
}

async function stopChild(child: MetroChild, why: string): Promise<void> {
  if (child.handle) await child.handle.close();
  else if (running(child)) {
    const signal = (sig: NodeJS.Signals) => {
      try {
        signalProcessTree(child.pid, sig, { group: GROUPS });
      } catch {}
    };
    const alive = () => (GROUPS ? processGroupAlive(child.pid) : running(child));
    signal('SIGTERM');
    for (const deadline = Date.now() + STOP_MS; alive() && Date.now() < deadline;)
      await new Promise((done) => setTimeout(done, 50));
    if (alive()) signal('SIGKILL');
  }
  forget(child, `stimd stopped the ${child.mode} dev server: ${why}`);
}

/** Records a running child where `status`, `stop`, the idle stage, Desktop and `machine-usage` look for a dev server. */
function record(child: MetroChild, hmrUpdates: boolean): void {
  const entry = {
    pid: child.pid,
    processToken: child.processToken,
    port: child.port,
    mode: child.mode,
    startedAt: child.startedAt,
    ...(hmrUpdates ? { hmrUpdates } : {}),
  };
  writeWorkspaceState(child.root, { supervisor: entry });
  clearWorkspaceStateKeys(child.root, [IDLE_STOP_KEY]);
  setSupervisor(child.root, entry);
}

function spawnHost(
  root: string,
  port: number,
  output: { files: ChildOutput; fds: [number, number] },
  env: Record<string, string>,
  writer: NdjsonWriter,
): ChildServerHandle {
  const settings = resolveProjectSettings(root).settings;
  const storeRoot = resolveMetroSharedCache(settings) ? metroStoreRoot(root) : null;
  if (storeRoot) registerMetroStore(storeRoot);
  const node = withProjectNode(root, process.env, { top: repositoryRoot(root) ?? root });
  if (node.pinned)
    writer.write({
      src: 'metro',
      level: 'info',
      event: 'project_node',
      msg: `Metro runs on ${projectNodeLine(node.pinned)}`,
    });
  const args = [
    join(injectedDir() ?? '', 'metro-host.cjs'),
    '--root',
    root,
    '--port',
    String(port),
    '--logs-dir',
    workspaceLogsDir(root),
    '--heartbeat',
    heartbeatFile(root),
    ...(storeRoot ? ['--store-root', storeRoot] : []),
  ];
  const child = getExecutor().spawn('node', args, {
    cwd: root,
    stdio: ['ignore', ...output.fds],
    detached: GROUPS,
    env: { ...node.env, FORCE_COLOR: '0', ...env },
  });
  return superviseChildServer({
    mode: MODE_BARE,
    child,
    log: writer,
    toRecord: (chunk, stream) => {
      const entry = recordFromLine(chunk, { stream });
      return entry?.raw ? { ...entry, event: `host_${stream}` } : entry;
    },
    signal: (sig) => {
      try {
        return child.pid !== undefined && signalProcessTree(child.pid, sig, { group: GROUPS });
      } catch {
        return false;
      }
    },
    alive: GROUPS ? () => child.pid !== undefined && processGroupAlive(child.pid) : null,
    killTimeoutMs: STOP_MS,
    output: output.files,
  });
}

async function start(root: string, port: number, log: Log): Promise<Answer> {
  ensureWorkspaceStorage(root);
  const logsDir = workspaceLogsDir(root);
  mkdirSync(logsDir, { recursive: true });
  const settings = resolveProjectSettings(root).settings;
  const command = runnableMetroCommand(settings);
  const mode = command ? MODE_COMMAND : detectIsExpo(root) ? MODE_EXPO : MODE_BARE;
  const digest = injectedDigest();
  const details = { port, mode, digest, engineDir: ownStoreEngine()?.build ?? null };
  const attempt = tryAcquireClaim({ root: claimRoot(root, 'metro'), mode: 'exclusive', label: 'Metro', details });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired)
    return { op: 'error', code: 'metro-claimed', message: `another process holds ${claimRoot(root, 'metro')}` };
  const claim = attempt.acquired;
  rmSync(heartbeatFile(root), { force: true });
  const writer = metroWriter(root, digest);
  const env = {
    STIM_METRO_HEARTBEAT: heartbeatFile(root),
    STIM_METRO_PORT: String(port),
    ...(digest ? { STIM_INJECTED_DIGEST: digest } : {}),
  };
  const output = openChildOutput(logsDir);
  let handle: ChildServerHandle;
  try {
    if (GROUPS) markClaimChildPending(claim);
    handle = command
      ? await startCommandServer({
          root,
          port,
          logsDir,
          command,
          writer: writer,
          output,
          extraEnv: env,
        })
      : mode === MODE_EXPO
        ? await startExpoServer({ root, port, logsDir, writer: writer, settings, output, extraEnv: env })
        : spawnHost(root, port, output, env, writer);
  } catch (error) {
    releaseClaim(claim);
    writer.close();
    return { op: 'error', code: 'metro-start', message: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const fd of output.fds) closeSync(fd);
  }
  const pid = handle.serverPid;
  const processToken = pid ? captureProcessToken(pid) : null;
  if (!pid || !processToken) {
    await handle.close().catch(() => {});
    releaseClaim(claim);
    writer.close();
    return {
      op: 'error',
      code: 'metro-start',
      message: 'the dev server started but its process identity could not be read',
    };
  }
  if (GROUPS) {
    setClaimChild(claim, { pid, processToken });
    handle.child.unref();
  }
  const child: MetroChild = {
    root,
    port,
    mode,
    digest,
    pid,
    processToken,
    claim,
    writer,
    handle,
    startedAt: new Date().toISOString(),
    stopTail: null,
    gone: false,
  };
  children.set(root, child);
  record(child, handle.observesRequests === true || mode === MODE_BARE);
  recordForeignMetro(root, port, {});
  handle.onExit((info) =>
    forget(
      child,
      `the ${mode} dev server exited (code ${info?.code ?? 'none'}, signal ${info?.signal ?? 'none'})`,
      'warn',
    ),
  );
  writer.write({
    src: 'metro',
    level: 'info',
    event: 'supervisor_started',
    msg: `stimd started the ${mode} dev server pid ${pid} on port ${port} for ${root}`,
  });
  log('info', 'metro_started', `${root}: the ${mode} dev server pid ${pid} on port ${port}`);
  for (const deadline = Date.now() + READY_MS; Date.now() < deadline;) {
    if (!running(child))
      return {
        op: 'error',
        code: 'metro-exited',
        message: lastLine(output.files.stderr) || 'the dev server exited before it answered',
      };
    if (mode === MODE_BARE ? heartbeatFresh(child) : await isMetroRunning(port, AbortSignal.timeout(PROBE_MS)))
      return answer(child, 'started');
    await new Promise((done) => setTimeout(done, 100));
  }
  return answer(child, 'starting');
}

async function ensure(root: string, port: number, launch: boolean, log: Log): Promise<Answer> {
  const child = children.get(root);
  if (child && child.port === port && running(child)) {
    // compat C6 permanent
    if (launch && child.digest !== injectedDigest())
      await stopChild(child, 'a launch restarts a Metro of other injected files');
    // compat end
    else if (heartbeatFresh(child) || (await isMetroRunning(port, AbortSignal.timeout(PROBE_MS)))) return answer(child);
    else await stopChild(child, `no heartbeat for ${HEARTBEAT_FRESH_MS / 1000} s and /status did not answer`);
  } else if (child)
    await stopChild(child, child.port === port ? 'it no longer runs' : `the workspace now uses port ${port}`);
  const found = await resolveProjectMetro(port, root);
  if (found.metro) {
    recordForeignMetro(root, port, found);
    return { op: 'metro', state: found.metro.processToken ? 'supervisor' : 'foreign', pid: found.metro.pid, port };
  }
  if (found.notOurs) return { op: 'error', code: 'port-taken', message: found.notOurs };
  return start(root, port, log);
}

/**
 * `metro.ensure {root, port?, launch?}`: makes sure the workspace's Metro runs as a child of this stimd and answers
 * `{op: 'metro', state, pid, port, mode}`. A spawned child whose handle runs and whose heartbeat is under 3 s old
 * answers at once; a stale heartbeat probes `/status` for 500 ms and restarts Metro when it fails. A Metro on the port
 * that runs from the project and that Stim did not start is reused and recorded in `metro.foreign.json`. With
 * `launch`, a Metro of other injected files is restarted first.
 */
export function ensureMetro(params: unknown, log: Log): Promise<Answer> {
  const fields = isJsonObject(params) ? params : {};
  let root: string;
  try {
    root = realpathSync(String(fields.root));
  } catch {
    return Promise.resolve({ op: 'error', code: 'bad-root', message: `no workspace at ${String(fields.root)}` });
  }
  const port = Number.isInteger(fields.port) ? Number(fields.port) : loadConfig()?.projects?.[root]?.metroPort;
  if (!port) return Promise.resolve({ op: 'error', code: 'no-port', message: `${root} has no Metro port` });
  const child = children.get(root);
  if (
    !busy.has(root) &&
    child?.handle &&
    child.port === port &&
    fields.launch !== true &&
    running(child) &&
    heartbeatFresh(child)
  )
    return Promise.resolve(answer(child));
  const run = (busy.get(root) ?? Promise.resolve({}))
    .catch(() => ({}))
    .then(() => ensure(root, port, fields.launch === true, log))
    .catch((error: unknown) => ({
      op: 'error',
      code: 'metro',
      message: error instanceof Error ? error.message : String(error),
    }));
  busy.set(root, run);
  void run.finally(() => busy.get(root) === run && busy.delete(root));
  return run;
}

/** `op.begin {params: {workspace}}`'s flag: the workspace's Metro loaded other injected files, so it is foreign until a restart. */
export function metroOpFlags(params: unknown): Answer {
  const workspace = isJsonObject(params) && typeof params.workspace === 'string' ? params.workspace : null;
  const child = workspace ? children.get(workspace) : undefined;
  // compat C6 permanent
  return child && child.digest !== injectedDigest() ? { metroForeign: true } : {};
  // compat end
}

/** Whether this stimd supervises any Metro or tunnel child, which keeps it running whatever `daemon.mode` says. */
export function metroChildrenRun(): boolean {
  return children.size > 0 || tunnels.size > 0;
}

function retake(holder: ClaimHolder, root: string, label: string): ClaimHandle | null {
  if (
    !holder.child ||
    inspectProcessIdentity(holder.owner) === 'same' ||
    inspectProcessIdentity(holder.child) !== 'same'
  )
    return null;
  try {
    releaseClaim({ ...holder, root, label });
    const attempt = tryAcquireClaim({ root, mode: 'exclusive', label, details: holder.details });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (attempt.acquired) setClaimChild(attempt.acquired, holder.child);
    return attempt.acquired ?? null;
  } catch {
    return null;
  }
}

/**
 * At boot, takes over the Metro and tunnel children an earlier stimd of this home left running, by their claims: a
 * claim whose holder is gone and whose child runs. Windows has no process groups, so there its children stop with
 * their stimd and nothing is adopted.
 */
export function adoptMetroChildren(log: Log): void {
  if (!GROUPS) return;
  let paths: string[];
  try {
    paths = Object.keys(loadConfig()?.projects ?? {});
  } catch (error) {
    log(
      'warn',
      'metro_adopt_failed',
      `the config cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  for (const path of paths) {
    for (const holder of readClaimSet(claimRoot(path, 'metro')).live) {
      const claim = retake(holder, claimRoot(path, 'metro'), 'Metro');
      if (!claim || !holder.child) continue;
      const digest = typeof holder.details.digest === 'string' ? holder.details.digest : null;
      const writer = metroWriter(path, digest);
      const records = childRecords({
        log: writer,
        toRecord: (chunk, stream) => recordFromLine(chunk, { stream }),
      });
      const child: MetroChild = {
        root: path,
        port: Number(holder.details.port),
        mode: String(holder.details.mode),
        digest,
        ...holder.child,
        startedAt: holder.startedAt,
        claim,
        writer,
        handle: null,
        stopTail: tailChildOutput(outputFiles(path), records.push),
        gone: false,
      };
      children.set(path, child);
      log(
        'info',
        'metro_adopted',
        `${path}: adopted the ${child.mode} dev server pid ${child.pid}${child.digest !== injectedDigest() ? ', of other injected files' : ''}`,
      );
    }
    for (const holder of readClaimSet(claimRoot(path, 'tunnel')).live) {
      const claim = retake(holder, claimRoot(path, 'tunnel'), 'tunnel');
      if (claim && holder.child) tunnels.set(path, { claim, ...holder.child, url: String(holder.details.url) });
    }
  }
}

/** Whether nothing used the child's workspace since `since`: no Metro request, no device use, no blocker. */
async function idlePoint(child: MetroChild, since: number): Promise<boolean> {
  const probe = workspaceIdleProbe(child.root);
  const metro = metroRequestAt(child.root, since, true);
  if (typeof metro !== 'number' || Date.parse(child.startedAt) > since) return false;
  return Math.max(probe.lastActivityAt(), metro > 0 ? metro : 0) <= since && (await probe.blocker()) === null;
}

/**
 * The tick's Metro hook: forgets children that exited, restarts a Metro of other injected files at its workspace's
 * next idle point, and, while the passes do not act (`daemon.mode` other than `on`), stops a Metro that served no
 * request and no Stim command for the workspace's `idle.minutes`, as the supervisor's own idle timer did.
 */
export async function metroTick(act: boolean, log: Log): Promise<void> {
  for (const child of children.values()) {
    if (!running(child)) {
      forget(child, `the ${child.mode} dev server pid ${child.pid} is gone`, 'warn');
      continue;
    }
    if (busy.has(child.root)) continue;
    // compat C6 permanent
    if (child.digest !== injectedDigest() && (await idlePoint(child, Date.now() - IDLE_POINT_MS))) {
      await stopChild(child, 'it loaded other injected files; restarting it at an idle point');
      void ensureMetro({ root: child.root, port: child.port }, log);
      continue;
    }
    // compat end
    if (act || child.mode === MODE_COMMAND) continue;
    const minutes = idleMinutesSetting(resolveProjectSettings(child.root).settings);
    if (minutes > 0 && (await idlePoint(child, Date.now() - minutes * 60_000))) {
      await stopChild(child, `no Metro request or Stim command for ${minutes} minutes (idle.minutes)`);
      writeWorkspaceState(child.root, {
        [IDLE_STOP_KEY]: { reason: 'idle', at: new Date().toISOString(), idleMinutes: minutes },
      });
    }
  }
  for (const [root, tunnel] of tunnels)
    if (inspectProcessIdentity(tunnel) !== 'same') {
      tunnels.delete(root);
      releaseClaim(tunnel.claim);
    }
}

/**
 * `tunnel.ensure {root, provider, port, ngrokUrl?, requireReachable?}`: the workspace's tunnel provider as a child of
 * this stimd in its own process group with file stdio, claimed under `tunnel.claim`, answering `{op: 'tunnel', url}`.
 */
export async function ensureTunnel(params: unknown): Promise<Answer> {
  const fields = isJsonObject(params) ? params : {};
  const root = realpathSync(String(fields.root));
  const known = tunnels.get(root);
  if (known && inspectProcessIdentity(known) === 'same') return { op: 'tunnel', url: known.url, pid: known.pid };
  const provider = PROVIDERS.find((name) => name === fields.provider);
  if (!provider) return { op: 'error', code: 'bad-provider', message: `no tunnel provider ${String(fields.provider)}` };
  const port = Number(fields.port);
  const attempt = tryAcquireClaim({
    root: claimRoot(root, 'tunnel'),
    mode: 'exclusive',
    label: 'tunnel',
    details: { provider, port },
  });
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired)
    return { op: 'error', code: 'tunnel-claimed', message: `another process holds ${claimRoot(root, 'tunnel')}` };
  const { startTunnel } = await import('../../engine/tunnel.ts');
  const started = await startTunnel({
    claims: [attempt.acquired],
    provider,
    port,
    ngrokUrl: typeof fields.ngrokUrl === 'string' ? fields.ngrokUrl : null,
    requireReachable: fields.requireReachable !== false,
  });
  if ('failed' in started) {
    releaseClaim(attempt.acquired);
    return { op: 'error', code: 'tunnel-start', message: started.reason };
  }
  const claim =
    updateClaimDetails(attempt.acquired, { provider, port, url: started.url, logFile: started.logFile }) ??
    attempt.acquired;
  tunnels.set(root, { claim, pid: started.pid, processToken: started.processToken, url: started.url });
  return { op: 'tunnel', url: started.url, pid: started.pid };
}

/** At stimd's exit: on Windows, where children cannot be re-adopted, stops them; elsewhere only stops following them. */
export async function closeMetroChildren(): Promise<void> {
  for (const child of children.values()) {
    if (GROUPS) child.stopTail?.();
    else await stopChild(child, 'stimd exits');
  }
}
