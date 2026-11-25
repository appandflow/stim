import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { workspaceId, type StimContext } from '@stim-cli/core';
import {
  isJsonObject,
  readServiceRecords,
  SERVICES_KEY,
  type EnvironmentState,
  type ServiceRecord,
  type WorkspaceState,
} from '@stim-cli/core/state';
import { cancellableSleep } from './cancellation.ts';
import { acquireBuildSlot, releaseBuildSlot } from './engine/build-slots.ts';
import { withDrainingCancellation } from './engine/operation-state.ts';
import { runOperationFile } from './engine/operation-exec.ts';
import { withWorkspaceProcessLock } from './engine/workspace-process-lock.ts';
import { getExecutor, isTimeoutError } from './exec.ts';
import { signalProcessTree } from './metro.ts';
import { clearNamedPorts, getNamedPort } from './named-ports.ts';
import { recordReversePort, reverseOnDevices } from './reverse-ports.ts';
import { createNdjsonWriter } from './ndjson.ts';
import { createPortProbe } from './ports.ts';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from './process-identity.ts';
import { workspaceDir, workspaceLogsDir } from './workspace/paths.ts';
import { resolveProjectSettings, settingValueAt } from './workspace/settings.ts';
import { getProject, upsertProject } from './workspace/config.ts';
import { readWorkspaceState, updateWorkspaceStateAsync } from './workspace/workspace-state.ts';
import { repoRoot } from './workspace/worktree.ts';

const START_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 1000;
const READY_COMMAND_TIMEOUT_MS = 10_000;
const PROCESS_STOP_GRACE_MS = 5000;
const OUTPUT_MAX = 4000;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_SYNTAX = /["'`\\$|;&<>()*?~#!]/;
const RESERVED_PLACEHOLDERS = new Set(['id', 'dir']);

/** A service as the project's `services` setting declares it, validated. */
export interface ServiceDefinition {
  name: string;
  cwd: string;
  envFile?: string;
  /** Named port labels, each to the environment variable that receives its number, or null. */
  ports: Record<string, string | null>;
  /** The labels among `ports` whose port is not reversed to the workspace's devices. */
  local: string[];
  idEnv: string | null;
  env: Record<string, string>;
  start: string[];
  stop?: string[];
  teardown?: string[];
  orphanTeardown?: string[];
  ready?: string[];
  /** Services started before this one and stopped after it: declared, and every service its placeholders name. */
  dependsOn: string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ServiceError extends Error {
  readonly code: 'STIM_BAD_ARG' | 'STIM_SERVICE_UNKNOWN' | 'STIM_SERVICE_FAILED';
  readonly remedy: string | null;
  constructor(message: string, code: ServiceError['code'], remedy: string | null = null) {
    super(message);
    this.code = code;
    this.remedy = remedy;
  }
}

function bad(name: string, detail: string): ServiceError {
  return new ServiceError(
    `services.${name} ${detail}`,
    'STIM_BAD_ARG',
    'Fix the services setting (stim guide services).',
  );
}

/**
 * Substitutes `{<port label>}`, `{<service>.<port label>}`, `{id}` and `{dir}` in one argv element or env value; `{{`
 * and `}}` are literal braces. Throws on any other name or an unmatched brace.
 */
export function substitute(text: string, values: Record<string, string>, where: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if ((char === '{' || char === '}') && text[i + 1] === char) {
      out += char;
      i++;
      continue;
    }
    if (char === '}') throw new Error(`${where} has an unmatched }; write }} for a literal brace.`);
    if (char !== '{') {
      out += char;
      continue;
    }
    const end = text.indexOf('}', i);
    if (end < 0) throw new Error(`${where} has an unmatched {; write {{ for a literal brace.`);
    const key = text.slice(i + 1, end);
    if (!Object.hasOwn(values, key))
      throw new Error(
        `${where} names {${key}}, which is not one of its ports, another service's {<service>.<port>}, {id} or {dir}; write {{ for a literal brace.`,
      );
    out += values[key];
    i = end;
  }
  return out;
}

function argvOf(name: string, key: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const argv = value.trim().split(/\s+/).filter(Boolean);
    if (!argv.length) throw bad(name, `.${key} is empty.`);
    if (SHELL_SYNTAX.test(value))
      throw bad(
        name,
        `.${key} is a string, which Stim splits on spaces and runs without a shell, so it refuses quotes and shell syntax: ${value}. Write it as an argv array.`,
      );
    return argv;
  }
  if (!Array.isArray(value) || !value.length || !value.every((arg) => typeof arg === 'string') || !value[0])
    throw bad(name, `.${key} must be a command: a string, or an argv array whose first entry is the program.`);
  return value;
}

function placeholders(text: string): string[] {
  return [...text.replace(/\{\{|\}\}/g, '').matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '');
}

