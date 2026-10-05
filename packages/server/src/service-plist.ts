import { delimiter, isAbsolute, join, relative } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import type { ServeRoute } from './tailscale.ts';

export class ServiceError extends Error {}

export const DEFAULT_LABEL = 'dev.stim.server';
export const DEFAULT_PORT = 7787;
const THROTTLE_SECONDS = 30;

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ServeRecord {
  port: number;
  /** Whether `service install` created the `tailscale serve` route, so `uninstall` removes it. */
  created: boolean;
}

export interface ServiceSpec {
  label: string;
  host: string | null;
  node: string;
  script: string;
  port: number;
  /** `KEY=VALUE` entries and directories the server applies after it reads the login shell's environment. */
  env: string[];
  pathPrepend: string[];
  /** Variables of the launchd job itself: `STIM_HOME` and `SHELL` of the installing process. */
  environment: Record<string, string>;
  logPath: string;
  workingDirectory: string;
  serve: ServeRecord | null;
}

export function validateLabel(label: string): string | null {
  return LABEL_PATTERN.test(label) ? null : `--label must be letters, digits, ".", "_" or "-", got "${label}".`;
}

export function validatePort(value: string): number | string {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : `--port must be a port number, got ${value}.`;
}

export function parseEnvAssignment(entry: string): { key: string; value: string } | string {
  const equals = entry.indexOf('=');
  const key = equals === -1 ? entry : entry.slice(0, equals);
  if (equals === -1 || !ENV_KEY_PATTERN.test(key)) {
    return `--env takes KEY=VALUE with a name of letters, digits and "_", got "${entry}".`;
  }
  return { key, value: entry.slice(equals + 1) };
}

const illegal = (value: string) =>
  [...value].some((char) => {
    const code = char.codePointAt(0)!;
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
  });

/** Returns the first problem in the `--env` and `--path-prepend` values, or null when both are usable. */
export function validateServeEnvironment(env: string[], pathPrepend: string[]): string | null {
  if ([...env, ...pathPrepend].some(illegal)) {
    return '--env and --path-prepend values cannot contain control characters.';
  }
  for (const entry of env) {
    const parsed = parseEnvAssignment(entry);
    if (typeof parsed === 'string') return parsed;
    if (parsed.key === 'STIM_HOME') return '--env cannot set STIM_HOME; start stim-server with STIM_HOME set instead.';
  }
  for (const dir of pathPrepend) {
    if (!isAbsolute(dir) || dir.includes(delimiter))
      return `--path-prepend takes one absolute directory, got "${dir}".`;
  }
  return null;
}

/**
 * The environment stim-server runs with: the login shell's, then each `--env` entry, then the `--path-prepend`
 * directories in front of `PATH`, first directory first. Both flags apply after the login shell's environment
 * replaces the process environment, so they survive it.
 */
export function applyServeEnvironment(
  base: NodeJS.ProcessEnv,
  env: string[],
  pathPrepend: string[],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...base };
  for (const entry of env) {
    const parsed = parseEnvAssignment(entry);
    if (typeof parsed !== 'string') result[parsed.key] = parsed.value;
  }
  if (pathPrepend.length) {
    result.PATH = [...pathPrepend, ...(result.PATH ? [result.PATH] : [])].join(delimiter);
  }
  return result;
}

