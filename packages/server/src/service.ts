import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { stimBuildDigest } from '@stim-cli/core/state';
import {
  parseInstalledPlist,
  parseLaunchctlPrint,
  planServe,
  renderPlist,
  ServiceError,
  type InstalledService,
  type LaunchdJob,
  type ServeRecord,
  type ServiceSpec,
} from './service-plist.ts';
import { hostPermissionPanes, installHostApp, requestHostPermissions } from './stim-host.ts';
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

function run(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout: LAUNCHCTL_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8' },
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
function stableNode(pathEnv: string | undefined): string {
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

/** Boots the job out and waits until launchd forgets it and its process has exited, so the port is free. */
async function unload(label: string): Promise<void> {
  const job = await loaded(label);
  if (!job) return;
  const stopped = await run('launchctl', ['bootout', `${domain()}/${label}`]);
  const deadline = Date.now() + UNLOAD_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await loaded(label)) && (job.pid === null || !alive(job.pid))) return;
    await sleep(250);
  }
  throw new ServiceError(`${label} did not stop within ${UNLOAD_WAIT_MS / 1000} s. ${stopped.stderr.trim()}`.trim());
}

interface Health {
  startup?: StartupState;
  host?: { name: string; screenRecording: boolean; accessibility: boolean } | null;
  version: string;
  stim: string;
  stimHome: string;
  tailscale?: { state: string; dnsName?: string | null; backendState?: string; reason?: string };
  route?: { state: string; port?: number; ports?: number[]; reason?: string };
}

async function fetchHealth(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = (await response.json()) as Partial<Health> & { server?: string };
    return body.server === 'stim-server' ? (body as Health) : null;
  } catch {
    return null;
  }
}

async function waitForHealth(port: number): Promise<Health | null> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  for (;;) {
    const health = await fetchHealth(port);
    if ((health && health.startup?.state !== 'pending') || Date.now() >= deadline) return health;
    await sleep(500);
  }
}

async function prepareRoute(
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

async function requireManaged(label: string): Promise<InstalledService | null> {
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
  const script = realpathSync(process.argv[1] ?? '');
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
  const host = await installHostApp();
  const spec: ServiceSpec = {
    host: host.executable,
    label: options.label,
    node: stableNode(process.env.PATH),
    script,
    port: options.port,
    env: options.env,
    pathPrepend: options.pathPrepend,
    environment,
    logPath: logPath(options.label),
    workingDirectory: homedir(),
    serve,
  };
  const path = plistPath(options.label);
  const tailscale = findTailscale(process.env) ?? 'tailscale';
  const oldPlist = previous ? readFileSync(path, 'utf8') : null;
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(spec.logPath), { recursive: true });

  const wasLoaded = (await loaded(options.label)) !== null;
  let routeCreated = false;
  try {
    await unload(options.label);
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
  } catch (error) {
    if (routeCreated && serve) await run(tailscale, ['serve', `--https=${serve.port}`, 'off']);
    if (oldPlist === null) {
      rmSync(path, { force: true });
      throw error;
    }
    writeFileSync(path, oldPlist, { mode: 0o644 });
    const restored = wasLoaded ? await run('launchctl', ['bootstrap', domain(), path]) : null;
    if (restored && !restored.ok && !(await loaded(options.label))) {
      throw new ServiceError(
        `${(error as Error).message} The previous service could not be restarted either (${restored.stderr.trim()}); run install again.`,
      );
    }
    throw error;
  }

  const notes = [`Installed ${options.label}: ${path}`, `Log: ${spec.logPath}`];
  const health = await waitForHealth(options.port);
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
  lines.push(`  node: ${status.node}`, `  server: ${status.script}`, `  log: ${status.logPath}`);
  if (status.pathPrepend.length) lines.push(`  path-prepend: ${status.pathPrepend.join(delimiter)}`);
  if (status.envNames.length) lines.push(`  env: ${status.envNames.join(', ')}`);
  lines.push(`  plist: ${status.plist}`);
  return lines;
}

export async function uninstallService(label: string): Promise<string[]> {
  requireMacOs();
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
  await unload(label);
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
