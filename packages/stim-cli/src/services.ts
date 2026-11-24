import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
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
import { runOperationFile } from './engine/operation-exec.ts';
import { withWorkspaceProcessLock } from './engine/workspace-process-lock.ts';
import { getExecutor, isTimeoutError } from './exec.ts';
import { signalProcessTree } from './metro.ts';
import { getNamedPort } from './named-ports.ts';
import { createNdjsonWriter } from './ndjson.ts';
import { createPortProbe } from './ports.ts';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from './process-identity.ts';
import { workspaceDir, workspaceLogsDir } from './workspace/paths.ts';
import { resolveProjectSettings, settingValueAt } from './workspace/settings.ts';
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
  /** Named port labels, each to the environment variable that receives its number, or null. */
  ports: Record<string, string | null>;
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

/** The names `{...}` placeholders in `text` refer to. */
function placeholders(text: string): string[] {
  return [...text.replace(/\{\{|\}\}/g, '').matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '');
}

/** Validates one declared service's shape; `declaredServicesFrom` checks its placeholders against the others. */
function parseService(name: string, value: unknown): ServiceDefinition {
  if (!NAME.test(name))
    throw bad(name, 'needs a name of lowercase letters, digits and hyphens, starting with a letter.');
  if (!isJsonObject(value)) throw bad(name, 'must be an object with at least a start command.');
  const known = ['cwd', 'ports', 'idEnv', 'env', 'start', 'stop', 'teardown', 'orphanTeardown', 'ready', 'dependsOn'];
  const unknown = Object.keys(value).find((key) => !known.includes(key));
  if (unknown) throw bad(name, `has an unknown key ${unknown}; use ${known.join(', ')}.`);
  const cwd = value.cwd ?? '.';
  if (typeof cwd !== 'string' || isAbsolute(cwd))
    throw bad(name, '.cwd must be a path relative to the workspace, inside its checkout.');
  const ports: Record<string, string | null> = {};
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
    if (envName !== null && (typeof envName !== 'string' || !ENV_NAME.test(envName)))
      throw bad(name, `.ports.${label} must be an environment variable name or null.`);
    ports[label] = envName;
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
  const definition: ServiceDefinition = { name, cwd, ports, idEnv, env, start, dependsOn: [...dependsOn] };
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

function workspaceCwd(root: string, cwd: string): string {
  const real = realpathSync(root);
  const checkout = realpathSync(repoRoot(real) ?? real);
  const dir = resolve(real, cwd);
  const resolved = existsSync(dir) ? realpathSync(dir) : dir;
  const inside = relative(checkout, resolved);
  if (inside.startsWith('..') || isAbsolute(inside))
    throw new ServiceError(
      `The service cwd ${cwd} leaves the checkout ${checkout}.`,
      'STIM_BAD_ARG',
      'Point cwd at a folder inside this checkout (stim guide services).',
    );
  return resolved;
}

/** Allocates the service's ports and resolves every command and value it runs with. */
async function resolveService(
  root: string,
  definition: ServiceDefinition,
  definitions: ServiceDefinition[],
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
    env,
    ports,
    start: definition.start.map((arg) => substitute(arg, values, 'start')),
  };
  for (const key of ['stop', 'teardown', 'orphanTeardown', 'ready'] as const) {
    const argv = definition[key];
    if (argv) record[key] = argv.map((arg) => substitute(arg, values, key));
  }
  return record;
}

/** The environment of every declared service whose ports are allocated or can be: for `stim services env` and `stim test`. */
export async function servicesEnv(root: string, name?: string): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  const definitions = declaredServices(root);
  for (const definition of selectServices(definitions, name))
    out[definition.name] = (await resolveService(root, definition, definitions)).env;
  return out;
}

function withServicesLock<T>(root: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withWorkspaceProcessLock(workspaceDir(root), 'services', fn, { external: true, signal });
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
}

