import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { isJsonObject, stimBuildDigest } from '@stim-cli/core/state';
import {
  answersAs,
  DEFAULT_LABEL,
  parseInstalledPlist,
  parseLaunchctlPrint,
  planServe,
  renderPlist,
  argumentsWithScript,
  ServiceError,
  signatureProblem,
  unusedInstalls,
  type InstalledService,
  type LaunchdJob,
  type ServeRecord,
  type ServerBuild,
  type ServiceSpec,
} from './service-plist.ts';
import { hostPermissionPanes, installHostApp, requestHostPermissions, type HostApp } from './stim-host.ts';
import { findTailscale, serveCommand, serveRoute, tailscaleStatus } from './tailscale.ts';
import type { StartupState } from './startup.ts';

const LAUNCHCTL_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_WAIT_MS = 15_000;
const UNLOAD_WAIT_MS = 45_000;

export interface ServiceOptions {
  label: string;
  port: number;
  env: string[];
  pathPrepend: string[];
  serve: boolean;
}

interface Run {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeout: number = LAUNCHCTL_TIMEOUT_MS,
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr: stderr || (error ? error.message : '') }),
    );
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requireMacOs(): void {
  if (process.platform !== 'darwin') {
    throw new ServiceError(
      'stim-server service manages a launchd LaunchAgent and runs only on macOS. On this system, start stim-server from your own service manager.',
    );
  }
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;
const plistPath = (label: string) => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const logPath = (label: string) => join(homedir(), 'Library', 'Logs', 'Stim', `${label}.log`);

/**
 * The `node` to put in the plist: `process.execPath` is a resolved path such as a Homebrew Cellar version that
 * disappears on the next upgrade, so prefer a `node` on PATH that resolves to the same binary.
 */
export function stableNode(pathEnv: string | undefined): string {
  const real = realpathSync(process.execPath);
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      const candidate = join(dir, 'node');
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      continue;
    }
  }
  return real;
}

async function loaded(label: string): Promise<LaunchdJob | null> {
  const printed = await run('launchctl', ['print', `${domain()}/${label}`]);
  if (printed.ok) return parseLaunchctlPrint(printed.stdout);
  if (/could not find service/i.test(printed.stderr)) return null;
  throw new ServiceError(`launchctl print ${label} failed: ${printed.stderr.trim()}`);
}

async function readInstalled(label: string): Promise<InstalledService | null> {
  const path = plistPath(label);
  if (!existsSync(path)) return null;
  const converted = await run('plutil', ['-convert', 'json', '-o', '-', path]);
  if (!converted.ok)
    throw new ServiceError(
      `Could not read ${path} to check that install wrote it: ${converted.stderr.trim()}. Fix or remove the file, then run this again.`,
    );
  return parseInstalledPlist(JSON.parse(converted.stdout));
}

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

async function listenerPids(port: number): Promise<string[]> {
  const listener = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return listener.ok ? listener.stdout.trim().split(/\s+/).filter(Boolean) : [];
}

async function unload(label: string, port: number | null): Promise<void> {
  const job = await loaded(label);
  if (!job) return;
  const listeners = port === null ? [] : await listenerPids(port);
  const stopped = await run('launchctl', ['bootout', `${domain()}/${label}`]);
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
  stim: string;
  stimBuild?: string | null;
  busy?: { builds: number; hostedSessions: number };
  stimHome: string;
  tailscale?: { state: string; dnsName?: string | null; backendState?: string; reason?: string };
  route?: { state: string; port?: number; ports?: number[]; reason?: string };
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
  const binary = findTailscale(process.env);
  const status = tailscaleStatus(binary, process.env);
  if (!binary || status.state !== 'running') {
    throw new ServiceError('--serve needs Tailscale running on this Mac, and the tailscale command on PATH.');
  }
  const plan = planServe(await serveRoute(binary, process.env, port, status.ips), port, previous?.serve ?? null);
  if ('refusal' in plan) throw new ServiceError(plan.refusal);
  return { record: plan.record, create: plan.create ? serveCommand(plan.record.port, port).split(' ').slice(1) : null };
}