function parseService(name: string, value: unknown): ServiceDefinition {
  if (!NAME.test(name))
    throw bad(name, 'needs a name of lowercase letters, digits and hyphens, starting with a letter.');
  if (!isJsonObject(value)) throw bad(name, 'must be an object with at least a start command.');
  const known = [
    'cwd',
    'envFile',
    'ports',
    'idEnv',
    'env',
    'start',
    'stop',
    'teardown',
    'orphanTeardown',
    'ready',
    'dependsOn',
  ];
  const unknown = Object.keys(value).find((key) => !known.includes(key));
  if (unknown) throw bad(name, `has an unknown key ${unknown}; use ${known.join(', ')}.`);
  const cwd = value.cwd ?? '.';
  if (typeof cwd !== 'string' || isAbsolute(cwd))
    throw bad(name, '.cwd must be a path relative to the workspace, inside its checkout.');
  const envFile = value.envFile;
  if (envFile !== undefined && (typeof envFile !== 'string' || isAbsolute(envFile)))
    throw bad(name, '.envFile must be a path relative to the workspace, inside its checkout.');
  const ports: Record<string, string | null> = {};
  const local: string[] = [];
  const rawPorts = value.ports ?? {};
  const entries = Array.isArray(rawPorts)
    ? rawPorts.map((label): [unknown, unknown] => [label, null])
    : isJsonObject(rawPorts)
      ? Object.entries(rawPorts)
      : null;
  if (!entries) throw bad(name, '.ports must be a list of labels or an object of labels to environment variables.');
  for (const [label, envName] of entries) {
    if (
      typeof label !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(label) ||
      label === 'metro' ||
      label === 'web-cdp'
    )
      throw bad(
        name,
        `.ports has an invalid label ${String(label)}; labels follow stim ports get and exclude metro and web-cdp.`,
      );
    if (RESERVED_PLACEHOLDERS.has(label))
      throw bad(name, `.ports cannot use the label ${label}, which is a placeholder.`);
    const spec = isJsonObject(envName) ? envName : { env: envName };
    const unknownKey = Object.keys(spec).find((key) => key !== 'env' && key !== 'reverse');
    const variable = spec.env ?? null;
    if (
      unknownKey ||
      (variable !== null && (typeof variable !== 'string' || !ENV_NAME.test(variable))) ||
      (spec.reverse !== undefined && typeof spec.reverse !== 'boolean')
    )
      throw bad(
        name,
        `.ports.${label} must be an environment variable name, null, or { "env": name, "reverse": false }.`,
      );
    ports[label] = variable;
    if (spec.reverse === false) local.push(label);
  }
  const idEnv = value.idEnv ?? null;
  if (idEnv !== null && (typeof idEnv !== 'string' || !ENV_NAME.test(idEnv)))
    throw bad(name, '.idEnv must be an environment variable name.');
  const env: Record<string, string> = {};
  if (value.env !== undefined && !isJsonObject(value.env)) throw bad(name, '.env must be an object of strings.');
  for (const [key, text] of Object.entries(value.env ?? {})) {
    if (!ENV_NAME.test(key) || typeof text !== 'string') throw bad(name, `.env.${key} must be a string variable.`);
    env[key] = text;
  }
  const start = argvOf(name, 'start', value.start);
  if (!start) throw bad(name, 'needs a start command.');
  const dependsOn = value.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || !dependsOn.every((each) => typeof each === 'string'))
    throw bad(name, '.dependsOn must be a list of service names.');
  const definition: ServiceDefinition = { name, cwd, ports, local, idEnv, env, start, dependsOn: [...dependsOn] };
  if (envFile !== undefined) definition.envFile = envFile;
  for (const key of ['stop', 'teardown', 'orphanTeardown', 'ready'] as const) {
    const argv = argvOf(name, key, value[key]);
    if (argv) definition[key] = argv;
  }
  if (!definition.stop && (definition.teardown || definition.orphanTeardown))
    throw bad(
      name,
      'declares a teardown without a stop command; a service without one is a process Stim stops by signal.',
    );
  return definition;
}

/** The services the workspace's settings declare, in declaration order. */
export function declaredServicesFrom(settings: Parameters<typeof settingValueAt>[0]): ServiceDefinition[] {
  const all = settingValueAt(settings, 'services');
  if (all === undefined) return [];
  if (!isJsonObject(all)) throw bad('', 'must be an object of services by name.');
  const definitions = Object.entries(all).map(([name, value]) => parseService(name, value));
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const owners = new Map<string, string>();
  for (const { name, ports } of definitions)
    for (const label of Object.keys(ports)) {
      const other = owners.get(label);
      if (other) throw bad(name, `.ports names ${label}, which ${other} also owns.`);
      owners.set(label, name);
    }
  for (const definition of definitions) {
    const { name } = definition;
    const sample: Record<string, string> = {};
    for (const key of [...Object.keys(definition.ports), ...RESERVED_PLACEHOLDERS]) sample[key] = '';
    for (const other of definitions)
      if (other !== definition) for (const label of Object.keys(other.ports)) sample[`${other.name}.${label}`] = '';
    const texts: [string, string][] = [
      ...Object.entries(definition.env).map(([key, text]): [string, string] => [`services.${name}.env.${key}`, text]),
      ...(['start', 'stop', 'teardown', 'orphanTeardown', 'ready'] as const).flatMap((key) =>
        (definition[key] ?? []).map((arg): [string, string] => [`services.${name}.${key}`, arg]),
      ),
    ];
    try {
      for (const [where, text] of texts) substitute(text, sample, where);
    } catch (error) {
      throw new ServiceError(messageOf(error), 'STIM_BAD_ARG', 'Fix the services setting (stim guide services).');
    }
    for (const dependency of definition.dependsOn)
      if (!byName.has(dependency) || dependency === name)
        throw bad(name, `.dependsOn names ${dependency}, which is not another declared service.`);
    const referenced = texts.flatMap(([, text]) => placeholders(text)).filter((key) => key.includes('.'));
    for (const key of referenced) {
      const service = key.slice(0, key.indexOf('.'));
      if (!definition.dependsOn.includes(service)) definition.dependsOn.push(service);
    }
  }
  startOrder(definitions, definitions);
  return definitions;
}

