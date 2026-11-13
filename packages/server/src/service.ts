import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { clearFreeClaimSet, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { execStartOverride } from '@stim-cli/core';
import { stimBuildDigest, tailscaleEnv } from '@stim-cli/core/state';
import type { WorkerRootUsage } from './worker-areas.ts';
import {
  jobArguments,
  withProgramArguments,
  DEFAULT_LABEL,
  DEFAULT_PORT,
  validateLabel,
  normalizeEnv,
  ServiceError,
  type InstalledService,
  type ServeRecord,
  type ServiceSpec,
} from './service-plist.ts';
import {
  run,
  serviceManager,
  serviceManagerOrNull,
  serviceRoot,
  type ServiceJob,
  type ServiceManager,
} from './service-manager.ts';
import { editUnit } from './service-unit.ts';
import { hostPermissionPanes, requestHostPermissions, type HostApp } from './stim-host.ts';
import { tailscalePackage } from './tailnet-helper.ts';
import { markTailnet } from './tailnet-marker.ts';
import type { StartupState } from './startup.ts';
import type { KeepAwakeReason, KeepAwakeStatus } from './keep-awake.ts';
import { stimDist } from './release-install.ts';

const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_WAIT_MS = 15_000;
const UNLOAD_WAIT_MS = 45_000;

export interface ServiceOptions {
  label: string;
  port: number;
  env: string[];
  pathPrepend: string[];
  serve: boolean;
  stimHome?: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FILE_NOUNS = { launchd: 'plist', systemd: 'unit', taskscheduler: 'service file' } as const;
const START_COMMANDS = {
  launchd: 'launchctl bootstrap',
  systemd: 'systemctl --user enable and start',
  taskscheduler: 'schtasks /Create and /Run',
} as const;
const fileNoun = () => FILE_NOUNS[serviceManager().name];
const startCommand = () => START_COMMANDS[serviceManager().name];

const plistPath = (label: string) => serviceManager().file(label);
const logPath = (label: string) => serviceManager().logPath(label);

/**
 * The `node` to put in the plist: `process.execPath` is a resolved path such as a Homebrew Cellar version that
 * disappears on the next upgrade, so prefer a `node` on PATH that resolves to the same binary.
 */
export function stableNode(pathEnv: string | undefined): string {
  const real = realpathSync(process.execPath);
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      continue;
    }
  }
  return real;
}

const loaded = (label: string): Promise<ServiceJob | null> => serviceManager().job(label);
const readInstalled = (label: string): Promise<InstalledService | null> => serviceManager().read(label);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function listenerPids(port: number): Promise<string[]> {
  if (process.platform === 'win32') {
    const listed = await run('netstat', ['-ano']);
    return listed.ok ? netstatListeners(listed.stdout, port) : [];
  }
  const listener = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return listener.ok ? listener.stdout.trim().split(/\s+/).filter(Boolean) : [];
}

/**
 * The pids listening on TCP `port` in `netstat -ano` output. netstat localizes the state column, so a listener is a
 * TCP row with no foreign address.
 */
export function netstatListeners(output: string, port: number): string[] {
  const pids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const [protocol, local, foreign, , pid] = line.trim().split(/\s+/);
    if (protocol === 'TCP' && (foreign === '0.0.0.0:0' || foreign === '[::]:0') && pid && local?.endsWith(`:${port}`))
      pids.add(pid);
  }
  return [...pids];
}

async function unload(label: string, port: number | null): Promise<void> {
  const job = await loaded(label);
  if (!job) return;
  const listeners = port === null ? [] : await listenerPids(port);
  const stopped = await serviceManager().stop(label);
  const deadline = Date.now() + UNLOAD_WAIT_MS;
  while (Date.now() < deadline) {
    if (
      !(await loaded(label)) &&
      (job.pid == null || !alive(job.pid)) &&
      (port === null ||
        listeners.length === 0 ||
        (await portFree(port)) ||
        !(await listenerPids(port)).some((pid) => listeners.includes(pid)))
    )
      return;
    await sleep(250);
  }
  const pids = port === null ? [] : await listenerPids(port);
  throw new ServiceError(
    `${label} did not stop${port === null ? '' : ` and release port ${port}${pids.length ? ` (listening pid ${pids.join(', ')})` : ''}`} within ${UNLOAD_WAIT_MS / 1000} s. ${stopped.stderr.trim()}`.trim(),
  );
}

