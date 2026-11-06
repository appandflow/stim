import { delimiter, isAbsolute } from 'node:path';
import { isJsonObject, type InstalledService } from '@stim-cli/core/state';
import type { ServeRecord } from '@stim-cli/transport-tailscale';

export class ServiceError extends Error {}

export const DEFAULT_LABEL = 'dev.stim.server';
export const DEFAULT_PORT = 7787;
export const THROTTLE_SECONDS = 30;

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JOB_KEYS = ['STIM_HOME', 'SHELL'];

export { planServe, type ServeRecord } from '@stim-cli/transport-tailscale';
export {
  installedService,
  parseInstalledPlist,
  parseLaunchctlPrint,
  type InstalledService,
} from '@stim-cli/core/state';

export interface ServiceSpec {
  label: string;
  host: string | null;
  node: string;
  script: string;
  /** The engine store's `bin/stimd` shim, which a LaunchAgent names instead of `node` and `script` when it exists. */
  stimd?: string;
  port: number;
  /** `KEY=VALUE` entries and directories the server applies after it reads the login shell's environment. The plist keeps the values in `EnvironmentVariables`, not in the server's arguments. */
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

/**
 * Returns the first problem in the `--env` and `--path-prepend` values, or null when both are usable. `serving` also
 * accepts a bare `KEY`, which the serving command reads from its own environment, and tolerates `STIM_HOME` and
 * `SHELL`, which a plist written by an earlier release can carry and `applyServeEnvironment` ignores.
 */
export function validateServeEnvironment(env: string[], pathPrepend: string[], serving = false): string | null {
  if ([...env, ...pathPrepend].some(illegal)) {
    return '--env and --path-prepend values cannot contain control characters.';
  }
  for (const entry of env) {
    const parsed = serving && ENV_KEY_PATTERN.test(entry) ? { key: entry } : parseEnvAssignment(entry);
    if (typeof parsed === 'string') return parsed;
    if (!serving && JOB_KEYS.includes(parsed.key)) {
      return `--env cannot set ${parsed.key}; start stim serve with ${parsed.key} set instead.`;
    }
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
 * replaces the process environment, so they survive it. A bare `KEY` entry takes its value from `source`, the
 * environment launchd gave the process; one that `source` lacks is skipped with a line on stderr. `STIM_HOME` and
 * `SHELL` entries are skipped the same way: the job takes them from the installing process.
 */
export function applyServeEnvironment(
  base: NodeJS.ProcessEnv,
  env: string[],
  pathPrepend: string[],
  source: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = console.error,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...base };
  for (const entry of env) {
    const parsed = parseEnvAssignment(entry);
    const name = typeof parsed === 'string' ? entry : parsed.key;
    if (JOB_KEYS.includes(name)) {
      warn(`stim-server: ignoring --env ${name}; the service takes it from the process that installed it.`);
    } else if (typeof parsed !== 'string') {
      result[name] = parsed.value;
    } else if (ENV_KEY_PATTERN.test(entry)) {
      const value = source[entry];
      if (value === undefined)
        warn(`stim-server: --env ${entry} has no value in the service environment; skipping it.`);
      else result[entry] = value;
    }
  }
  if (pathPrepend.length) {
    result.PATH = [...pathPrepend, ...(result.PATH ? [result.PATH] : [])].join(delimiter);
  }
  return result;
}

export function environmentValues(env: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const entry of env) {
    const parsed = parseEnvAssignment(entry);
    if (typeof parsed !== 'string' && !JOB_KEYS.includes(parsed.key)) values.set(parsed.key, parsed.value);
  }
  return values;
}

/** `env` as the plist stores it: one `KEY=VALUE` per key, the last value winning, without the keys the job supplies. */
export function normalizeEnv(env: string[]): string[] {
  return [...environmentValues(env)].map(([name, value]) => `${name}=${value}`);
}

export function serverArguments(spec: Pick<ServiceSpec, 'port' | 'env' | 'pathPrepend'>): string[] {
  return [
    'serve',
    '--service',
    '--port',
    String(spec.port),
    ...[...environmentValues(spec.env).keys()].flatMap((name) => ['--env', name]),
    ...spec.pathPrepend.flatMap((dir) => ['--path-prepend', dir]),
  ];
}

/** What a LaunchAgent runs after its host app: the `bin/stimd` shim with the server's options, else node and script. */
export function launchdArguments(
  spec: Pick<ServiceSpec, 'node' | 'script' | 'stimd' | 'port' | 'env' | 'pathPrepend'>,
): string[] {
  const args = serverArguments(spec);
  return spec.stimd ? [spec.stimd, ...args.slice(1)] : [spec.node, spec.script, ...args];
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const string = (value: string, indent: string) => `${indent}<string>${escapeXml(value)}</string>`;
const key = (name: string, indent: string) => `${indent}<key>${name}</key>`;

/**
 * `plist`, a LaunchAgent `renderPlist` wrote, with its `ProgramArguments` replaced by `programArguments`; every other
 * key, such as the job's environment, stays as written.
 */
export function withProgramArguments(plist: string, programArguments: string[]): string {
  return plist.replace(
    /(<key>ProgramArguments<\/key>\s*<array>)[\s\S]*?(\n\t<\/array>)/,
    (_match, open: string, close: string) =>
      `${open}\n${programArguments.map((argument) => string(argument, '\t\t')).join('\n')}${close}`,
  );
}

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
    ...[...(spec.host ? [spec.host, 'run'] : []), ...launchdArguments(spec)].map((argument) =>
      string(argument, '\t\t'),
    ),
    '\t</array>',
  ];
  const environment = new Map(Object.entries(spec.environment));
  for (const [name, value] of environmentValues(spec.env)) environment.set(name, value);
  if (environment.size) {
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

/** The job's `ProgramArguments` with the server script, which follows the launcher, `run` and node, set to `script`. */
export function argumentsWithScript(
  service: Pick<InstalledService, 'host' | 'programArguments'>,
  script: string,
): string[] {
  const index = service.host ? 3 : 1;
  return service.programArguments.map((argument, at) => (at === index ? script : argument));
}

const parseVersion = (v: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(v);

export function compareVersions(a: string, b: string): number {
  const aa = parseVersion(a),
    bb = parseVersion(b);
  if (!aa || !bb) throw new ServiceError(`Cannot compare stim-server versions ${a} and ${b}.`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(aa[i]) - Number(bb[i]);
    if (diff) return diff;
  }
  if (!aa[4] || !bb[4]) return aa[4] ? -1 : bb[4] ? 1 : 0;
  const ap = aa[4].split('.'),
    bp = bb[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i],
      y = bp[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    if (/^\d+$/.test(x) !== /^\d+$/.test(y)) return /^\d+$/.test(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
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

const packageNames = (entries: unknown[]) =>
  entries.map((entry) => (isJsonObject(entry) ? `${String(entry.name)}@${String(entry.version)}` : '?')).join(', ');

export const lastLines = (text: string): string => text.trim().split('\n').slice(-8).join('\n');

/**
 * Why `npm audit signatures --json` output does not vouch for every installed package, or null when it does. When npm
 * fails it prints `{"error":{"summary","detail"}}` on stdout, or only text on stderr; the message carries that error.
 */
export function signatureProblem(output: string, stderr = ''): string | null {
  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    report = null;
  }
  if (isJsonObject(report) && isJsonObject(report.error)) {
    const { summary, detail } = report.error;
    const text = [summary, detail].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
    if (text.length) return `npm audit signatures failed: ${text.map((part) => part.trim()).join(' ')}`;
  }
  if (!isJsonObject(report) || !Array.isArray(report.invalid) || !Array.isArray(report.missing)) {
    const error = lastLines(stderr);
    return `npm audit signatures did not print a JSON report${error ? `:\n${error}` : ''}`;
  }
  if (report.invalid.length)
    return `npm found invalid registry signatures or attestations: ${packageNames(report.invalid)}`;
  if (report.missing.length) return `npm found packages without registry signatures: ${packageNames(report.missing)}`;
  return null;
}