/** `selected` and every service they depend on, dependencies first; throws on a cycle. */
export function startOrder(definitions: ServiceDefinition[], selected: ServiceDefinition[]): ServiceDefinition[] {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const order: ServiceDefinition[] = [];
  const visiting: string[] = [];
  const visit = (definition: ServiceDefinition) => {
    if (order.includes(definition)) return;
    if (visiting.includes(definition.name))
      throw bad(
        definition.name,
        `depends on itself through ${[...visiting.slice(visiting.indexOf(definition.name)), definition.name].join(' -> ')}.`,
      );
    visiting.push(definition.name);
    for (const dependency of definition.dependsOn) {
      const next = byName.get(dependency);
      if (next) visit(next);
    }
    visiting.pop();
    order.push(definition);
  };
  for (const definition of selected) visit(definition);
  return order;
}

export function declaredServices(root: string): ServiceDefinition[] {
  return declaredServicesFrom(resolveProjectSettings(root).settings);
}

function selectServices(definitions: ServiceDefinition[], name: string | undefined): ServiceDefinition[] {
  if (name === undefined) return definitions;
  const found = definitions.filter((definition) => definition.name === name);
  if (!found.length)
    throw new ServiceError(
      `No service named ${name} is declared for this workspace${definitions.length ? `; declared: ${definitions.map((each) => each.name).join(', ')}` : ''}.`,
      'STIM_SERVICE_UNKNOWN',
      'Run stim services to list the declared services.',
    );
  return found;
}

/** The id Stim gives a service in this workspace, stable for the workspace path even once its folder is gone. */
export function serviceId(root: string, name: string): string {
  return `${name}-${workspaceId(root)}`;
}

function workspaceCwd(root: string, cwd: string, key = 'cwd'): string {
  const real = realpathSync(root);
  const checkout = realpathSync(repoRoot(real) ?? real);
  const dir = resolve(real, cwd);
  const resolved = existsSync(dir) ? realpathSync(dir) : dir;
  const inside = relative(checkout, resolved);
  if (inside.startsWith('..') || isAbsolute(inside))
    throw new ServiceError(
      `The service ${key} ${cwd} leaves the checkout ${checkout}.`,
      'STIM_BAD_ARG',
      `Point ${key} at a path inside this checkout (stim guide services).`,
    );
  return resolved;
}

async function resolveService(
  root: string,
  definition: ServiceDefinition,
  definitions: ServiceDefinition[],
  path?: string,
): Promise<Omit<ServiceRecord, 'state' | 'at'>> {
  const ports: Record<string, number> = {};
  for (const label of Object.keys(definition.ports)) ports[label] = await getNamedPort(root, label);
  const cwd = workspaceCwd(root, definition.cwd);
  const id = serviceId(root, definition.name);
  const values: Record<string, string> = {
    ...Object.fromEntries(Object.entries(ports).map(([label, port]) => [label, String(port)])),
    id,
    dir: cwd,
  };
  for (const other of definitions)
    if (definition.dependsOn.includes(other.name))
      for (const label of Object.keys(other.ports))
        values[`${other.name}.${label}`] = String(await getNamedPort(root, label));
  const env: Record<string, string> = {};
  for (const [label, envName] of Object.entries(definition.ports)) if (envName) env[envName] = String(ports[label]);
  if (definition.idEnv) env[definition.idEnv] = id;
  for (const [key, text] of Object.entries(definition.env)) env[key] = substitute(text, values, key);
  const record: Omit<ServiceRecord, 'state' | 'at'> = {
    kind: definition.stop ? 'commands' : 'process',
    cwd,
    ...(definition.envFile !== undefined ? { envFile: workspaceCwd(root, definition.envFile, 'envFile') } : {}),
    env,
    ...(path ? { path } : {}),
    dependsOn: [...definition.dependsOn],
    ports,
    reverse: Object.entries(ports).flatMap(([label, port]) => (definition.local.includes(label) ? [] : [port])),
    start: definition.start.map((arg) => substitute(arg, values, 'start')),
  };
  for (const key of ['stop', 'teardown', 'orphanTeardown', 'ready'] as const) {
    const argv = definition[key];
    if (argv) record[key] = argv.map((arg) => substitute(arg, values, key));
  }
  if (!definition.orphanTeardown && definition.teardown?.some((arg) => placeholders(arg).includes('id')))
    record.orphanTeardown = record.teardown;
  return record;
}

/** The variables of the declared services as the current settings resolve them, allocating their ports: `stim services env`. */
export async function servicesEnv(root: string, name?: string): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  const definitions = declaredServices(root);
  for (const definition of selectServices(definitions, name))
    out[definition.name] = (await resolveService(root, definition, definitions)).env;
  return out;
}

function withServicesLock<T>(root: string, fn: () => Promise<T>, signal?: AbortSignal, waitMs?: number): Promise<T> {
  return withWorkspaceProcessLock(workspaceDir(root), 'services', fn, {
    external: true,
    signal,
    ...(waitMs === undefined ? {} : { waitMs }),
  });
}

async function writeRecord(root: string, name: string, record: ServiceRecord | null): Promise<void> {
  await updateWorkspaceStateAsync(root, (state: WorkspaceState) => {
    const all = { ...readServiceRecords(state) };
    if (record) all[name] = record;
    else delete all[name];
    return { ...state, [SERVICES_KEY]: all };
  });
}

export function serviceRecords(root: string): Record<string, ServiceRecord> {
  return readServiceRecords(readWorkspaceState(root));
}

function logEvent(root: string, level: 'info' | 'warn', event: string, msg: string, fields: Record<string, unknown>) {
  const writer = createNdjsonWriter(join(workspaceLogsDir(root), 'metro.ndjson'));
  writer.write({ src: 'metro', level, event, msg, ...fields });
  writer.close();
}

/** The service process's output file, in the workspace logs. */
export function serviceLogFile(root: string, name: string): string {
  return join(workspaceLogsDir(root), `service-${name}.log`);
}

interface RunOptions {
  signal?: AbortSignal;
  operation?: StimContext;
  waitMs?: number;
}