async function requireRunning(label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const job = await loaded(label);
    if (job?.pid) return;
    const lastExitCode = job?.lastExitCode && !job.lastExitCode.includes('never exited') ? job.lastExitCode : null;
    if (lastExitCode || Date.now() >= deadline) {
      throw new ServiceError(
        `${label} is not running${lastExitCode ? ` (last exit code ${lastExitCode})` : ''}. Check ${logPath(label)}.`,
      );
    }
    await sleep(250);
  }
}

interface Health {
  startup?: StartupState;
  host?: { name: string; screenRecording: boolean; accessibility: boolean } | null;
  version: string;
  protocol?: number;
  stim: string;
  stimBuild?: string | null;
  busy?: { builds: number; hostedSessions: number; hostedWork?: number; tests?: number; resumes?: boolean };
  stimHome: string;
  tailscale?: { state: string; dnsName?: string | null; backendState?: string; reason?: string };
  route?: { state: string; port?: number; ports?: number[]; reason?: string };
  lan?: { addresses: string[]; port: number };
  keepAwake?: KeepAwakeStatus;
  workerRoot?: WorkerRootUsage | null;
}

export async function fetchHealth(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = (await response.json()) as Partial<Health> & { server?: string };
    return body.server === 'stim-server' ? (body as Health) : null;
  } catch {
    return null;
  }
}

async function waitForHealth(port: number, label: string): Promise<Health | null> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  for (;;) {
    const health = await fetchHealth(port);
    await requireRunning(label);
    if ((health && health.startup?.state !== 'pending') || Date.now() >= deadline) return health;
    await sleep(500);
  }
}

export async function prepareRoute(
  port: number,
  previous: InstalledService | null,
): Promise<{ record: ServeRecord; create: string[] | null }> {
  const { findTailscale, planServe, readTailscaleStatus, serveCommand, serveRoute } = await tailscalePackage();
  const binary = findTailscale(process.env);
  const status = await readTailscaleStatus(binary, process.env);
  if (!binary || status.state !== 'running') {
    throw new ServiceError(
      `--serve needs Tailscale running on this ${serviceManager().name === 'launchd' ? 'Mac' : 'machine'}, and the tailscale command on PATH.`,
    );
  }
  const plan = planServe(await serveRoute(binary, process.env, port, status.ips), port, previous?.serve ?? null);
  if ('refusal' in plan) throw new ServiceError(plan.refusal);
  return { record: plan.record, create: plan.create ? serveCommand(plan.record.port, port).split(' ').slice(1) : null };
}

export async function requireManaged(label: string): Promise<InstalledService | null> {
  const installed = await readInstalled(label);
  if (!installed && existsSync(plistPath(label))) {
    throw new ServiceError(
      `${plistPath(label)} is not a ${fileNoun()} that install wrote; not touching it. Use another --label.`,
    );
  }
  if (installed && !installed.managed) {
    throw new ServiceError(
      `${plistPath(label)} was not written by \`stim service install\`; not touching it. Use another --label.`,
    );
  }
  if (!installed && (await loaded(label))) {
    throw new ServiceError(
      `${serviceManager().name} already runs a job named ${label} that install did not write. Use another --label.`,
    );
  }
  return installed;
}

export async function installService(options?: ServiceOptions): Promise<string[]> {
  const manager = serviceManager();
  // compat C12 permanent
  if (!options) {
    const root = dirname(manager.root(DEFAULT_LABEL));
    const notes: string[] = [];
    for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
      if (!entry.isDirectory() || validateLabel(entry.name)) continue;
      notes.push(
        ...(await holdingServiceClaim(entry.name, async () => {
          const installed = await manager.read(entry.name);
          if (!installed?.managed || installed.port === null) return [];
          return installJob({
            label: installed.label,
            port: installed.port,
            env: installed.env,
            pathPrepend: installed.pathPrepend,
            stimHome: installed.stimHome,
            serve: false,
          });
        })),
      );
    }
    if (notes.length) return notes;
    options = { label: DEFAULT_LABEL, port: DEFAULT_PORT, env: [], pathPrepend: [], serve: false };
  }
  // compat end
  return holdingServiceClaim(options.label, () => installJob(options));
}