function serverArguments(spec: Pick<ServiceSpec, 'port' | 'env' | 'pathPrepend'>): string[] {
  return [
    '--port',
    String(spec.port),
    ...spec.env.flatMap((entry) => ['--env', entry]),
    ...spec.pathPrepend.flatMap((dir) => ['--path-prepend', dir]),
  ];
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const string = (value: string, indent: string) => `${indent}<string>${escapeXml(value)}</string>`;
const key = (name: string, indent: string) => `${indent}<key>${name}</key>`;

/** The LaunchAgent plist for `spec`. `StimService` is inert to launchd: it marks the job as one `install` wrote, so `install` and `uninstall` never touch another agent, and records the serve route. */
export function renderPlist(spec: ServiceSpec): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    key('Label', '\t'),
    string(spec.label, '\t'),
    key('ProgramArguments', '\t'),
    '\t<array>',
    ...[...(spec.host ? [spec.host, 'run'] : []), spec.node, spec.script, ...serverArguments(spec)].map((argument) =>
      string(argument, '\t\t'),
    ),
    '\t</array>',
  ];
  const environment = Object.entries(spec.environment);
  if (environment.length) {
    lines.push(key('EnvironmentVariables', '\t'), '\t<dict>');
    for (const [name, value] of environment) lines.push(key(name, '\t\t'), string(value, '\t\t'));
    lines.push('\t</dict>');
  }
  lines.push(
    key('WorkingDirectory', '\t'),
    string(spec.workingDirectory, '\t'),
    key('RunAtLoad', '\t'),
    '\t<true/>',
    key('KeepAlive', '\t'),
    '\t<true/>',
    key('ThrottleInterval', '\t'),
    `\t<integer>${THROTTLE_SECONDS}</integer>`,
    key('ProcessType', '\t'),
    string('Standard', '\t'),
    key('StandardOutPath', '\t'),
    string(spec.logPath, '\t'),
    key('StandardErrorPath', '\t'),
    string(spec.logPath, '\t'),
  );
  lines.push(key('StimService', '\t'), '\t<dict>', key('Managed', '\t\t'), '\t\t<true/>');
  if (spec.serve) {
    lines.push(
      key('ServePort', '\t\t'),
      `\t\t<integer>${spec.serve.port}</integer>`,
      key('ServeCreated', '\t\t'),
      spec.serve.created ? '\t\t<true/>' : '\t\t<false/>',
    );
  }
  lines.push('\t</dict>');
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

export interface InstalledService {
  label: string;
  host: string | null;
  node: string | null;
  script: string | null;
  port: number | null;
  env: string[];
  pathPrepend: string[];
  stimHome: string | null;
  logPath: string | null;
  /** Whether `install` wrote this plist. */
  managed: boolean;
  serve: ServeRecord | null;
  /** The server script the job ran before `service update` or `service rollback` switched it. */
  previousScript: string | null;
  programArguments: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Reads `plutil -convert json` output of a plist `renderPlist` wrote. */
export function parseInstalledPlist(value: unknown): InstalledService | null {
  if (!isJsonObject(value) || typeof value.Label !== 'string') return null;
  const programArguments = strings(value.ProgramArguments);
  const host =
    programArguments[1] === 'run' && programArguments[0]?.endsWith('/Contents/MacOS/stim-host')
      ? programArguments[0]
      : null;
  const [node = null, script = null, ...args] = host ? programArguments.slice(2) : programArguments;
  const env: string[] = [];
  const pathPrepend: string[] = [];
  let port: number | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const next = args[index + 1];
    if (next === undefined) break;
    if (flag === '--port') port = Number(next);
    if (flag === '--env') env.push(next);
    if (flag === '--path-prepend') pathPrepend.push(next);
  }
  const environment = isJsonObject(value.EnvironmentVariables) ? value.EnvironmentVariables : {};
  const meta = isJsonObject(value.StimService) ? value.StimService : {};
  const servePort = meta.ServePort;
  return {
    label: value.Label,
    host,
    node,
    script,
    port: Number.isInteger(port) ? port : null,
    env,
    pathPrepend,
    stimHome: typeof environment.STIM_HOME === 'string' ? environment.STIM_HOME : null,
    logPath: typeof value.StandardOutPath === 'string' ? value.StandardOutPath : null,
    managed: meta.Managed === true,
    serve:
      typeof servePort === 'number' && Number.isInteger(servePort)
        ? { port: servePort, created: meta.ServeCreated === true }
        : null,
    previousScript: typeof meta.PreviousScript === 'string' ? meta.PreviousScript : null,
    programArguments,
  };
}

/** The job's `ProgramArguments` with the server script, which follows the launcher, `run` and node, set to `script`. */
export function argumentsWithScript(
  service: Pick<InstalledService, 'host' | 'programArguments'>,
  script: string,
): string[] {
  const index = service.host ? 3 : 1;
  return service.programArguments.map((argument, at) => (at === index ? script : argument));
}

export interface LaunchdJob {
  state: string;
  pid: number | null;
  runs: number | null;
  lastExitCode: string | null;
}