function readEnvFile(record: Pick<ServiceRecord, 'envFile'>): NodeJS.Dict<string> {
  if (record.envFile === undefined) return {};
  try {
    return parseEnv(readFileSync(record.envFile, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error && 'code' in error ? String(error.code) : messageOf(error);
    throw new Error(`could not read envFile ${record.envFile}: ${reason}`, { cause: error });
  }
}

async function runCommand(
  root: string,
  name: string,
  kind: string,
  argv: string[],
  record: Pick<ServiceRecord, 'cwd' | 'env' | 'path' | 'envFile'>,
  cwd: string,
  timeoutMs: number,
  { signal, operation }: RunOptions,
): Promise<string | null> {
  const exec = getExecutor();
  const [program = '', ...args] = argv;
  const command = argv.join(' ');
  let output = '';
  let failure: string | null = null;
  let fileEnv: NodeJS.Dict<string> = {};
  try {
    if (kind !== 'orphan_teardown') fileEnv = readEnvFile(record);
  } catch (error) {
    failure = messageOf(error);
  }
  // @ref LLP 0027#stim-runs-only-what-it-recorded -- stimd's PATH may lack the tools the start found
  const env = { ...fileEnv, ...record.env, ...(record.path ? { PATH: record.path } : {}) };
  const file = exec.findExecutable(program, {
    cwd,
    ...(operation || record.path ? { env: { ...operation?.env, ...env } } : {}),
  });
  if (!failure && !file) failure = `${program} is not on PATH`;
  if (!failure && file) {
    try {
      output = await runOperationFile(operation, exec, file, args, {
        cwd,
        env,
        timeoutMs,
        killSignal: 'SIGKILL',
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof Error && 'reportCleanup' in error) throw error;
      signal?.throwIfAborted();
      const field = (key: string): unknown =>
        typeof error === 'object' && error !== null ? Reflect.get(error, key) : undefined;
      output = [field('stdout'), field('stderr')].filter((text) => typeof text === 'string' && text.trim()).join('\n');
      const last = output.trim().split('\n').at(-1)?.trim();
      const status = field('status');
      failure = isTimeoutError(error)
        ? `did not exit within ${timeoutMs / 1000} seconds`
        : typeof status === 'number'
          ? `exited with status ${status}${last ? `: ${last}` : ''}`
          : `failed: ${messageOf(error).split('\n')[0]}`;
    }
  }
  const tail = output.trim().slice(-OUTPUT_MAX);
  logEvent(
    root,
    failure ? 'warn' : 'info',
    `service_${kind}${failure ? '_failed' : ''}`,
    `${name}: ${command}${failure ? ` ${failure}` : ''}`,
    { service: name, command: argv, ...(tail ? { output: tail } : {}) },
  );
  const taken = /already (?:allocated|in use)|address already in use|port is already/i.test(output)
    ? '. Another workspace may hold the port or container name: give each workspace its own project name and host ports from the service env (stim guide services)'
    : '';
  return failure ? `${kind} command ${command} ${failure}${taken}` : null;
}

async function listening(ports: readonly number[], isFree = createPortProbe()): Promise<number[]> {
  const taken: number[] = [];
  for (const port of ports) if (!(await isFree(port).catch(() => false))) taken.push(port);
  return taken;
}

function processLives(record: ServiceRecord, alive: readonly string[]): boolean {
  if (!record.process) return false;
  const status = inspectProcessIdentity(record.process);
  return alive.includes(status) || (status === 'gone' && groupAlive(record.process.pid));
}

/**
 * Whether the service runs, without starting anything: a supervised process by its captured identity, a commands
 * service by a listener on one of its ports, else by its record.
 */
export async function serviceRunning(
  record: ServiceRecord,
  isFree?: (port: number) => Promise<boolean>,
): Promise<boolean> {
  if (record.kind === 'process') return processLives(record, ['same']);
  const ports = Object.values(record.ports);
  if (record.state !== 'running') return false;
  return !ports.length || (await listening(ports, isFree)).length > 0;
}

/** Sets what `stim status` shows of the services recorded in a workspace state; it starts nothing and reads one TCP table. */
export async function applyServiceStatuses(target: EnvironmentState, state: WorkspaceState | null): Promise<void> {
  const records = Object.entries(readServiceRecords(state));
  if (!records.length) return;
  const isFree = createPortProbe();
  const out: NonNullable<EnvironmentState['services']> = [];
  for (const [name, record] of records)
    out.push({
      name,
      running: await serviceRunning(record, isFree),
      ports: record.ports,
      stoppedBy: record.state === 'stopped' ? (record.stoppedBy ?? null) : null,
      ...(record.teardownFailure ? { teardownFailure: record.teardownFailure } : {}),
    });
  target.services = out;
}

async function ready(
  root: string,
  name: string,
  record: ServiceRecord,
  options: RunOptions,
  timeoutMs = READY_COMMAND_TIMEOUT_MS,
): Promise<boolean> {
  if (record.ready)
    return (await runCommand(root, name, 'ready', record.ready, record, record.cwd, timeoutMs, options)) === null;
  const ports = Object.values(record.ports);
  if (ports.length) return (await listening(ports)).length === ports.length;
  return serviceRunning(record);
}

async function waitReady(
  root: string,
  name: string,
  record: ServiceRecord,
  options: RunOptions,
  freshStart = false,
): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  if (freshStart && record.kind === 'process' && !record.ready && !Object.keys(record.ports).length)
    await cancellableSleep(Math.min(READY_POLL_MS, deadline - Date.now()), {
      signal: options.signal,
      what: `service ${name} readiness`,
    });
  for (;;) {
    options.signal?.throwIfAborted();
    if (
      await ready(root, name, record, options, Math.max(1, Math.min(READY_COMMAND_TIMEOUT_MS, deadline - Date.now())))
    )
      return true;
    if (record.kind === 'process' && !(await serviceRunning(record))) return false;
    if (Date.now() >= deadline) return false;
    await cancellableSleep(Math.min(READY_POLL_MS, deadline - Date.now()), {
      signal: options.signal,
      what: `service ${name} readiness`,
    });
    if (Date.now() >= deadline) return false;
  }
}

function logTail(root: string, name: string): string {
  try {
    const lines = readFileSync(serviceLogFile(root, name), 'utf8').trim().split('\n').slice(-5).join(' | ');
    return lines ? ` Last output: ${lines}` : '';
  } catch {
    return '';
  }
}

async function spawnProcess(root: string, name: string, record: ServiceRecord, operation: StimContext | undefined) {
  if (!operation) throw new Error('a supervised service starts only from a Stim command');
  const [program = '', ...args] = record.start;
  const env = {
    ...operation.env,
    ...readEnvFile(record),
    ...record.env,
    ...(record.path ? { PATH: record.path } : {}),
  };
  const file = getExecutor().findExecutable(program, { cwd: record.cwd, env });
  if (!file) throw new Error(`${program} is not on PATH`);
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  const fd = openSync(serviceLogFile(root, name), 'a');
  try {
    const child = getExecutor().spawn(file, args, { cwd: record.cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => {});
    child.unref();
    if (child.pid === undefined) throw new Error(`${record.start.join(' ')} did not start`);
    const identity = captureProcessIdentity(child.pid);
    if (!identity.ok) {
      child.kill('SIGKILL');
      throw new Error(`cannot identify pid ${child.pid}: ${identity.reason}.${logTail(root, name)}`);
    }
    return { pid: child.pid, processToken: identity.token };
  } finally {
    closeSync(fd);
  }
}

function groupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

async function groupExited(pid: number, ms: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, 100));
    signal?.throwIfAborted();
  }
  return true;
}