/**
 * The engine store's `bin/stimd` shim, which `stim engine` promotion writes and rewrites at each flip, so a unit naming it
 * never names a deleted build; null without an engine store.
 */
function engineShim(env: NodeJS.ProcessEnv = process.env): string | null {
  const shim = join(env.STIM_ENGINE_ROOT || join(homedir(), '.stim', 'engine'), 'bin', 'stimd');
  return existsSync(shim) ? shim : null;
}

/** The engine shim a service of this platform names; Task Scheduler runs Stim's own supervisor, which names no shim. */
const unitShim = (): string | null => (serviceManager().name === 'taskscheduler' ? null : engineShim());

/**
 * Moves the LaunchAgent or systemd unit `label` onto the engine store's `bin/stimd` shim and returns whether the running
 * server must restart to run it, which is when this call changed what the manager will start.
 *
 * A unit that names node and a Stim script (`<node> <copy>/bin/stim.mjs serve --service`, as Stim 1.42 wrote it) is
 * rewritten to name the shim with the same options. launchd reads the file only when the job is bootstrapped. systemd
 * restarts a job from the definition it already loaded, so a unit that names the shim also has to be loaded: this
 * reloads it without restarting the job and checks `systemctl show` for the shim, which a later boot retries when a
 * reload failed. A drop-in or multi-line `ExecStart=` is refused and the file left as written; a symlinked unit is
 * written through.
 */
export async function rewriteUnitToShim(label: string): Promise<boolean> {
  const manager = serviceManager();
  const stimd = unitShim();
  const installed = stimd ? await readInstalled(label) : null;
  if (!stimd || !installed?.managed || installed.script === null || installed.port === null) return false;
  const path = plistPath(label);
  let changed = false;
  if (installed.node !== null) {
    const text = readFileSync(path, 'utf8');
    const args = [
      ...(installed.host ? [installed.host, 'run'] : []),
      ...jobArguments({ ...installed, node: installed.node, script: installed.script, port: installed.port, stimd }),
    ];
    const rewritten =
      manager.name === 'launchd' ? withProgramArguments(text, args) : editUnit(text, { programArguments: args });
    if (rewritten !== text) {
      const problem = manager.name === 'systemd' ? execStartOverride(path, text) : null;
      if (problem) throw new ServiceError(`${problem}; not rewriting ${label} to the engine shim.`);
      const target = realpathSync(path);
      const partial = `${target}.${process.pid}.tmp`;
      writeFileSync(partial, rewritten, { mode: 0o644 });
      renameSync(partial, target);
      changed = true;
    }
  } else if (installed.script !== stimd) return false;
  if (manager.loadedCommand) {
    const loadsShim = async () => ((await manager.loadedCommand?.(label)) ?? '').includes(`path=${stimd} ;`);
    if (!(await loadsShim())) {
      const reloaded = await manager.reload?.();
      if (!reloaded?.ok || !(await loadsShim())) {
        const override = execStartOverride(path, readFileSync(path, 'utf8'));
        throw new ServiceError(
          `${manager.noun} has not loaded the engine shim for ${label}${override ? ` (${override})` : reloaded?.ok ? '' : ` (${reloaded?.stderr.trim()})`}; ${manager.restartRemedy(label)} when no build runs.`,
        );
      }
      changed = true;
    }
  }
  return changed;
}

/** The server directory of the Stim home a service runs with `STIM_HOME` set to `stimHome`. */
function serviceServerDir(stimHome: string | null | undefined): string {
  return join(stimHome || join(homedir(), '.stim'), 'server');
}

