import { delimiter, isAbsolute } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import type { ServeRoute } from './tailscale.ts';

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

/** Returns the first problem in the `--env` and `--path-prepend` values, or null when both are usable. */
export function validateServeEnvironment(env: string[], pathPrepend: string[]): string | null {
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

/** The LaunchAgent plist for `spec`. `StimService` is inert to launchd; `service status` and `uninstall` read it back. */
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
    ...[spec.node, spec.script, ...serverArguments(spec)].map((argument) => string(argument, '\t\t')),
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
  if (spec.serve) {
    lines.push(
      key('StimService', '\t'),
      '\t<dict>',
      key('ServePort', '\t\t'),
      `\t\t<integer>${spec.serve.port}</integer>`,
      key('ServeCreated', '\t\t'),
      spec.serve.created ? '\t\t<true/>' : '\t\t<false/>',
      '\t</dict>',
    );
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

export interface InstalledService {
  label: string;
  node: string | null;
  script: string | null;
  port: number | null;
  env: string[];
  pathPrepend: string[];
  stimHome: string | null;
  logPath: string | null;
  serve: ServeRecord | null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Reads `plutil -convert json` output of a plist `renderPlist` wrote. */
export function parseInstalledPlist(value: unknown): InstalledService | null {
  if (!isJsonObject(value) || typeof value.Label !== 'string') return null;
  const [node = null, script = null, ...args] = strings(value.ProgramArguments);
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
    node,
    script,
    port: Number.isInteger(port) ? port : null,
    env,
    pathPrepend,
    stimHome: typeof environment.STIM_HOME === 'string' ? environment.STIM_HOME : null,
    logPath: typeof value.StandardOutPath === 'string' ? value.StandardOutPath : null,
    serve:
      typeof servePort === 'number' && Number.isInteger(servePort)
        ? { port: servePort, created: meta.ServeCreated === true }
        : null,
  };
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