/** Runs one of a service's commands; null when it exited 0, else why it failed. Its output goes to the workspace log. */
async function runCommand(
  root: string,
  name: string,
  kind: string,
  argv: string[],
  record: Pick<ServiceRecord, 'cwd' | 'env'>,
  cwd: string,
  timeoutMs: number,
  { signal, operation }: RunOptions,
): Promise<string | null> {
  const exec = getExecutor();
  const [program = '', ...args] = argv;
  const command = argv.join(' ');
  let output = '';
  let failure: string | null = null;
  const file = exec.findExecutable(program, {
    cwd,
    ...(operation ? { env: { ...operation.env, ...record.env } } : {}),
  });
  if (!file) failure = `${program} is not on PATH`;
  else {
    try {
      output = await runOperationFile(operation, exec, file, args, {
        cwd,
        env: record.env,
        timeoutMs,
        killSignal: 'SIGKILL',
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && 'reportCleanup' in error) throw error;
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

/**
 * Whether the service runs, without starting anything: a supervised process by its captured identity, a commands
 * service by a listener on one of its ports, else by its record.
 */
export async function serviceRunning(
  record: ServiceRecord,
  isFree?: (port: number) => Promise<boolean>,
): Promise<boolean> {
  if (record.kind === 'process') return !!record.process && inspectProcessIdentity(record.process) === 'same';
  const ports = Object.values(record.ports);
  if (!ports.length) return record.state === 'running';
  return (await listening(ports, isFree)).length > 0;
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
    });
  target.services = out;
}

async function ready(root: string, name: string, record: ServiceRecord, options: RunOptions): Promise<boolean> {
  if (record.ready)
    return (
      (await runCommand(root, name, 'ready', record.ready, record, record.cwd, READY_COMMAND_TIMEOUT_MS, options)) ===
      null
    );
  const ports = Object.values(record.ports);
  if (ports.length) return (await listening(ports)).length === ports.length;
  return serviceRunning(record);
}

async function waitReady(root: string, name: string, record: ServiceRecord, options: RunOptions): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await ready(root, name, record, options)) return true;
    if (record.kind === 'process' && !(await serviceRunning(record))) return false;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, READY_POLL_MS));
    options.signal?.throwIfAborted();
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
  const env = { ...operation.env, ...record.env };
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
    if (!identity.ok) throw new Error(`cannot identify pid ${child.pid}: ${identity.reason}`);
    return { pid: child.pid, processToken: identity.token };
  } finally {
    closeSync(fd);
  }
}

// @ref LLP 0027#a-service-without-a-stop-command-is-a-process -- signalled by captured identity, never a bare pid
async function stopProcess(record: ServiceRecord, signal?: AbortSignal): Promise<string | null> {
  const proc = record.process;
  if (!proc || inspectProcessIdentity(proc) !== 'same') return null;
  try {
    signalProcessTree(proc.pid, 'SIGTERM', { group: true });
    if (!(await waitForProcessExit(proc, PROCESS_STOP_GRACE_MS, signal))) {
      if (inspectProcessIdentity(proc) !== 'same') return null;
      signalProcessTree(proc.pid, 'SIGKILL', { group: true });
      if (!(await waitForProcessExit(proc, PROCESS_STOP_GRACE_MS, signal))) return `pid ${proc.pid} did not exit`;
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) return messageOf(error);
  }
  return null;
}

export interface ServiceOutcome {
  name: string;
  outcome: 'started' | 'running' | 'stopped' | 'not-running' | 'torn-down' | 'reported' | 'failed';
  detail: string;
}

async function startOne(
  root: string,
  source: { definition: ServiceDefinition; definitions: ServiceDefinition[] } | { record: ServiceRecord },
  name: string,
  previous: ServiceRecord | null,
  options: RunOptions,
): Promise<ServiceOutcome> {
  const resolved =
    'record' in source ? source.record : await resolveService(root, source.definition, source.definitions);
  const base: ServiceRecord = { ...resolved, state: 'running', at: new Date().toISOString() };
  if (previous && (await serviceRunning(previous)) && (await ready(root, name, previous, options)))
    return { name, outcome: 'running', detail: 'already running' };
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
    const record = { ...base, process: proc };
    await writeRecord(root, name, record);
    logEvent(root, 'info', 'service_start', `${name}: ${base.start.join(' ')} (pid ${proc.pid})`, { service: name });
    if (await waitReady(root, name, record, options))
      return { name, outcome: 'started', detail: `pid ${proc.pid}; output in ${serviceLogFile(root, name)}` };
    await stopProcess(record, options.signal);
    await writeRecord(root, name, { ...record, state: 'stopped', stoppedBy: 'command' });
    return { name, outcome: 'failed', detail: `${base.start.join(' ')} did not become ready.${logTail(root, name)}` };
  }
  await writeRecord(root, name, base);
  const failure = await runCommand(root, name, 'start', base.start, base, base.cwd, START_TIMEOUT_MS, options);
  if (failure) return { name, outcome: 'failed', detail: failure };
  if (!(await waitReady(root, name, base, options)))
    return { name, outcome: 'failed', detail: `${base.start.join(' ')} exited, but the service did not become ready` };
  return { name, outcome: 'started', detail: base.start.join(' ') };
}