export async function requireManaged(label: string): Promise<InstalledService | null> {
  const installed = await readInstalled(label);
  if (!installed && existsSync(plistPath(label))) {
    throw new ServiceError(
      `${plistPath(label)} is not a plist that install wrote; not touching it. Use another --label.`,
    );
  }
  if (installed && !installed.managed) {
    throw new ServiceError(
      `${plistPath(label)} was not written by \`stim-server service install\`; not touching it. Use another --label.`,
    );
  }
  if (!installed && (await loaded(label))) {
    throw new ServiceError(
      `launchd already runs a job named ${label} that install did not write. Use another --label.`,
    );
  }
  return installed;
}

export async function installService(options: ServiceOptions): Promise<string[]> {
  requireMacOs();
  return holdingUpdateClaim(options.label, () => installJob(options));
}

export async function installJob(
  options: ServiceOptions,
  setup?: { script: string; host: HostApp; requestPermissions: false },
): Promise<string[]> {
  const script = realpathSync(setup?.script ?? process.argv[1] ?? '');
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
  if (process.env.STIM_HOME) environment.STIM_HOME = process.env.STIM_HOME;
  if (process.env.SHELL) environment.SHELL = process.env.SHELL;
  const host = setup?.host ?? (await installHostApp());
  const spec: ServiceSpec = {
    host: host.executable,
    label: options.label,
    node: stableNode(process.env.PATH),
    script,
    port: options.port,
    env: setup && !options.env.length ? (previous?.env ?? []) : options.env,
    pathPrepend: setup && !options.pathPrepend.length ? (previous?.pathPrepend ?? []) : options.pathPrepend,
    environment,
    logPath: logPath(options.label),
    workingDirectory: homedir(),
    serve,
  };
  const path = plistPath(options.label);
  const tailscale = findTailscale(process.env) ?? 'tailscale';
  if (
    setup &&
    previous?.script === script &&
    previous.port === options.port &&
    previous.host === spec.host &&
    JSON.stringify(previous.env) === JSON.stringify(spec.env) &&
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
      const made = await run(tailscale, createRoute);
      if (!made.ok) throw new ServiceError(`\`tailscale ${createRoute.join(' ')}\` failed: ${made.stderr.trim()}`);
      routeCreated = true;
    }
    const partial = `${path}.${process.pid}.tmp`;
    writeFileSync(partial, renderPlist(spec), { mode: 0o644 });
    renameSync(partial, path);
    const started = await run('launchctl', ['bootstrap', domain(), path]);
    if (!started.ok) throw new ServiceError(`launchctl bootstrap failed: ${started.stderr.trim()}`);
    bootstrapped = true;
    health = await waitForHealth(options.port, options.label);
  } catch (error) {
    if (oldPlist === null) rmSync(path, { force: true });
    else writeFileSync(path, oldPlist, { mode: 0o644 });
    if (routeCreated && serve) await run(tailscale, ['serve', `--https=${serve.port}`, 'off']);
    if (bootstrapped) {
      try {
        await unload(options.label, options.port);
      } catch (cleanupError) {
        (error as Error).message += ` ${(cleanupError as Error).message}`;
      }
    }
    if (oldPlist === null) throw error;
    const restored =
      wasLoaded && !(await loaded(options.label)) ? await run('launchctl', ['bootstrap', domain(), path]) : null;
    if (wasLoaded && !restored?.ok) {
      throw new ServiceError(
        `${(error as Error).message} The previous plist was restored, but the service could not be restarted (${restored?.stderr.trim() || 'the job is still loaded'}); run \`launchctl bootout ${domain()}/${options.label}\` and \`launchctl bootstrap ${domain()} ${path}\`.`,
      );
    }
    throw error;
  }

  const notes = [`Installed ${options.label}: ${path}`, `Log: ${spec.logPath}`];
  const follow = `Run \`stim-server service status --label ${options.label}\` and check ${spec.logPath}.`;
  notes.push(
    !health
      ? `LaunchAgent installed, but server readiness is unavailable on 127.0.0.1:${options.port}. ${follow}`
      : health.startup?.state === 'degraded'
        ? `LaunchAgent installed and listening on 127.0.0.1:${options.port}, but not serving clients: ${health.startup.reason} ${follow}`
        : health.startup?.state === 'pending'
          ? `LaunchAgent installed and listening on 127.0.0.1:${options.port}, still reading its Stim home. ${follow}`
          : `stim-server ${health.version} answers on 127.0.0.1:${options.port}.`,
  );
  if (setup?.requestPermissions !== false) {
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
  if (host.adHoc) {
    notes.push(
      `${host.name} is signed ad hoc, so macOS keeps its approvals only while the launcher source and Xcode toolchain are unchanged.`,
    );
  }
  if (serve) {
    notes.push(
      `Tailnet route: https port ${serve.port}, ${serve.created ? 'created by install; uninstall removes it' : 'already present; uninstall keeps it'}.`,
    );
  } else {
    notes.push(`No tailnet route. Run \`${serveCommand(7443, options.port)}\` or install again with --serve.`);
  }
  notes.push(
    'The service runs in your GUI login session (gui/<uid>), so after a reboot it starts when you log in. On a headless Mac, turn on automatic login.',
  );
  return notes;
}