// @ref LLP 0027#a-service-without-a-stop-command-is-a-process -- signalled by captured identity, never a bare pid
async function stopProcess(record: ServiceRecord, signal?: AbortSignal): Promise<string | null> {
  const proc = record.process;
  if (!proc) return null;
  const status = inspectProcessIdentity(proc);
  if (status === 'unknown') return `the identity of pid ${proc.pid} cannot be verified`;
  if (status === 'different') return null;
  // @ref LLP 0027#a-service-without-a-stop-command-is-a-process -- a live group keeps its leader's pid from reuse
  if (status === 'gone' && !groupAlive(proc.pid)) return null;
  try {
    signalProcessTree(proc.pid, 'SIGTERM', { group: true });
    const leader = await waitForProcessExit(proc, PROCESS_STOP_GRACE_MS, signal);
    if (leader && (await groupExited(proc.pid, PROCESS_STOP_GRACE_MS, signal))) return null;
    if (!leader && inspectProcessIdentity(proc) !== 'same' && !groupAlive(proc.pid)) return null;
    signalProcessTree(proc.pid, 'SIGKILL', { group: true });
    if (!(await waitForProcessExit(proc, PROCESS_STOP_GRACE_MS, signal))) return `pid ${proc.pid} did not exit`;
    if (!(await groupExited(proc.pid, PROCESS_STOP_GRACE_MS, signal)))
      return `processes of the group of pid ${proc.pid} did not exit`;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) return messageOf(error);
  }
  return null;
}

async function mayStillRun(record: ServiceRecord): Promise<boolean> {
  if (record.kind === 'process') return processLives(record, ['same', 'unknown']);
  const ports = Object.values(record.ports);
  return ports.length > 0 && (await listening(ports)).length > 0;
}

// @ref LLP 0027#a-running-service-is-reachable-from-the-devices -- through the workspace's recorded reverses
async function syncReverses(root: string, record: ServiceRecord, add: boolean): Promise<string> {
  const notes: string[] = [];
  for (const port of record.reverse) {
    try {
      await recordReversePort(root, port, add);
      for (const report of await reverseOnDevices(root, port, add ? 'add' : 'remove'))
        if (report.status === 'failed' || report.status === 'unsupported')
          notes.push(`reverse ${port} on ${report.device}: ${report.detail}`);
    } catch (error) {
      notes.push(`reverse ${port}: ${messageOf(error)}`);
    }
  }
  return notes.length ? `; ${notes.join('; ')}` : '';
}

export interface ServiceOutcome {
  name: string;
  outcome: 'started' | 'running' | 'stopped' | 'not-running' | 'torn-down' | 'failed';
  detail: string;
}

type StartSource = { definition: ServiceDefinition; definitions: ServiceDefinition[] } | { record: ServiceRecord };

type Transition =
  | { op: 'start'; source: StartSource }
  | { op: 'stop'; by: 'idle' | 'command' }
  | { op: 'teardown'; force: boolean }
  | { op: 'forget' };

function byHand(record: ServiceRecord, argv: readonly string[], cwd: string): string {
  const env = Object.entries(record.env).map(([key, value]) => `${key}=${value}`);
  return `run by hand in ${cwd}: ${[...env, ...argv].join(' ')}`;
}

/** Runs `argv` as one of the service's commands, then checks that its ports closed. */
async function runAndClose(
  root: string,
  name: string,
  kind: string,
  argv: string[],
  record: ServiceRecord,
  cwd: string,
  options: RunOptions,
): Promise<string | null> {
  const failure = await runCommand(root, name, kind, argv, record, cwd, STOP_TIMEOUT_MS, options);
  if (failure) return failure;
  const still = await listening(Object.values(record.ports));
  return still.length ? `${kind} command ${argv.join(' ')} exited, but port ${still.join(', ')} still listens` : null;
}