export async function installJob(
  options: ServiceOptions,
  setup?: { script: string; host: HostApp | null; requestPermissions: false },
): Promise<string[]> {
  const script = realpathSync(
    setup?.script ?? join(dirname(createRequire(import.meta.url).resolve('stim/package.json')), 'bin', 'stim.mjs'),
  );
  const previous = await requireManaged(options.label);
  if (previous?.serve?.created && previous.port !== options.port) {
    throw new ServiceError(
      `${options.label} serves the route on https port ${previous.serve.port} for port ${previous.port}. Run \`service uninstall\` first to move it to port ${options.port}.`,
    );
  }
  let serve: ServeRecord | null = previous?.port === options.port ? (previous.serve ?? null) : null;
  let createRoute: string[] | null = null;
  if (options.serve) {
    const prepared = await prepareRoute(options.port, previous);
    serve = prepared.record;
    createRoute = prepared.create;
  }
  const environment: Record<string, string> = {};
  const stimHome = options.stimHome === undefined ? process.env.STIM_HOME : options.stimHome;
  if (stimHome) environment.STIM_HOME = stimHome;
  if (process.env.SHELL) environment.SHELL = process.env.SHELL;
  const manager = serviceManager();
  const host = setup ? setup.host : await manager.host();
  const stimd = unitShim();
  const spec: ServiceSpec = {
    host: host?.executable ?? null,
    label: options.label,
    node: stableNode(process.env.PATH),
    script,
    ...(stimd ? { stimd } : {}),
    port: options.port,
    env: setup && !options.env.length ? (previous?.env ?? []) : options.env,
    pathPrepend: setup && !options.pathPrepend.length ? (previous?.pathPrepend ?? []) : options.pathPrepend,
    environment,
    logPath: logPath(options.label),
    workingDirectory: homedir(),
    serve,
  };
  const path = plistPath(options.label);
  const { findTailscale, serveCommand } = await tailscalePackage();
  const tailscale = findTailscale(process.env) ?? 'tailscale';
  if (
    setup &&
    previous?.script === (stimd ?? script) &&
    previous.port === options.port &&
    previous.host === spec.host &&
    JSON.stringify(normalizeEnv(previous.env)) === JSON.stringify(normalizeEnv(spec.env)) &&
    JSON.stringify(previous.pathPrepend) === JSON.stringify(spec.pathPrepend)
  ) {
    const health = await fetchHealth(options.port);
    if (health && health.startup?.state !== 'pending' && health.startup?.state !== 'degraded') {
      return [`${options.label} already runs stim-server ${health.version}.`];
    }
  }
  const oldPlist = previous ? readFileSync(path, 'utf8') : null;
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(spec.logPath), { recursive: true });

  const wasLoaded = (await loaded(options.label)) !== null;
  let routeCreated = false;
  let bootstrapped = false;
  let health: Health | null;
  try {
    await unload(options.label, previous?.port ?? null);
    if (await fetchHealth(options.port)) {
      throw new ServiceError(
        `port ${options.port} already answers as a stim-server that is not ${options.label} (Stim Desktop runs one on 7787). Pass --port to use another.`,
      );
    }
    if (createRoute) {
      const made = await run(tailscale, createRoute, tailscaleEnv(process.env));
      if (!made.ok) throw new ServiceError(`\`tailscale ${createRoute.join(' ')}\` failed: ${made.stderr.trim()}`);
      routeCreated = true;
    }
    const partial = `${path}.${process.pid}.tmp`;
    writeFileSync(partial, manager.render(spec), { mode: 0o644 });
    renameSync(partial, path);
    const started = await manager.start(options.label);
    if (!started.ok) throw new ServiceError(`${startCommand()} failed: ${started.stderr.trim()}`);
    bootstrapped = true;
    health = await waitForHealth(options.port, options.label);
  } catch (error) {
    if (oldPlist !== null) writeFileSync(path, oldPlist, { mode: 0o644 });
    if (routeCreated && serve)
      await run(tailscale, ['serve', `--https=${serve.port}`, 'off'], tailscaleEnv(process.env));
    if (bootstrapped) {
      try {
        await unload(options.label, options.port);
      } catch (cleanupError) {
        (error as Error).message += ` ${(cleanupError as Error).message}`;
      }
    }
    if (oldPlist === null) {
      await manager.remove(options.label).catch(() => rmSync(path, { force: true }));
      throw error;
    }
    const restored = wasLoaded && !(await loaded(options.label)) ? await manager.start(options.label) : null;
    if (wasLoaded && !restored?.ok) {
      throw new ServiceError(
        `${(error as Error).message} The previous ${fileNoun()} was restored, but the service could not be restarted (${restored?.stderr.trim() || 'the job is still loaded'}); ${manager.restartRemedy(options.label)}.`,
      );
    }
    throw error;
  }

  const notes = [`Installed ${options.label}: ${path}`, `Log: ${spec.logPath}`];
  const follow = `Run \`stim service status --label ${options.label}\` and check ${spec.logPath}.`;
  const noun =
    manager.name === 'launchd' ? 'LaunchAgent' : manager.name === 'taskscheduler' ? 'Scheduled task' : 'Service';
  notes.push(
    !health
      ? `${noun} installed, but server readiness is unavailable on 127.0.0.1:${options.port}. ${follow}`
      : health.startup?.state === 'degraded'
        ? `${noun} installed and listening on 127.0.0.1:${options.port}, but not serving clients: ${health.startup.reason} ${follow}`
        : health.startup?.state === 'pending'
          ? `${noun} installed and listening on 127.0.0.1:${options.port}, still reading its Stim home. ${follow}`
          : `stim-server ${health.version} answers on 127.0.0.1:${options.port}.`,
  );
  if (host && setup?.requestPermissions !== false) {
    try {
      await requestHostPermissions(host.app);
    } catch (error) {
      notes.push(`Could not show macOS permission requests: ${(error as Error).message}`);
    }
    const panes = await hostPermissionPanes();
    notes.push(
      `The service runs under ${host.name}: ${host.app}.`,
      "macOS shows its own permission requests on this Mac's screen; you only approve them. Over SSH, use Screen Sharing to see this Mac's screen.",
      `If a request does not appear, turn ${host.name} on in System Settings > Privacy & Security > ${panes.screen} and System Settings > Privacy & Security > ${panes.control}. Stim never changes these settings itself.`,
    );
  }
  if (host?.adHoc) {
    notes.push(
      `${host.name} is signed ad hoc, so macOS keeps its approvals only while the launcher source and Xcode toolchain are unchanged.`,
    );
  }
  if (serve) {
    markTailnet('stim service install --serve', serviceServerDir(stimHome));
    notes.push(
      `Tailnet route: https port ${serve.port}, ${serve.created ? 'created by install; uninstall removes it' : 'already present; uninstall keeps it'}.`,
    );
  } else {
    notes.push(`No tailnet route. Run \`${serveCommand(7443, options.port)}\` or install again with --serve.`);
  }
  const shim = process.platform === 'win32' ? nodeShim(spec.node, spec.pathPrepend) : null;
  if (shim) {
    notes.push(
      `The first node.exe on PATH, ${shim}, is not the Node that runs stim-server (${spec.node}). Builds start tools such as Expo's config loader with it, and a version manager's node.exe shim, such as pnpm's, breaks their Node IPC, so builds fail with fingerprint-mismatch. Install again with --path-prepend "${dirname(spec.node)}" to put the real Node first.`,
    );
  }
  notes.push(...(await manager.sessionNotes()));
  return notes;
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** The first `node.exe` the service's PATH finds, when it is not `node`; builds run their tools with that one. */
function nodeShim(node: string, pathPrepend: string[]): string | null {
  for (const dir of [...pathPrepend, ...(process.env.PATH ?? '').split(delimiter)]) {
    const candidate = dir && join(dir, 'node.exe');
    if (candidate && existsSync(candidate)) return sameFile(candidate, node) ? null : candidate;
  }
  return null;
}