export async function recordServiceRoute(label: string, port: number, record: ServeRecord): Promise<void> {
  await withUpdateClaim(label, async (installed) => {
    if (installed.port !== port)
      throw new ServiceError(`${label} moved to port ${installed.port}; not recording this route.`);
    const path = plistPath(label);
    if (installed.serve?.port === record.port && installed.serve.created === record.created) return;
    const staged = `${path}.${process.pid}.tmp`;
    copyFileSync(path, staged);
    try {
      for (const args of [
        ['-replace', 'StimService.ServePort', '-integer', String(record.port), staged],
        ['-replace', 'StimService.ServeCreated', '-bool', String(record.created), staged],
      ]) {
        const edited = await run('plutil', args);
        if (!edited.ok) throw new ServiceError(`Could not record the setup route: ${edited.stderr.trim()}`);
      }
      renameSync(staged, path);
    } finally {
      rmSync(staged, { force: true });
    }
  });
}

export interface ServiceStatus {
  label: string;
  installed: boolean;
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
  } | null;
  serve: ServeRecord | null;
  logPath: string | null;
  host: { app: string; name: string; screenRecording: boolean | null; accessibility: boolean | null } | null;
  node: string | null;
  script: string | null;
  /** The server script `service rollback` switches back to, or null when no update recorded one. */
  previousScript: string | null;
  /** Names only: a value may be a secret, and the plist holds it in plain text. */
  envNames: string[];
  pathPrepend: string[];
  stimBuild: { service: string | null; cli: string | null; match: boolean | null };
}

function stimDist(from: string): string | null {
  try {
    const manifest = createRequire(from).resolve('stim/package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { stim: string } };
    return dirname(join(dirname(manifest), pkg.bin.stim));
  } catch {
    return null;
  }
}

function stimOnPath(): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      return dirname(realpathSync(join(dir, 'stim')));
    } catch {
      continue;
    }
  }
  return null;
}

export async function serviceStatus(label: string): Promise<ServiceStatus> {
  requireMacOs();
  const installed = await readInstalled(label);
  const job = await loaded(label);
  const health = installed?.port ? await fetchHealth(installed.port) : null;
  const serviceDist = installed?.script ? stimDist(installed.script) : null;
  const cliDist = stimOnPath();
  const service = serviceDist ? stimBuildDigest(serviceDist) : null;
  const cli = cliDist ? stimBuildDigest(cliDist) : null;
  return {
    label,
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
  };
}

function tailscaleText(tailscale: Health['tailscale']): string | null {
  if (!tailscale) return null;
  if (tailscale.state === 'running') return tailscale.dnsName ? `running (${tailscale.dnsName})` : 'running';
  const detail = tailscale.backendState ?? tailscale.reason;
  return detail ? `${tailscale.state} (${detail})` : tailscale.state;
}

function routeText(route: Health['route']): string | null {
  if (!route) return null;
  if (route.state === 'routed') return `routed on https port ${route.port}`;
  if (route.state === 'funneled') return `FUNNELED on port ${route.ports?.join(', ')}: public`;
  return route.reason ? `${route.state} (${route.reason})` : route.state;
}

export function statusLines(status: ServiceStatus, panes: { screen: string; control: string }): string[] {
  if (!status.installed) {
    return [`${status.label} is not installed (no ${status.plist}).${status.loaded ? ' launchd still lists it.' : ''}`];
  }
  const lines = [
    `${status.label}: ${status.loaded ? `${status.state}${status.pid ? ` (pid ${status.pid})` : ''}` : 'installed but not loaded'}`,
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
  } else {
    lines.push(
      `  macOS attributes ${panes.screen} and ${panes.control} to node. Run \`stim-server service install\` again to use Stim Host.`,
    );
  }
  lines.push(`  node: ${status.node}`, `  server: ${status.script}`);
  if (status.previousScript) lines.push(`  previous server: ${status.previousScript} (service rollback)`);
  lines.push(`  log: ${status.logPath}`);
  if (status.pathPrepend.length) lines.push(`  path-prepend: ${status.pathPrepend.join(delimiter)}`);
  if (status.envNames.length) lines.push(`  env: ${status.envNames.join(', ')}`);
  lines.push(`  plist: ${status.plist}`);
  return lines;
}

