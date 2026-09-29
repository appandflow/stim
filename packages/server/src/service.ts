import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { stimBuildDigest } from '@stim-cli/core/state';
import {
  parseInstalledPlist,
  parseLaunchctlPrint,
  planServe,
  renderPlist,
  type InstalledService,
  type LaunchdJob,
  type ServeRecord,
  type ServiceSpec,
} from './service-plist.ts';
import { findTailscale, serveCommand, serveRoute, tailscaleStatus } from './tailscale.ts';

const LAUNCHCTL_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_WAIT_MS = 15_000;
const UNLOAD_WAIT_MS = 15_000;

export class ServiceError extends Error {}

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
  return printed.ok ? parseLaunchctlPrint(printed.stdout) : null;
}

async function readInstalled(label: string): Promise<InstalledService | null> {
  const path = plistPath(label);
  if (!existsSync(path)) return null;
  const converted = await run('plutil', ['-convert', 'json', '-o', '-', path]);
  if (!converted.ok) throw new ServiceError(`Could not read ${path}: ${converted.stderr.trim()}`);
  return parseInstalledPlist(JSON.parse(converted.stdout));
}

async function unload(label: string): Promise<void> {
  if (!(await loaded(label))) return;
  await run('launchctl', ['bootout', `${domain()}/${label}`]);
  const deadline = Date.now() + UNLOAD_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await loaded(label))) return;
    await sleep(250);
  }
  throw new ServiceError(`launchd still lists ${label} after bootout; retry in a moment.`);
}

interface Health {
  version: string;
  stim: string;
  stimHome: string;
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
    if (health || Date.now() >= deadline) return health;
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

export async function installService(options: ServiceOptions): Promise<string[]> {
  requireMacOs();
  const script = realpathSync(process.argv[1] ?? '');
  const previous = await readInstalled(options.label);
  const notes: string[] = [];
  let serve: ServeRecord | null = previous?.serve ?? null;
  let createRoute: string[] | null = null;
  if (options.serve) {
    const prepared = await prepareRoute(options.port, previous);
    serve = prepared.record;
    createRoute = prepared.create;
  }
  const environment: Record<string, string> = {};
  if (process.env.STIM_HOME) environment.STIM_HOME = process.env.STIM_HOME;
  if (process.env.SHELL) environment.SHELL = process.env.SHELL;
  const spec: ServiceSpec = {
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
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(spec.logPath), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, renderPlist(spec), { mode: 0o644 });
  renameSync(partial, path);

  await unload(options.label);
  let routeCreated = false;
  if (createRoute) {
    const made = await run(findTailscale(process.env) ?? 'tailscale', createRoute);
    if (!made.ok) throw new ServiceError(`\`tailscale ${createRoute.join(' ')}\` failed: ${made.stderr.trim()}`);
    routeCreated = true;
  }
  const started = await run('launchctl', ['bootstrap', domain(), path]);
  if (!started.ok) {
    if (routeCreated && serve)
      await run(findTailscale(process.env) ?? 'tailscale', ['serve', `--https=${serve.port}`, 'off']);
    throw new ServiceError(`launchctl bootstrap failed: ${started.stderr.trim()}`);
  }

  notes.push(`Installed ${options.label}: ${path}`);
  notes.push(`Log: ${spec.logPath}`);
  const health = await waitForHealth(options.port);
  notes.push(
    health
      ? `stim-server ${health.version} answers on 127.0.0.1:${options.port}.`
      : `stim-server does not answer on 127.0.0.1:${options.port} yet. Its start reads the login shell's environment and can take a minute; run \`stim-server service status --label ${options.label}\` to check.`,
  );
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
  health: { version: string; stim: string; stimHome: string; route: string | null } | null;
  serve: ServeRecord | null;
  logPath: string | null;
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
      ? { version: health.version, stim: health.stim, stimHome: health.stimHome, route: routeText(health.route) }
      : null,
    serve: installed?.serve ?? null,
    logPath: installed?.logPath ?? null,
    node: installed?.node ?? null,
    script: installed?.script ?? null,
    envNames: (installed?.env ?? []).map((entry) => entry.slice(0, entry.indexOf('='))),
    pathPrepend: installed?.pathPrepend ?? [],
    stimBuild: { service, cli, match: service && cli ? service === cli : null },
  };
}

function routeText(route: Health['route']): string | null {
  if (!route) return null;
  if (route.state === 'routed') return `routed on https port ${route.port}`;
  if (route.state === 'funneled') return `FUNNELED on port ${route.ports?.join(', ')}: public`;
  return route.reason ? `${route.state} (${route.reason})` : route.state;
}

export function statusLines(status: ServiceStatus): string[] {
  if (!status.installed) {
    return [`${status.label} is not installed (no ${status.plist}).${status.loaded ? ' launchd still lists it.' : ''}`];
  }
  const lines = [
    `${status.label}: ${status.loaded ? `${status.state}${status.pid ? ` (pid ${status.pid})` : ''}` : 'installed but not loaded'}`,
  ];
  if (status.runs !== null)
    lines.push(`  runs: ${status.runs}${status.lastExitCode ? `, last exit ${status.lastExitCode}` : ''}`);
  lines.push(`  port: ${status.port}`);
  lines.push(
    status.health
      ? `  health: ok, stim-server ${status.health.version}, stim ${status.health.stim}, stim home ${status.health.stimHome}`
      : `  health: no answer on 127.0.0.1:${status.port}`,
  );
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
  lines.push(`  node: ${status.node}`, `  server: ${status.script}`, `  log: ${status.logPath}`);
  if (status.pathPrepend.length) lines.push(`  path-prepend: ${status.pathPrepend.join(delimiter)}`);
  if (status.envNames.length) lines.push(`  env: ${status.envNames.join(', ')}`);
  lines.push(`  plist: ${status.plist}`);
  return lines;
}

export async function uninstallService(label: string): Promise<string[]> {
  requireMacOs();
  const installed = await readInstalled(label);
  const job = await loaded(label);
  if (!installed && !job) return [`${label} is not installed.`];
  const notes: string[] = [];
  await unload(label);
  if (installed?.serve?.created && installed.port !== null) {
    const binary = findTailscale(process.env);
    const status = tailscaleStatus(binary, process.env);
    const route = status.state === 'running' ? await serveRoute(binary, process.env, installed.port, status.ips) : null;
    if (binary && route?.state === 'routed' && route.port === installed.serve.port) {
      const removed = await run(binary, ['serve', `--https=${installed.serve.port}`, 'off']);
      notes.push(
        removed.ok
          ? `Removed the tailscale serve route on https port ${installed.serve.port}.`
          : `Could not remove the tailscale serve route: ${removed.stderr.trim()}. Run \`tailscale serve --https=${installed.serve.port} off\`.`,
      );
    } else {
      notes.push(
        `The tailscale serve route on https port ${installed.serve.port} no longer points here; left as it is.`,
      );
    }
  } else if (installed?.serve) {
    notes.push(`Kept the tailscale serve route on https port ${installed.serve.port}; install did not create it.`);
  }
  rmSync(plistPath(label), { force: true });
  notes.unshift(
    `Uninstalled ${label}. Pairings, stim home and the log ${installed?.logPath ?? logPath(label)} are kept.`,
  );
  return notes;
}