/** Stops the service and checks it stopped: a process by identity with its whole group, else its `stop` command. */
async function halt(root: string, name: string, record: ServiceRecord, options: RunOptions): Promise<string | null> {
  if (record.kind === 'process') return stopProcess(record, options.signal);
  return runAndClose(root, name, 'stop', record.stop ?? [], record, record.cwd, options);
}

async function forget(root: string, name: string, record: ServiceRecord): Promise<void> {
  await syncReverses(root, record, false);
  for (const label of Object.keys(record.ports)) await clearNamedPorts(root, { label, log: () => {} });
  await writeRecord(root, name, null);
}

/**
 * Moves one service through `op` under the services lock its caller holds: it runs the command, checks the result
 * (ports closed or the process group gone, or the service ready), writes the record, then syncs the device reverses.
 */
// @ref LLP 0027#one-transition-per-service-change -- every start, stop and teardown goes through here
async function transition(
  root: string,
  name: string,
  change: Transition,
  options: RunOptions,
): Promise<ServiceOutcome> {
  const record = serviceRecords(root)[name] ?? null;
  if (change.op === 'start') return startOne(root, name, change.source, record, options);
  if (!record) return { name, outcome: 'not-running', detail: 'Stim did not start it' };
  if (change.op === 'forget') {
    await forget(root, name, record);
    return { name, outcome: 'torn-down', detail: 'forgotten' };
  }
  if (change.op === 'stop') return stopOne(root, name, record, change.by, options);
  return teardownOne(root, name, record, change.force, options);
}

async function stopOne(
  root: string,
  name: string,
  record: ServiceRecord,
  by: 'idle' | 'command',
  options: RunOptions,
): Promise<ServiceOutcome> {
  const now = new Date().toISOString();
  const { idleStopFailedAt: _, process: __, ...rest } = record;
  const stopped: ServiceRecord = { ...rest, state: 'stopped', stoppedBy: by, at: now };
  if (record.state === 'stopped') {
    if (by === 'command' && record.stoppedBy !== 'command') await writeRecord(root, name, stopped);
    return { name, outcome: 'not-running', detail: 'already stopped' };
  }
  const failure = await halt(root, name, record, options);
  if (failure) {
    if (by === 'idle') await writeRecord(root, name, { ...record, idleStopFailedAt: now });
    return { name, outcome: 'failed', detail: failure };
  }
  await writeRecord(root, name, stopped);
  return { name, outcome: 'stopped', detail: 'stopped' + (await syncReverses(root, record, false)) };
}

// @ref LLP 0027#removal-tears-services-down -- teardown alone, stop only while it runs; a failure keeps the record
async function teardownOne(
  root: string,
  name: string,
  record: ServiceRecord,
  force: boolean,
  options: RunOptions,
): Promise<ServiceOutcome> {
  const present = existsSync(root);
  const [kind, argv, cwd] = present
    ? (['teardown', record.teardown, record.cwd] as const)
    : (['orphan_teardown', record.orphanTeardown, homedir()] as const);
  let failure: string | null = null;
  if (record.kind === 'process') failure = await stopProcess(record, options.signal);
  else if (argv) failure = await runAndClose(root, name, kind, argv, record, cwd, options);
  else if (present && (record.state === 'running' || (await mayStillRun(record))))
    failure = await halt(root, name, record, options);
  const shown = byHand(
    record,
    argv ?? record.teardown ?? record.stop ?? ['kill', '--', `-${record.process?.pid}`],
    cwd,
  );
  if (failure && !force) {
    const reason = `${failure}; ${shown}`;
    await writeRecord(root, name, { ...record, teardownFailure: reason });
    return { name, outcome: 'failed', detail: reason };
  }
  await forget(root, name, record);
  const note = failure
    ? `${failure}; dropped (--force); ${shown}`
    : !present && !argv && record.kind === 'commands'
      ? `not torn down: no orphanTeardown; ${shown}`
      : 'torn down';
  return { name, outcome: 'torn-down', detail: note };
}

// @ref LLP 0027#stim-runs-only-what-it-recorded -- a service left running keeps the record it was started with
function asRunning(record: ServiceRecord): ServiceRecord {
  const { stoppedBy: _, idleStopFailedAt: __, ...rest } = record;
  return { ...rest, state: 'running' };
}