export async function uninstallService(label: string): Promise<string[]> {
  requireMacOs();
  const notes = await holdingUpdateClaim(label, async () => {
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
  const tailscale = findTailscale(process.env);
  if (installed.serve?.created && installed.port !== null) {
    const status = tailscaleStatus(tailscale, process.env);
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
    const removed = await run(tailscale, ['serve', `--https=${routeOff}`, 'off']);
    notes.push(
      removed.ok
        ? `Removed the tailscale serve route on https port ${routeOff}.`
        : `Could not remove the tailscale serve route: ${removed.stderr.trim()}. Run \`tailscale serve --https=${routeOff} off\`.`,
    );
  }
  rmSync(plistPath(label), { force: true });
  notes.unshift(
    `Uninstalled ${label}. Pairings, stim home and the log ${installed.logPath ?? logPath(label)} are kept.`,
  );
  return notes;
}

const UPDATE_HEALTH_WAIT_MS = 90_000;
const UPDATE_SETTLE_MS = 5000;
const IDLE_WAIT_MS = 30 * 60_000;
const IDLE_POLL_MS = 5000;
const NPM_TIMEOUT_MS = 10 * 60_000;
const REGISTRY = 'https://registry.npmjs.org/';
const SERVER_PACKAGE = '@stim-cli/server';
const SERVER_SCRIPT = ['node_modules', '@stim-cli', 'server', 'dist', 'stim-server.mjs'];

export const serviceRoot = (label: string): string =>
  join(homedir(), 'Library', 'Application Support', 'Stim', 'services', label);

export type UpdateSource = { release: string } | { from: string };

/** How the last `service update` of a label ended, whoever ran it. */
export interface UpdateOutcome {
  at: string;
  target: string;
  ok: boolean;
  message: string;
}

const outcomeFile = (label: string) => join(serviceRoot(label), 'last-update.json');

function recordOutcome(label: string, outcome: UpdateOutcome): void {
  const file = outcomeFile(label);
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(outcome)}\n`);
  renameSync(partial, file);
}

export function readLastUpdate(label: string): UpdateOutcome | null {
  try {
    const value: unknown = JSON.parse(readFileSync(outcomeFile(label), 'utf8'));
    if (!isJsonObject(value)) return null;
    const { at, target, ok, message } = value;
    return typeof at === 'string' &&
      typeof target === 'string' &&
      typeof ok === 'boolean' &&
      typeof message === 'string'
      ? { at, target, ok, message }
      : null;
  } catch {
    return null;
  }
}

/** Whether `label` names a LaunchAgent that `service install` wrote and that serves `port`. */
export async function runsAsService(label: string, port: number): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const installed = await readInstalled(label);
    return installed?.managed === true && installed.port === port;
  } catch {
    return false;
  }
}

export const describeSource = (source: UpdateSource): string =>
  'release' in source ? `release ${source.release}` : `packages in ${source.from}`;

export function serverBuild(script: string): ServerBuild | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(script), '..', 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version !== 'string') return null;
    const dist = stimDist(script);
    return { version: pkg.version, stimBuild: dist ? stimBuildDigest(dist) : null };
  } catch {
    return null;
  }
}

const describeBuild = (build: ServerBuild) =>
  `stim-server ${build.version}${build.stimBuild ? ` (Stim build ${build.stimBuild})` : ''}`;

const lastLines = (text: string) => text.trim().split('\n').slice(-8).join('\n');

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function npmFor(node: string): { npm: string; env: NodeJS.ProcessEnv } {
  const path = [dirname(node), ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean);
  const env = { ...process.env, PATH: path.join(delimiter) };
  for (const dir of path) {
    const npm = join(dir, 'npm');
    if (existsSync(npm)) return { npm, env };
  }
  throw new ServiceError(`No npm next to ${node} or on PATH. Install npm for that node, then run update again.`);
}

function installedIntegrity(staging: string): string | null {
  try {
    const lock = JSON.parse(readFileSync(join(staging, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { integrity?: unknown }>;
    };
    const integrity = lock.packages?.[`node_modules/${SERVER_PACKAGE}`]?.integrity;
    return typeof integrity === 'string' ? integrity : null;
  } catch {
    return null;
  }
}

export async function installServer(
  versions: string,
  source: UpdateSource,
  node: string,
  log: (line: string) => void,
): Promise<{ script: string; build: ServerBuild; dir: string }> {
  mkdirSync(versions, { recursive: true });
  for (const entry of readdirSync(versions)) {
    if (entry.startsWith('.install-')) rmSync(join(versions, entry), { recursive: true, force: true });
  }
  const staging = join(versions, `.install-${process.pid}`);
  mkdirSync(staging);
  try {
    const { npm, env } = npmFor(node);
    const registry = [`--registry=${REGISTRY}`, `--@stim-cli:registry=${REGISTRY}`];
    let files: { name: string; sha256: string }[] = [];
    let specs: string[];
    if ('release' in source) {
      specs = [`${SERVER_PACKAGE}@${source.release}`];
    } else {
      const names = readdirSync(source.from).filter((name) => name.endsWith('.tgz'));
      if (!names.length) throw new ServiceError(`${source.from} has no .tgz package files.`);
      files = names.map((name) => ({
        name,
        sha256: createHash('sha256')
          .update(readFileSync(join(source.from, name)))
          .digest('hex'),
      }));
      specs = names.map((name) => join(source.from, name));
    }
    writeFileSync(join(staging, 'package.json'), '{ "private": true }\n');
    log(
      `Installing ${'release' in source ? `${SERVER_PACKAGE}@${source.release} from ${REGISTRY}` : `${files.length} package file(s) from ${source.from}`}.`,
    );
    const installed = await run(
      npm,
      [
        'install',
        '--prefix',
        staging,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=dev',
        '--save-exact',
        ...registry,
        ...specs,
      ],
      env,
      NPM_TIMEOUT_MS,
    );
    if (!installed.ok) throw new ServiceError(`npm install failed:\n${lastLines(installed.stderr)}`);
    // npm audit signatures checks the packages that came from the registry and skips local .tgz files.
    const audit = await run(
      npm,
      ['audit', 'signatures', '--json', '--prefix', staging, ...registry],
      env,
      NPM_TIMEOUT_MS,
    );
    const problem = signatureProblem(audit.stdout);
    if (problem) throw new ServiceError(`${problem}. Not switching to it.`);
    const script = join(staging, ...SERVER_SCRIPT);
    const build = existsSync(script) ? serverBuild(script) : null;
    const serverDigest = existsSync(script) ? stimBuildDigest(dirname(script)) : null;
    if (!build?.stimBuild || !serverDigest) {
      throw new ServiceError(`The install has no ${SERVER_PACKAGE} with its stim build.`);
    }
    if ('release' in source && build.version !== source.release) {
      throw new ServiceError(`npm installed ${SERVER_PACKAGE} ${build.version}, not ${source.release}.`);
    }
    if (!/^[0-9A-Za-z.+-]+$/.test(build.version)) {
      throw new ServiceError(`${SERVER_PACKAGE} has an unusable version "${build.version}".`);
    }
    const started = await run(node, [script, '--version'], env, 60_000);
    if (!started.ok || started.stdout.trim() !== build.version) {
      throw new ServiceError(`The installed stim-server does not run with ${node}:\n${lastLines(started.stderr)}`);
    }
    writeFileSync(
      join(staging, 'install.json'),
      `${JSON.stringify(
        {
          version: build.version,
          stimBuild: build.stimBuild,
          serverBuild: serverDigest,
          ...('release' in source
            ? { release: source.release, registry: REGISTRY, integrity: installedIntegrity(staging) }
            : { files }),
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    const dir = join(versions, `${build.version}-${build.stimBuild}-${serverDigest}`);
    if (!existsSync(dir)) renameSync(staging, dir);
    return { script: join(dir, ...SERVER_SCRIPT), build, dir };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function waitForIdle(port: number, log: (line: string) => void): Promise<void> {
  const deadline = Date.now() + IDLE_WAIT_MS;
  let said = '';
  for (;;) {
    const health = await fetchHealth(port);
    const busy = health?.busy;
    if (health && !busy) {
      log('This stim-server does not report its running builds, so the restart does not wait for them.');
    }
    if (!busy || busy.builds + busy.hostedSessions === 0) return;
    const work = `${busy.builds} offloaded build(s) and ${busy.hostedSessions} hosted session(s)`;
    if (Date.now() >= deadline) {
      throw new ServiceError(
        `stim-server still runs ${work} after ${IDLE_WAIT_MS / 60_000} minutes; not restarting it. Run this again later.`,
      );
    }
    if (work !== said) log(`Waiting for ${work} to finish.`);
    said = work;
    await sleep(IDLE_POLL_MS);
  }
}

async function waitForBuild(label: string, port: number, expected: ServerBuild): Promise<boolean> {
  const deadline = Date.now() + UPDATE_HEALTH_WAIT_MS;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port);
    await requireRunning(label);
    if (answersAs(health, expected)) {
      await sleep(UPDATE_SETTLE_MS);
      const settled = await fetchHealth(port);
      await requireRunning(label);
      if (answersAs(settled, expected)) return true;
    }
    await sleep(1000);
  }
  return false;
}

async function restart(label: string, path: string, port: number): Promise<Run> {
  await unload(label, port);
  return run('launchctl', ['bootstrap', domain(), path]);
}

const SWITCH_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function holdSignal(): void {
  console.error('stim-server: finishing the switch first, so the LaunchAgent stays loaded.');
}

async function finishingOnSignals<T>(work: () => Promise<T>): Promise<T> {
  for (const signal of SWITCH_SIGNALS) process.on(signal, holdSignal);
  try {
    return await work();
  } finally {
    for (const signal of SWITCH_SIGNALS) process.off(signal, holdSignal);
  }
}

async function switchTo(
  installed: InstalledService & { script: string; port: number },
  script: string,
  expected: ServerBuild,
): Promise<void> {
  const path = plistPath(installed.label);
  const before = readFileSync(path);
  const staged = `${path}.${process.pid}.tmp`;
  copyFileSync(path, staged);
  try {
    for (const args of [
      ['-replace', 'ProgramArguments', '-json', JSON.stringify(argumentsWithScript(installed, script)), staged],
      ['-replace', 'StimService.PreviousScript', '-string', installed.script, staged],
    ]) {
      const edited = await run('plutil', args);
      if (!edited.ok) throw new ServiceError(`plutil ${args.slice(0, 2).join(' ')} failed: ${edited.stderr.trim()}`);
    }
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  await finishingOnSignals(async () => {
    let why: string;
    try {
      renameSync(staged, path);
      const started = await restart(installed.label, path, installed.port);
      if (started.ok && (await waitForBuild(installed.label, installed.port, expected))) return;
      why = started.ok
        ? `did not answer on 127.0.0.1:${installed.port} within ${UPDATE_HEALTH_WAIT_MS / 1000} s`
        : `did not start (launchctl bootstrap: ${started.stderr.trim()})`;
    } catch (error) {
      why = `could not be started: ${(error as Error).message}`;
    }
    rmSync(staged, { force: true });
    writeFileSync(path, before, { mode: 0o644 });
    let unloaded = true;
    try {
      await unload(installed.label, installed.port);
    } catch {
      unloaded = false;
    }
    let loadedAgain = false;
    if (unloaded) {
      for (const deadline = Date.now() + UNLOAD_WAIT_MS; !loadedAgain && Date.now() < deadline;) {
        loadedAgain =
          (await run('launchctl', ['bootstrap', domain(), path])).ok ||
          (await loaded(installed.label).catch(() => null)) !== null;
        if (!loadedAgain) await sleep(1000);
      }
    }
    const back = loadedAgain ? await waitForHealth(installed.port, installed.label).catch(() => null) : null;
    const previous = serverBuild(installed.script) ?? { version: back?.version ?? '', stimBuild: null };
    const answered = answersAs(back, previous);
    const answer = back
      ? `stim-server ${back.version} answers${back.startup && back.startup.state !== 'ready' ? ` (${back.startup.state})` : ''}`
      : 'nothing answers';
    throw new ServiceError(
      `${describeBuild(expected)} ${why}. ${
        answered
          ? `Switched back to ${describeBuild(previous)}.`
          : loadedAgain
            ? `Restored the previous plist, but ${answer} instead of ${describeBuild(previous)}; check ${installed.logPath ?? logPath(installed.label)}.`
            : `Restored the previous plist, but launchd did not load it; run \`launchctl bootout ${domain()}/${installed.label}\` and \`launchctl bootstrap ${domain()} ${path}\`.`
      }`,
    );
  });
}

function prune(versions: string, keep: string[]): void {
  const real = realpathSync(versions);
  for (const entry of unusedInstalls(real, readdirSync(real), keep)) {
    rmSync(join(versions, entry), { recursive: true, force: true });
  }
}

export async function holdingUpdateClaim<T>(label: string, work: () => Promise<T>): Promise<T> {
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
      `An install, update or rollback of ${label} is running (pid ${attempt.held?.owner.pid ?? 'unknown'}). Wait for it to finish.`,
    );
  }
  try {
    return await work();
  } finally {
    releaseClaim(attempt.acquired);
  }
}

function withUpdateClaim<T>(
  label: string,
  work: (installed: InstalledService & { script: string; node: string; port: number }) => Promise<T>,
): Promise<T> {
  requireMacOs();
  return holdingUpdateClaim(label, async () => {
    const installed = await requireManaged(label);
    if (!installed?.script || !installed.node || installed.port === null) {
      throw new ServiceError(`${label} is not installed. Run \`stim-server service install\` first.`);
    }
    return work({ ...installed, script: installed.script, node: installed.node, port: installed.port });
  });
}

/**
 * Installs `source` beside the server the job runs, waits for offloaded builds and hosted sessions to finish,
 * switches the job to it and restarts it, and switches back when it does not answer as the installed build. Never
 * touches pairings, approvals, the host app, `$STIM_HOME` or the serve route.
 */
export async function updateService(
  label: string,
  source: UpdateSource,
  log: (line: string) => void,
): Promise<string[]> {
  requireMacOs();
  if (!existsSync(plistPath(label))) throw new ServiceError(`${label} is not installed.`);
  return withUpdateClaim(label, (installed) => updateInstalledService(label, installed, source, log));
}

export async function updateInstalledService(
  label: string,
  installed: InstalledService & { script: string; node: string; port: number },
  source: UpdateSource,
  log: (line: string) => void,
): Promise<string[]> {
  const at = new Date().toISOString();
  try {
    const notes = await switchToSource(label, installed, source, log);
    recordOutcome(label, { at, target: describeSource(source), ok: true, message: notes[0]! });
    return notes;
  } catch (error) {
    recordOutcome(label, { at, target: describeSource(source), ok: false, message: (error as Error).message });
    throw error;
  }
}

async function switchToSource(
  label: string,
  installed: InstalledService & { script: string; node: string; port: number },
  source: UpdateSource,
  log: (line: string) => void,
): Promise<string[]> {
  const versions = join(serviceRoot(label), 'versions');
  const target = await installServer(versions, source, installed.node, log);
  if (sameFile(installed.script, target.script)) {
    return [`${label} already runs ${describeBuild(target.build)}.`];
  }
  await waitForIdle(installed.port, log);
  log(`Switching ${label} to ${describeBuild(target.build)}.`);
  const script = realpathSync(target.script);
  await switchTo(installed, script, target.build);
  prune(versions, [script, installed.script]);
  const flag = label === DEFAULT_LABEL ? '' : ` --label ${label}`;
  return [
    `${label} now runs ${describeBuild(target.build)} from ${target.dir}.`,
    `The previous server stays installed: ${installed.script}. \`stim-server service rollback${flag}\` switches back to it.`,
  ];
}

/** Switches the job back to the server it ran before the last update or rollback, under the same checks. */
export async function rollbackService(label: string, log: (line: string) => void): Promise<string[]> {
  requireMacOs();
  if (!existsSync(plistPath(label))) throw new ServiceError(`${label} is not installed.`);
  return withUpdateClaim(label, async (installed) => {
    const previous = installed.previousScript;
    if (!previous) throw new ServiceError(`${label} has no previous server; \`service update\` records one.`);
    const build = existsSync(previous) ? serverBuild(previous) : null;
    if (!build) throw new ServiceError(`The previous server ${previous} is no longer installed.`);
    const at = new Date().toISOString();
    try {
      await waitForIdle(installed.port, log);
      log(`Switching ${label} back to ${describeBuild(build)}.`);
      await switchTo(installed, previous, build);
    } catch (error) {
      recordOutcome(label, { at, target: 'rollback', ok: false, message: (error as Error).message });
      throw error;
    }
    const message = `${label} now runs ${describeBuild(build)} again: ${previous}.`;
    recordOutcome(label, { at, target: 'rollback', ok: true, message });
    return [message];
  });
}