/** Starts the declared services, or the one named, in declaration order; one already running is left alone. */
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
      const outcomes: ServiceOutcome[] = [];
      for (const definition of order) {
        const outcome = await startOne(
          root,
          { definition, definitions },
          definition.name,
          serviceRecords(root)[definition.name] ?? null,
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

async function stopOne(
  root: string,
  name: string,
  record: ServiceRecord,
  by: 'idle' | 'command',
  options: RunOptions,
): Promise<ServiceOutcome> {
  const running = await serviceRunning(record);
  if (!running && by === 'idle') return { name, outcome: 'not-running', detail: 'not running' };
  let failure: string | null;
  if (record.kind === 'process') failure = await stopProcess(record, options.signal);
  else {
    const stop = record.stop ?? [];
    failure = await runCommand(root, name, 'stop', stop, record, record.cwd, STOP_TIMEOUT_MS, options);
    const still = failure ? [] : await listening(Object.values(record.ports));
    if (still.length) failure = `stop command ${stop.join(' ')} exited, but port ${still.join(', ')} still listens`;
  }
  const now = new Date().toISOString();
  if (failure) {
    await writeRecord(root, name, { ...record, ...(by === 'idle' ? { idleStopFailedAt: now } : {}) });
    return { name, outcome: 'failed', detail: failure };
  }
  const { idleStopFailedAt: _, process: __, ...rest } = record;
  await writeRecord(root, name, { ...rest, state: 'stopped', stoppedBy: by, at: now });
  return { name, outcome: running ? 'stopped' : 'not-running', detail: running ? 'stopped' : 'not running' };
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
      for (const [each, record] of Object.entries(records).toReversed()) {
        if (name !== undefined && each !== name) continue;
        if (options.names && !options.names.includes(each)) continue;
        if (record.state !== 'running' && by === 'idle') continue;
        outcomes.push(await stopOne(root, each, record, by, options));
      }
      return outcomes;
    },
    options.signal,
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
): Promise<void> {
  await withServicesLock(
    root,
    async () => {
      for (const [name, record] of Object.entries(serviceRecords(root)))
        if (names.includes(name) && record.state === 'running' && !(await serviceRunning(record)))
          await writeRecord(root, name, { ...record, state: 'stopped', at: new Date().toISOString() });
    },
    signal,
  );
}

/** Starts again, from their records, the services the idle pass stopped. */
export async function resumeServices(root: string, options: RunOptions = {}): Promise<ServiceOutcome[]> {
  return withServicesLock(
    root,
    async () => {
      const outcomes: ServiceOutcome[] = [];
      for (const [name, record] of Object.entries(serviceRecords(root))) {
        if (record.state !== 'stopped' || record.stoppedBy !== 'idle') continue;
        const outcome = await startOne(root, { record }, name, record, options);
        outcomes.push(outcome);
        if (outcome.outcome === 'failed') break;
      }
      return outcomes;
    },
    options.signal,
  );
}

/**
 * Tears down every service Stim started in the workspace, before its removal: a process is stopped by identity; a
 * commands service runs its teardown, else its stop command while it runs, from its folder, or once that folder is
 * gone, its orphan teardown from the home folder. A service still running after a failure throws, which keeps the
 * workspace; a failure that left nothing running is reported.
 */
// @ref LLP 0027#removal-tears-services-down -- what removal runs, and what blocks it
export async function teardownServices(
  root: string,
  { log = () => {}, ...options }: RunOptions & { log?: (line: string) => void } = {},
): Promise<ServiceOutcome[]> {
  const records = serviceRecords(root);
  if (!Object.keys(records).length) return [];
  const present = existsSync(root);
  const run = async () => {
    const outcomes: ServiceOutcome[] = [];
    const blocking: string[] = [];
    for (const [name, record] of Object.entries(records).toReversed()) {
      let failure: string | null = null;
      let reported: string | null = null;
      if (record.kind === 'process') failure = await stopProcess(record, options.signal);
      else if (present) {
        const running = await serviceRunning(record);
        const argv = record.teardown ?? (running ? record.stop : undefined);
        if (argv)
          failure = await runCommand(
            root,
            name,
            record.teardown ? 'teardown' : 'stop',
            argv,
            record,
            record.cwd,
            STOP_TIMEOUT_MS,
            options,
          );
      } else if (record.orphanTeardown) {
        failure = await runCommand(
          root,
          name,
          'orphan_teardown',
          record.orphanTeardown,
          record,
          homedir(),
          STOP_TIMEOUT_MS,
          options,
        );
        if (failure) reported = `${failure}; ${root} is gone, so run it yourself if the service remains`;
      } else
        reported = `not torn down: ${root} is gone and it declares no orphanTeardown; run ${(record.teardown ?? record.stop ?? []).join(' ')} yourself with ${Object.entries(
          record.env,
        )
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')}`;
      if (failure && !reported && (await serviceRunning(record))) {
        blocking.push(
          `${name}: ${failure}. Stop it yourself (${record.cwd}: ${(record.stop ?? ['kill', String(record.process?.pid)]).join(' ')}), then remove the workspace again.`,
        );
        outcomes.push({ name, outcome: 'failed', detail: failure });
        continue;
      }
      if (failure && !reported) reported = `${failure}; nothing of it runs, so removal goes on`;
      if (reported) log(`service ${name}: ${reported}`);
      await writeRecord(root, name, null);
      outcomes.push({ name, outcome: reported ? 'reported' : 'torn-down', detail: reported ?? 'torn down' });
    }
    if (blocking.length)
      throw new ServiceError(
        blocking.join('\n'),
        'STIM_SERVICE_FAILED',
        'Stop each named service yourself, then run the removal again.',
      );
    return outcomes;
  };
  return withServicesLock(root, run, options.signal);
}