/** Reads the top-level fields of `launchctl print gui/<uid>/<label>`; nested `state =` lines are indented further. */
export function parseLaunchctlPrint(output: string): LaunchdJob {
  const field = (name: string) => new RegExp(`^\\t${name} = (.+)$`, 'm').exec(output)?.[1]?.trim() ?? null;
  const number = (name: string) => {
    const text = field(name);
    return text !== null && /^\d+$/.test(text) ? Number(text) : null;
  };
  return {
    state: field('state') ?? 'unknown',
    pid: number('pid'),
    runs: number('runs'),
    lastExitCode: field('last exit code'),
  };
}

/**
 * What `install --serve` does about the node's `tailscale serve` config: refuse a Funnel route or an unreadable
 * config, keep a route that already reaches the port (remembering whether an earlier install created it), or
 * create one.
 */
export function planServe(
  route: ServeRoute,
  target: number,
  previous: ServeRecord | null,
): { record: ServeRecord; create: boolean } | { refusal: string } {
  if (route.state === 'funneled') {
    return {
      refusal: `refusing to serve. Tailscale Funnel is on for port ${route.ports.join(', ')}, which proxies to port ${target}, so it is reachable from the public internet. Remove that handler (see \`tailscale serve status\`), then run install again.`,
    };
  }
  if (route.state === 'unknown') {
    return { refusal: `could not read \`tailscale serve status --json\` (${route.reason}); not changing the route.` };
  }
  if (route.state === 'routed') {
    return { record: { port: route.port, created: previous?.port === route.port && previous.created }, create: false };
  }
  return { record: { port: route.port, created: true }, create: true };
}

const RELEASE_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateRelease(value: string): string | null {
  return RELEASE_PATTERN.test(value)
    ? null
    : `--release takes an exact stim-server version such as 1.15.0, not a range or tag; got "${value}".`;
}

/** A stim-server install: its package version and the digest of the `stim` build it runs. */
export interface ServerBuild {
  version: string;
  stimBuild: string | null;
}

/**
 * Whether a `/health` answer comes from a ready server running `expected`: the same version and, when both sides know
 * it, the same Stim build digest. Two builds of one checkout share a version, so the digest tells them apart; a server
 * older than the digest in `/health` is matched on its version alone.
 */
export function answersAs(
  health: { version: string; stimBuild?: string | null; startup?: { state: string } } | null,
  expected: ServerBuild,
): boolean {
  if (!health || health.version !== expected.version) return false;
  if (health.startup && health.startup.state !== 'ready') return false;
  return !health.stimBuild || !expected.stimBuild || health.stimBuild === expected.stimBuild;
}

const packageNames = (entries: unknown[]) =>
  entries.map((entry) => (isJsonObject(entry) ? `${String(entry.name)}@${String(entry.version)}` : '?')).join(', ');

/** Why `npm audit signatures --json` output does not vouch for every installed package, or null when it does. */
export function signatureProblem(output: string): string | null {
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    return 'npm audit signatures did not print a JSON report';
  }
  if (!isJsonObject(report) || !Array.isArray(report.invalid) || !Array.isArray(report.missing)) {
    return 'npm audit signatures did not print a JSON report';
  }
  if (report.invalid.length)
    return `npm found invalid registry signatures or attestations: ${packageNames(report.invalid)}`;
  if (report.missing.length) return `npm found packages without registry signatures: ${packageNames(report.missing)}`;
  return null;
}

/**
 * The directory an install of `build` gets: its version, the digest of its `stim` build and the digest of the server's
 * own code, so a server-only change of one version and Stim build gets a directory of its own.
 */
export function installDirName(build: ServerBuild, serverDigest: string): string {
  return `${build.version}-${build.stimBuild}-${serverDigest}`;
}

/** The entries of `versions` that hold none of the `keep` scripts, so removing them leaves both servers intact. */
export function unusedInstalls(versions: string, entries: string[], keep: string[]): string[] {
  return entries.filter((entry) =>
    keep.every((script) => {
      const inside = relative(join(versions, entry), script);
      return inside.startsWith('..') || isAbsolute(inside);
    }),
  );
}