async function startOne(
  root: string,
  name: string,
  source: StartSource,
  previous: ServiceRecord | null,
  options: RunOptions,
): Promise<ServiceOutcome> {
  const signal = options.signal ?? options.operation?.signal;
  options = { ...options, signal };
  const resolved =
    'record' in source
      ? source.record
      : await resolveService(root, source.definition, source.definitions, options.operation?.env.PATH);
  const { stoppedBy: _, idleStopFailedAt: __, teardownFailure: ___, process: ____, ...fresh } = resolved;
  const base: ServiceRecord = { ...fresh, state: 'running', at: new Date().toISOString() };
  // @ref LLP 0027#revive-resumes-what-the-idle-pass-stopped -- the idle mark stays until a start succeeds
  const pending: ServiceRecord = previous?.stoppedBy === 'idle' ? { ...base, stoppedBy: 'idle' } : base;
  const failed = async (detail: string, record: ServiceRecord, mayRun: boolean): Promise<ServiceOutcome> => {
    const stoppedBy = previous?.stoppedBy === 'idle' ? 'idle' : 'command';
    await writeRecord(root, name, mayRun ? record : { ...record, state: 'stopped', stoppedBy, process: undefined });
    return { name, outcome: 'failed', detail };
  };
  const started = async (record: ServiceRecord, outcome: 'started' | 'running', detail: string) => {
    await writeRecord(root, name, record);
    return { name, outcome, detail: detail + (await syncReverses(root, record, true)) };
  };
  if (base.kind === 'process') {
    const live = previous?.process;
    if (live && inspectProcessIdentity(live) === 'unknown')
      return { name, outcome: 'failed', detail: `the identity of its pid ${live.pid} cannot be verified` };
    // @ref LLP 0027#a-service-without-a-stop-command-is-a-process -- never spawn over a live recorded process
    if (live && previous && processLives(previous, ['same']))
      return (await waitReady(root, name, previous, options))
        ? started(asRunning(previous), 'running', 'already running')
        : { name, outcome: 'failed', detail: `pid ${live.pid} runs but is not ready.${logTail(root, name)}` };
  }
  const ours = base.kind === 'commands' && previous?.state === 'running';
  const held = ours ? [] : await listening(Object.values(base.ports));
  // @ref LLP 0027#a-port-only-counts-as-the-service-it-recorded -- a held port is never adopted
  if (held.length)
    return {
      name,
      outcome: 'failed',
      detail: `port ${held.join(', ')} is held by a process Stim did not start for this service; stop it, then start again`,
    };
  if (ours && previous && (await ready(root, name, previous, options)))
    return started(asRunning(previous), 'running', 'already running');
  // @ref LLP 0027#a-service-start-shares-the-build-slots -- only startup and readiness hold capacity
  return withDrainingCancellation(options.operation, signal, async () => {
    const slot = await acquireBuildSlot({
      root,
      service: name,
      context: options.operation,
      logFile: serviceLogFile(root, name),
      signal,
      out: (line) => options.operation?.output('stderr', `${line}\n`),
    });
    let record = pending;
    let failure: string | null = null;
    let isReady = false;
    let retained = false;
    try {
      signal?.throwIfAborted();
      if (base.kind === 'process') {
        let proc;
        try {
          proc = await spawnProcess(root, name, base, options.operation);
        } catch (error) {
          return {
            name,
            outcome: 'failed',
            detail: `start command ${base.start.join(' ')} failed: ${messageOf(error)}`,
          };
        }
        record = { ...pending, process: proc };
        await writeRecord(root, name, record);
        logEvent(root, 'info', 'service_start', `${name}: ${base.start.join(' ')} (pid ${proc.pid})`, {
          service: name,
        });
      } else {
        await writeRecord(root, name, pending);
        failure = await runCommand(root, name, 'start', base.start, base, base.cwd, START_TIMEOUT_MS, options);
      }
      if (!failure) isReady = await waitReady(root, name, record, options, true);
    } catch (error) {
      // @ref LLP 0007#a-null-child-is-never-recovered -- unresolved child cleanup retains its slot
      retained = error instanceof Error && 'reportCleanup' in error;
      throw error;
    } finally {
      releaseBuildSlot(slot, retained);
    }
    if (isReady)
      return started(
        { ...base, ...(record.process ? { process: record.process } : {}) },
        'started',
        record.process ? `pid ${record.process.pid}; output in ${serviceLogFile(root, name)}` : base.start.join(' '),
      );
    if (base.kind === 'process') {
      const left = await stopProcess(record, signal);
      return failed(`${base.start.join(' ')} did not become ready.${logTail(root, name)}`, record, left !== null);
    }
    // @ref LLP 0027#the-idle-pass-stops-services -- a stack that partly came up stays running, so the idle pass reaches it
    return failed(
      failure ?? `${base.start.join(' ')} exited, but the service did not become ready`,
      pending,
      await mayStillRun(base),
    );
  });
}

/** Starts the declared services, or the one named, dependencies first; one already running is left alone. */
export async function startServices(
  root: string,
  name: string | undefined,
  options: RunOptions = {},
): Promise<ServiceOutcome[]> {
  const definitions = declaredServices(root);
  const order = startOrder(definitions, selectServices(definitions, name));
  return withServicesLock(
    root,
    async () => {
      // @ref LLP 0027#removal-tears-services-down -- registered under the lock removal checks again before it deletes
      if (!getProject(root)) upsertProject(root, {});
      const outcomes: ServiceOutcome[] = [];
      for (const definition of order) {
        const outcome = await transition(
          root,
          definition.name,
          { op: 'start', source: { definition, definitions } },
          options,
        );
        outcomes.push(outcome);
        if (outcome.outcome === 'failed') break;
      }
      return outcomes;
    },
    options.signal,
  );
}

/** The recorded services, dependencies first. */
function recordedInOrder(records: Record<string, ServiceRecord>): [string, ServiceRecord][] {
  const order: [string, ServiceRecord][] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    const record = records[name];
    if (!record || seen.has(name)) return;
    seen.add(name);
    for (const dependency of record.dependsOn) visit(dependency);
    order.push([name, record]);
  };
  for (const name of Object.keys(records)) visit(name);
  return order;
}

/** Stops the services Stim started, or the one named; `idle` marks them for `stim revive`. */
export async function stopServices(
  root: string,
  name: string | undefined,
  by: 'idle' | 'command',
  options: RunOptions & { names?: readonly string[] } = {},
): Promise<ServiceOutcome[]> {
  return withServicesLock(
    root,
    async () => {
      const records = serviceRecords(root);
      if (name !== undefined && !records[name]) selectServices(declaredServices(root), name);
      const outcomes: ServiceOutcome[] = [];
      for (const [each] of recordedInOrder(records).toReversed()) {
        if (name !== undefined && each !== name) continue;
        if (options.names && !options.names.includes(each)) continue;
        outcomes.push(await transition(root, each, { op: 'stop', by }, options));
      }
      return outcomes;
    },
    options.signal,
    options.waitMs,
  );
}