export async function recordServiceRoute(label: string, port: number, record: ServeRecord): Promise<void> {
  await holdingServiceClaim(label, async () => {
    const installed = await requireManaged(label);
    if (!installed) throw new ServiceError(`${label} is not installed. Run \`stim service install\` first.`);
    if (installed.port !== port)
      throw new ServiceError(`${label} moved to port ${installed.port}; not recording this route.`);
    const path = plistPath(label);
    if (installed.serve?.port === record.port && installed.serve.created === record.created) return;
    const staged = `${path}.${process.pid}.tmp`;
    copyFileSync(path, staged);
    try {
      try {
        await serviceManager().rewrite(installed, staged, { serve: record });
      } catch (error) {
        throw new ServiceError(
          `Could not record the setup route: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      renameSync(staged, path);
    } finally {
      rmSync(staged, { force: true });
    }
  });
}

export interface ServiceStatus {
  label: string;
  /** The service manager: launchd on macOS, systemd on Linux. */
  manager: ServiceManager['name'];
  installed: boolean;
  /** The service file: the LaunchAgent plist, or the systemd user unit. */
  plist: string;
  loaded: boolean;
  state: string | null;
  pid: number | null;
  runs: number | null;
  lastExitCode: string | null;
  port: number | null;
  health: {
    startup: StartupState;
    version: string;
    stim: string;
    stimHome: string;
    tailscale: string | null;
    route: string | null;
    /** Whether the server holds the keep-awake assertion; null when the server predates it. */
    keepAwake: KeepAwakeStatus | null;
    /** The last measurement of `server.workerRoot`; null before the first, and on Windows. */
    workerRoot: WorkerRootUsage | null;
  } | null;
  serve: ServeRecord | null;
  logPath: string | null;
  host: { app: string; name: string; screenRecording: boolean | null; accessibility: boolean | null } | null;
  node: string | null;
  script: string | null;
  /** The server script a 1.42 `service update` or `service rollback` switched from, or null. */
  previousScript: string | null;
  /** Names only: a value may be a secret, and the plist holds it in plain text. */
  envNames: string[];
  pathPrepend: string[];
  stimBuild: { service: string | null; cli: string | null; match: boolean | null };
  /** Whether systemd keeps this user's services running without a login; null under launchd. */
  linger: boolean | null;
}

function stimOnPath(): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      return stimDist(realpathSync(join(dir, 'stim')));
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The `dist` a unit runs: for the engine's `bin/stimd` shim, the build `current.json` beside it names, else the
 * `stim` package around the unit's script.
 */
function unitDist(script: string): string | null {
  if (basename(script) !== 'stimd' || basename(dirname(script)) !== 'bin') return stimDist(script);
  try {
    const root = dirname(dirname(script));
    const current: unknown = JSON.parse(readFileSync(join(root, 'current.json'), 'utf8'));
    const dir = typeof current === 'object' && current !== null ? (current as { dir?: unknown }).dir : null;
    return typeof dir === 'string' ? join(root, dir, 'dist') : null;
  } catch {
    return null;
  }
}

export async function serviceStatus(label: string): Promise<ServiceStatus> {
  const manager = serviceManager();
  const installed = await readInstalled(label);
  const job = await loaded(label);
  const health = installed?.port ? await fetchHealth(installed.port) : null;
  const serviceDist = installed?.script ? unitDist(installed.script) : null;
  const cliDist = stimOnPath();
  const service = serviceDist ? stimBuildDigest(serviceDist) : null;
  const cli = cliDist ? stimBuildDigest(cliDist) : null;
  return {
    label,
    manager: manager.name,
    installed: installed !== null,
    plist: plistPath(label),
    loaded: job !== null,
    state: job?.state ?? null,
    pid: job?.pid ?? null,
    runs: job?.runs ?? null,
    lastExitCode: job?.lastExitCode && !job.lastExitCode.includes('never exited') ? job.lastExitCode : null,
    port: installed?.port ?? null,
    health: health
      ? {
          startup: health.startup ?? { state: 'ready' },
          version: health.version,
          stim: health.stim,
          stimHome: health.stimHome,
          tailscale: tailscaleText(health.tailscale),
          route: routeText(health.route),
          keepAwake: health.keepAwake ?? null,
          workerRoot: health.workerRoot ?? null,
        }
      : null,
    serve: installed?.serve ?? null,
    logPath: installed?.logPath ?? null,
    host: installed?.host
      ? {
          app: dirname(dirname(dirname(installed.host))),
          name: basename(dirname(dirname(dirname(installed.host))), '.app'),
          screenRecording: health?.host?.screenRecording ?? null,
          accessibility: health?.host?.accessibility ?? null,
        }
      : null,
    node: installed?.node ?? null,
    script: installed?.script ?? null,
    previousScript: installed?.previousScript ?? null,
    envNames: (installed?.env ?? []).map((entry) => entry.slice(0, entry.indexOf('='))),
    pathPrepend: installed?.pathPrepend ?? [],
    stimBuild: { service, cli, match: service && cli ? service === cli : null },
    linger: await manager.linger(),
  };
}

function tailscaleText(tailscale: Health['tailscale']): string | null {
  if (!tailscale) return null;
  if (tailscale.state === 'running') return tailscale.dnsName ? `running (${tailscale.dnsName})` : 'running';
  const detail = tailscale.backendState ?? tailscale.reason;
  return detail ? `${tailscale.state} (${detail})` : tailscale.state;
}

const KEEP_AWAKE_REASONS: Record<KeepAwakeReason, string> = {
  off: 'off (server.keepAwake is false)',
  unsupported: 'not held, only macOS supports it',
  'loopback-only': 'not held, this server accepts only this machine',
  'not-listening': 'not held, no tailnet or local network listener is up',
  failed: 'not held, caffeinate did not start or stopped (restart stim serve to retry)',
};

function keepAwakeText(keepAwake: KeepAwakeStatus): string {
  if (keepAwake.held) return `held${keepAwake.pid ? ` (caffeinate pid ${keepAwake.pid})` : ''}`;
  return KEEP_AWAKE_REASONS[keepAwake.reason ?? 'off'];
}

function workerRootText(usage: WorkerRootUsage | null): string {
  if (!usage) return 'size not measured';
  const hours = Math.floor((Date.now() - Date.parse(usage.measuredAt)) / 3_600_000);
  return `${usage.path}, ${(usage.bytes / 1024 ** 3).toFixed(1)} GB, measured ${hours < 1 ? 'in the last hour' : `${hours} h ago`}`;
}

function routeText(route: Health['route']): string | null {
  if (!route) return null;
  if (route.state === 'routed') return `routed on https port ${route.port}`;
  if (route.state === 'funneled') return `FUNNELED on port ${route.ports?.join(', ')}: public`;
  return route.reason ? `${route.state} (${route.reason})` : route.state;
}

export function statusLines(status: ServiceStatus, panes: { screen: string; control: string }): string[] {
  if (!status.installed) {
    return [
      `${status.label} is not installed (no ${status.plist}).${status.loaded ? ` ${status.manager} still lists it.` : ''}`,
    ];
  }
  const lines = [
    `${status.label}: ${status.loaded ? `${status.state}${status.pid ? ` (pid ${status.pid})` : ''}` : status.manager === 'launchd' ? 'installed but not loaded' : 'installed but stopped'}`,
  ];
  if (status.runs !== null)
    lines.push(`  runs: ${status.runs}${status.lastExitCode ? `, last exit ${status.lastExitCode}` : ''}`);
  lines.push(`  port: ${status.port}`);
  const detail = status.health
    ? `stim-server ${status.health.version}, stim ${status.health.stim}, stim home ${status.health.stimHome}`
    : null;
  lines.push(
    !status.health
      ? `  health: no answer on 127.0.0.1:${status.port}`
      : status.health.startup.state === 'degraded'
        ? `  health: degraded, listening but not serving clients: ${status.health.startup.reason} (${detail})`
        : status.health.startup.state === 'pending'
          ? `  health: starting, still reading the Stim home (${detail})`
          : `  health: ok, ${detail}`,
  );
  if (status.health?.tailscale) lines.push(`  tailscale: ${status.health.tailscale}`);
  if (status.health?.route) lines.push(`  tailscale route: ${status.health.route}`);
  if (status.health?.keepAwake) lines.push(`  keep awake: ${keepAwakeText(status.health.keepAwake)}`);
  if (status.health) lines.push(`  worker root: ${workerRootText(status.health.workerRoot)}`);
  if (status.serve) {
    lines.push(
      `  serve route: https ${status.serve.port} (${status.serve.created ? 'created by install' : 'not created by install'})`,
    );
  }
  const { service, cli, match } = status.stimBuild;
  lines.push(
    `  stim build: ${service ?? 'unknown'}${
      match === null ? '' : match ? ', same as the `stim` on PATH' : `, differs from the \`stim\` on PATH (${cli})`
    }`,
  );
  if (status.host) {
    lines.push(`  host app: ${status.host.app}`);
    for (const [permission, pane] of [
      [status.host.screenRecording, panes.screen],
      [status.host.accessibility, panes.control],
    ] as const) {
      lines.push(
        `  ${pane}: ${permission === true ? 'allowed' : permission === false ? `needed: System Settings > Privacy & Security > ${pane} > ${status.host.name}` : 'unknown (server did not report permissions)'}`,
      );
    }
  } else if (status.manager === 'launchd') {
    lines.push(
      `  macOS attributes ${panes.screen} and ${panes.control} to node. Run \`stim service install\` again to use Stim Host.`,
    );
  }
  lines.push(`  node: ${status.node}`, `  server: ${status.script}`);
  lines.push(`  log: ${status.logPath}`);
  if (status.pathPrepend.length) lines.push(`  path-prepend: ${status.pathPrepend.join(delimiter)}`);
  if (status.envNames.length) lines.push(`  env: ${status.envNames.join(', ')}`);
  if (status.linger !== null) {
    lines.push(
      status.linger
        ? '  linger: on, so the service runs without a login'
        : `  linger: off, so the service stops when you log out; run \`sudo loginctl enable-linger <user>\``,
    );
  }
  lines.push(`  ${FILE_NOUNS[status.manager]}: ${status.plist}`);
  return lines;
}

export async function uninstallService(label: string): Promise<string[]> {
  serviceManager();
  const notes = await holdingServiceClaim(label, async () => {
    const result = await uninstallJob(label);
    for (const entry of readdirSync(serviceRoot(label))) {
      if (entry !== 'update.claims') rmSync(join(serviceRoot(label), entry), { recursive: true, force: true });
    }
    return result;
  });
  if (
    clearFreeClaimSet({ root: join(serviceRoot(label), 'update.claims'), label: `${label} update` }).status ===
    'cleared'
  ) {
    try {
      rmdirSync(serviceRoot(label));
    } catch {}
  }
  return notes;
}

async function uninstallJob(label: string): Promise<string[]> {
  const installed = await requireManaged(label);
  if (!installed) return [`${label} is not installed.`];
  const notes: string[] = [];
  let routeOff: number | null = null;
  const { findTailscale, readTailscaleStatus, serveRoute } = await tailscalePackage();
  const tailscale = findTailscale(process.env);
  if (installed.serve?.created && installed.port !== null) {
    const status = await readTailscaleStatus(tailscale, process.env);
    if (!tailscale || status.state !== 'running') {
      throw new ServiceError(
        `${label} created the tailscale serve route on https port ${installed.serve.port}, and Tailscale is not answering, so uninstall cannot check it. Start Tailscale and run this again.`,
      );
    }
    const route = await serveRoute(tailscale, process.env, installed.port, status.ips);
    if (route.state === 'routed' && route.port === installed.serve.port) {
      routeOff = installed.serve.port;
    } else {
      notes.push(
        `The tailscale serve route on https port ${installed.serve.port} no longer points here; left as it is.`,
      );
    }
  } else if (installed.serve) {
    notes.push(`Kept the tailscale serve route on https port ${installed.serve.port}; install did not create it.`);
  }
  if (installed.host) notes.push(`Kept ${dirname(dirname(dirname(installed.host)))}; other service labels may use it.`);
  await unload(label, null);
  if (routeOff && tailscale) {
    const removed = await run(tailscale, ['serve', `--https=${routeOff}`, 'off'], tailscaleEnv(process.env));
    notes.push(
      removed.ok
        ? `Removed the tailscale serve route on https port ${routeOff}.`
        : `Could not remove the tailscale serve route: ${removed.stderr.trim()}. Run \`tailscale serve --https=${routeOff} off\`.`,
    );
  }
  await serviceManager().remove(label);
  notes.unshift(
    `Uninstalled ${label}. Pairings, stim home and the log ${installed.logPath ?? logPath(label)} are kept.`,
  );
  return notes;
}

/** Whether `label` names a service that `service install` wrote and that serves `port`. */
export async function runsAsService(label: string, port: number): Promise<boolean> {
  const manager = serviceManagerOrNull();
  if (!manager) return false;
  try {
    const installed = await manager.read(label);
    return installed?.managed === true && installed.port === port;
  } catch {
    return false;
  }
}

/** Runs `work` under the claim that keeps one install or uninstall of `label` at a time. */
export async function holdingServiceClaim<T>(label: string, work: () => Promise<T>): Promise<T> {
  const root = serviceRoot(label);
  mkdirSync(root, { recursive: true });
  let attempt;
  try {
    attempt = tryAcquireClaim({
      root: join(root, 'update.claims'),
      mode: 'exclusive',
      label: `${label} update`,
      details: { label },
    });
  } catch (error) {
    throw new ServiceError((error as Error).message);
  }
  if (attempt.pending) releaseClaim(attempt.pending);
  if (!attempt.acquired) {
    throw new ServiceError(
      `An install or uninstall of ${label} is running (pid ${attempt.held?.owner.pid ?? 'unknown'}). Wait for it to finish.`,
    );
  }
  try {
    return await work();
  } finally {
    releaseClaim(attempt.acquired);
  }
}