/**
 * The processes of the services recorded in a workspace, which the idle evidence leaves out, since a service working in
 * its checkout is not someone using the workspace: each supervised process with everything in its process group, and
 * each listener on a commands service's ports that `lsof` shows (a host daemon such as a database server).
 */
export async function serviceProcessPids(root: string, operation?: StimContext): Promise<Set<number>> {
  const records = Object.values(serviceRecords(root));
  const leaders = new Set(
    records.flatMap((record) =>
      record.process && inspectProcessIdentity(record.process) === 'same' ? [record.process.pid] : [],
    ),
  );
  const ports = records.flatMap((record) => (record.kind === 'commands' ? Object.values(record.ports) : []));
  const exec = getExecutor();
  const quiet = (file: string, args: string[]) =>
    runOperationFile(operation, exec, file, args, { timeoutMs: READY_COMMAND_TIMEOUT_MS }).catch(() => '');
  const pids = new Set(leaders);
  if (ports.length && exec.findExecutable('lsof'))
    for (const pid of (await quiet('lsof', ['-nP', ...ports.map((port) => `-iTCP:${port}`), '-sTCP:LISTEN', '-t']))
      .split(/\s+/)
      .map(Number))
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  if (!leaders.size) return pids;
  for (const row of (await quiet('ps', ['-axo', 'pid=,pgid='])).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
    if (match && leaders.has(Number(match[2]))) pids.add(Number(match[1]));
  }
  return pids;
}

/** Records as stopped the services recorded running that no longer run: exited or stopped outside Stim. */
export async function forgetExitedServices(
  root: string,
  names: readonly string[],
  signal?: AbortSignal,
  waitMs?: number,
): Promise<void> {
  await withServicesLock(
    root,
    async () => {
      for (const [name, record] of Object.entries(serviceRecords(root)))
        if (names.includes(name) && record.state === 'running' && !(await serviceRunning(record)))
          await writeRecord(root, name, {
            ...record,
            state: 'stopped',
            stoppedBy: undefined,
            at: new Date().toISOString(),
          });
    },
    signal,
    waitMs,
  );
}

/** Starts again, from their records, the services the idle pass stopped, dependencies first. */
export async function resumeServices(root: string, options: RunOptions = {}): Promise<ServiceOutcome[]> {
  return withServicesLock(
    root,
    async () => {
      const outcomes: ServiceOutcome[] = [];
      for (const [name, record] of recordedInOrder(serviceRecords(root))) {
        if (record.stoppedBy !== 'idle') continue;
        const outcome = await transition(root, name, { op: 'start', source: { record } }, options);
        outcomes.push(outcome);
        if (outcome.outcome === 'failed') break;
      }
      return outcomes;
    },
    options.signal,
  );
}

/**
 * Deletes the services' data just before a linked worktree goes: `teardown`, or `stop` while one still runs, from each
 * service's folder. A record and its ports go only when its command exited 0, or when it declares none; a failure keeps
 * them, records what to run by hand, and throws so the removal refuses with nothing else touched. `force` drops them.
 */
export async function teardownServices(
  root: string,
  { force = false, ...options }: RunOptions & { force?: boolean } = {},
): Promise<ServiceOutcome[]> {
  if (!Object.keys(serviceRecords(root)).length) return [];
  return withServicesLock(
    root,
    async () => {
      const outcomes: ServiceOutcome[] = [];
      for (const [name] of recordedInOrder(serviceRecords(root)).toReversed())
        outcomes.push(await transition(root, name, { op: 'teardown', force }, options));
      const failures = outcomes.filter((outcome) => outcome.outcome === 'failed');
      if (failures.length)
        throw new ServiceError(
          failures.map((outcome) => `service ${outcome.name}: ${outcome.detail}`).join('\n'),
          'STIM_SERVICE_FAILED',
          'Fix the cause and remove again, or run the command by hand and then stim worktree remove --force.',
        );
      return outcomes;
    },
    options.signal,
  );
}

/**
 * Settles the services of a workspace that a reclaim does not delete through `git worktree remove`: in a folder that
 * stays, each is stopped (its data kept), then forgotten with its ports; a stop that fails throws before anything else
 * changes. In a folder that is gone, each gets one `orphanTeardown`, and a failure is logged with the command to run.
 */
// @ref LLP 0027#removal-tears-services-down -- reclaim never deletes the data of a folder that stays
export async function settleServicesForReclaim(
  root: string,
  output: { signal?: AbortSignal; log?: (line: string) => void } | undefined,
  operation?: StimContext,
): Promise<void> {
  if (!Object.keys(serviceRecords(root)).length) return;
  const options: RunOptions = operation ? { operation, signal: operation.signal } : {};
  const log = output?.log ?? (() => {});
  await withServicesLock(
    root,
    async () => {
      const present = existsSync(root);
      const failures: string[] = [];
      for (const [name, record] of recordedInOrder(serviceRecords(root)).toReversed()) {
        const outcome = await transition(
          root,
          name,
          present ? { op: 'stop', by: 'command' } : { op: 'teardown', force: true },
          options,
        );
        if (outcome.outcome === 'failed') {
          failures.push(`service ${name}: ${outcome.detail}; ${byHand(record, record.stop ?? [], record.cwd)}`);
          continue;
        }
        if (outcome.detail !== 'torn down' && !present) log(`service ${name}: ${outcome.detail}`);
        if (present) await transition(root, name, { op: 'forget' }, options);
      }
      if (failures.length)
        throw new ServiceError(
          failures.join('\n'),
          'STIM_SERVICE_FAILED',
          'Stop each named service, then run the cleanup again.',
        );
    },
    options.signal,
  );
}
