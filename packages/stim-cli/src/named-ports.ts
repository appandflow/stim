import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import {
  ensureConfig,
  getConfigDir,
  getProject,
  loadConfig,
  saveConfig,
  withConfigLockAsync,
} from './workspace/config.ts';
import type { PortCommands } from '@stim-cli/core/state';
import { getExecutor, isTimeoutError, windowsSystemExecutable } from './exec.ts';
import { withWorkspaceProcessLock } from './engine/workspace-process-lock.ts';
import { parseNetstatPids, signalProcessTree } from './metro.ts';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from './process-identity.ts';
import { createPortProbe } from './ports.ts';
import { runOperationFile } from './engine/operation-exec.ts';
import { createNdjsonWriter } from './ndjson.ts';
import { workspaceLogsDir } from './workspace/paths.ts';

const FIRST_PORT = 8900;
const LAST_PORT = 8999;

const BROWSER_LABEL = 'web-cdp';
const STOP_TIMEOUT_MS = 120_000;
const RESUME_TIMEOUT_MS = 300_000;
const STOP_OUTPUT_MAX = 4000;
const SHELL_SYNTAX = /["'`\\$|;&<>(){}*?~#!]/;

export type CommandKind = 'stop' | 'teardown' | 'resume';

/** The argv of a `--stop`, `--teardown` or `--resume` value, split on whitespace; it runs without a shell, so shell syntax refuses. */
export function parseStopCommand(text: string, kind: CommandKind): string[] {
  const argv = text.trim().split(/\s+/).filter(Boolean);
  if (!argv.length) throw new Error(`--${kind} needs a command, for example --${kind} "my-server ${kind}".`);
  if (SHELL_SYNTAX.test(text))
    throw new Error(
      `--${kind} runs its command without a shell, split on spaces, so it refuses quotes and shell syntax: ${text}. Declare the command as an argv array in the ports.commands setting instead (stim guide ports).`,
    );
  return argv;
}

function validatePortLabel(label: string): void {
  if (label === 'metro') throw new Error('metro is managed by stim start and stim stop; choose another label.');
  if (label === BROWSER_LABEL)
    throw new Error(`${BROWSER_LABEL} is managed by stim web and stim stop; choose another label.`);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(label)) {
    throw new Error(
      'A port label must start with a letter and contain at most 64 letters, digits, underscores or hyphens.',
    );
  }
}

function portListeners(port: number, platform: NodeJS.Platform): number[] {
  if (platform === 'win32') {
    const out = getExecutor().runFile(windowsSystemExecutable('netstat.exe'), ['-ano'], {
      timeoutMs: 5000,
      rejectStderr: true,
    });
    if (!/^\s*(?:Proto|TCP)\s/m.test(out)) throw new Error('netstat printed no TCP connection table.');
    return parseNetstatPids(out, port);
  }
  let out: string;
  try {
    out = getExecutor().runFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeoutMs: 5000 });
  } catch (error) {
    const result = error as { status?: number; stdout?: unknown; stderr?: unknown };
    if (result.status === 1 && !String(result.stdout ?? '').trim() && !String(result.stderr ?? '').trim()) return [];
    throw new Error(`Could not inspect TCP port ${port} with lsof: ${(error as Error).message}`, { cause: error });
  }
  const pids = out.trim() ? out.trim().split(/\s+/).map(Number) : [];
  if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error(`lsof returned an invalid listener for TCP port ${port}.`);
  }
  return [...new Set(pids)];
}

function processCommand(pid: number, platform: NodeJS.Platform): string {
  const e = getExecutor();
  if (platform === 'win32') {
    const csv = e.runFileQuiet(windowsSystemExecutable('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      timeoutMs: 5000,
    });
    return /^"([^"]*)"/.exec((csv ?? '').trim())?.[1] ?? '';
  }
  return (e.runFileQuiet('ps', ['-p', String(pid), '-o', 'args='], { timeoutMs: 5000 }) ?? '').trim();
}

function withPortsLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withWorkspaceProcessLock(getConfigDir(), 'ports', fn, { external: true, signal });
}

interface AllocateOptions {
  isFree?: (port: number) => Promise<boolean>;
  /** The commands that stop this label's server, recorded with the allocation; an absent one keeps the recorded one. */
  commands?: PortCommands;
}

export async function getNamedPort(projectPath: string, label: string, options: AllocateOptions = {}): Promise<number> {
  validatePortLabel(label);
  return allocateNamedPort(projectPath, label, options);
}

function argvOf(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((arg) => typeof arg === 'string') && value[0] ? value : undefined;
}

/** The stop, teardown and resume commands recorded for `label`. */
export function recordedCommands(projectPath: string, label: string): PortCommands {
  const all = getProject(projectPath)?.portCommands;
  const record: unknown = all && Object.hasOwn(all, label) ? all[label] : undefined;
  if (!record || typeof record !== 'object') return {};
  const commands: PortCommands = {};
  for (const kind of ['stop', 'teardown', 'resume'] as const) {
    const argv = argvOf((record as Record<string, unknown>)[kind]);
    if (argv) commands[kind] = argv;
  }
  return commands;
}

/** The loopback DevTools port of the workspace's owned Chrome, allocated like a named port under `web-cdp`. */
export function reserveBrowserPort(projectPath: string, options: AllocateOptions = {}): Promise<number> {
  return allocateNamedPort(projectPath, BROWSER_LABEL, options);
}

export function releaseBrowserPort(projectPath: string, port: number, signal?: AbortSignal): Promise<void> {
  return withPortsLock(
    () =>
      withConfigLockAsync(() => {
        const cfg = loadConfig();
        const ports = cfg?.projects?.[projectPath]?.ports;
        if (!cfg || ports?.[BROWSER_LABEL] !== port) return;
        delete ports[BROWSER_LABEL];
        saveConfig(cfg);
      }, signal),
    signal,
  );
}

async function allocateNamedPort(
  projectPath: string,
  label: string,
  { isFree = createPortProbe(), commands = {} }: AllocateOptions,
): Promise<number> {
  const root = realpathSync(projectPath);
  return withPortsLock(async () => {
    const existing = getProject(root)?.ports;
    if (existing && Object.hasOwn(existing, label)) {
      const port = existing[label]!;
      const current = recordedCommands(root, label);
      const next = { ...current, ...commands };
      if (JSON.stringify(next) !== JSON.stringify(current))
        await withConfigLockAsync(() => {
          const cfg = loadConfig();
          const project = cfg?.projects?.[root];
          if (!cfg || project?.ports?.[label] !== port) return;
          project.portCommands = { ...project.portCommands, [label]: next };
          saveConfig(cfg);
        });
      return port;
    }
    for (let port = FIRST_PORT; port <= LAST_PORT; port++) {
      const projects = Object.values(loadConfig()?.projects ?? {});
      if (projects.some((project) => project.metroPort === port || Object.values(project.ports ?? {}).includes(port)))
        continue;
      if (!(await isFree(port))) continue;
      const claimed = await withConfigLockAsync(() => {
        const cfg = ensureConfig();
        if (
          Object.values(cfg.projects).some(
            (project) => project.metroPort === port || Object.values(project.ports ?? {}).includes(port),
          )
        )
          return false;
        const project = (cfg.projects[root] ??= { metroPort: null, platforms: {} });
        project.ports = { ...project.ports, [label]: port };
        const stops = { ...project.portCommands };
        if (Object.keys(commands).length) stops[label] = commands;
        else delete stops[label];
        if (Object.keys(stops).length) project.portCommands = stops;
        else delete project.portCommands;
        saveConfig(cfg);
        return true;
      });
      if (claimed) return port;
    }
    throw new Error(
      `No free named port between ${FIRST_PORT} and ${LAST_PORT}. Use stim ports stop or stim ports release in a workspace that no longer needs its ports.`,
    );
  });
}

async function stopListeners(
  port: number,
  label: string,
  dryRun: boolean,
  log: (line: string) => void,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<void> {
  const listeners = () => portListeners(port, platform);
  for (const pid of listeners()) {
    signal?.throwIfAborted();
    if (pid === process.pid) throw new Error(`Refusing to stop Stim itself on ${label} (${port}).`);
    const identity = captureProcessIdentity(pid);
    if (!identity.ok) {
      if (!listeners().includes(pid)) continue;
      throw new Error(`Cannot identify pid ${pid} on ${label} (${port}): ${identity.reason}`);
    }
    const record = { pid, processToken: identity.token };
    const command = processCommand(pid, platform);
    if (dryRun) {
      log(`would stop ${label} (${port}): pid ${pid} ${command}`);
      continue;
    }
    if (!listeners().includes(pid)) continue;
    const status = inspectProcessIdentity(record);
    if (status === 'gone' || status === 'different') continue;
    if (status !== 'same') throw new Error(`Cannot verify pid ${pid} on ${label} (${port}); allocation kept.`);
    try {
      signalProcessTree(pid, 'SIGTERM', { platform });
      if (!(await waitForProcessExit(record, 2000, signal))) {
        if (inspectProcessIdentity(record) !== 'same') throw new Error(`Cannot verify pid ${pid} before SIGKILL.`);
        signalProcessTree(pid, 'SIGKILL', { platform });
        if (!(await waitForProcessExit(record, 2000, signal))) throw new Error(`Pid ${pid} did not exit.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    log(`stopped ${label} (${port}): pid ${pid} ${command}`);
  }
  if (!dryRun && listeners().length) throw new Error(`Port ${port} still has a listener; allocation kept.`);
}

interface StopGroup {
  argv: string[];
  labels: [string, number][];
  /** Runs only while one of its ports has a listener, or for resume, while one of them has none. */
  gated: boolean;
}

interface StopRun {
  /** The labels whose server has a recorded command of this kind, run or not. */
  handled: Set<string>;
  /** Why each label whose server could not be stopped keeps its allocation. */
  failures: Map<string, string>;
  /** Each command that ran and did its job, with the labels it covered. */
  done: string[];
  /** The labels of those commands. */
  doneLabels: string[];
}

// @ref LLP 0027#stop-keeps-data-teardown-runs-at-removal -- teardown falls back to stop, only while a port listens
function stopGroups(projectPath: string, selected: readonly [string, number][], kind: CommandKind): StopGroup[] {
  const groups = new Map<string, StopGroup>();
  for (const [name, port] of selected) {
    const { stop, teardown, resume } = recordedCommands(projectPath, name);
    const argv = kind === 'teardown' ? (teardown ?? stop) : kind === 'resume' ? resume : stop;
    if (!argv) continue;
    const gated = kind !== 'teardown' || !teardown;
    const key = JSON.stringify(argv);
    const group = groups.get(key) ?? { argv, labels: [], gated };
    group.labels.push([name, port]);
    group.gated &&= gated;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The ports among `ports` that have a listener, or whose listener table cannot be read, by the TCP table probe. */
export async function portsWithListener(ports: readonly number[]): Promise<number[]> {
  const isFree = createPortProbe();
  const taken: number[] = [];
  for (const port of ports) {
    const free = await isFree(port).catch(() => false);
    if (!free) taken.push(port);
  }
  return taken;
}

function labelsText(labels: readonly [string, number][]): string {
  return labels.map(([name, port]) => `${name} (${port})`).join(', ');
}

async function runStopCommand(
  root: string,
  cwd: string,
  kind: CommandKind,
  { argv, labels }: StopGroup,
  { log, signal, operation }: { log: (line: string) => void; signal?: AbortSignal; operation?: StimContext },
): Promise<string | null> {
  const timeoutMs = kind === 'resume' ? RESUME_TIMEOUT_MS : STOP_TIMEOUT_MS;
  const command = argv.join(' ');
  const exec = getExecutor();
  const [program = '', ...args] = argv;
  let output = '';
  let failure: string | null = null;
  const file = exec.findExecutable(program, { cwd, ...(operation ? { env: operation.env } : {}) });
  if (!file) failure = `could not run: ${program} is not on PATH`;
  else {
    try {
      output = await runOperationFile(operation, exec, file, args, {
        cwd,
        timeoutMs,
        killSignal: 'SIGKILL',
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && 'reportCleanup' in error) throw error;
      const result = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
      output = [result.stdout, result.stderr].filter((text) => typeof text === 'string' && text.trim()).join('\n');
      const last = output.trim().split('\n').at(-1)?.trim();
      failure = isTimeoutError(error)
        ? `did not exit within ${timeoutMs / 1000} seconds`
        : typeof result.status === 'number'
          ? `exited with status ${result.status}${last ? `: ${last}` : ''}`
          : `failed: ${(error as Error).message.split('\n')[0]}`;
    }
  }
  if (!failure) {
    const ports = labels.map(([, port]) => port);
    const taken = await portsWithListener(ports);
    const free = ports.filter((port) => !taken.includes(port));
    if (kind !== 'resume' && taken.length) failure = `exited, but port ${taken.join(', ')} still has a listener`;
    if (kind === 'resume' && free.length) failure = `exited, but nothing listens on port ${free.join(', ')}`;
  }
  const verb = kind === 'resume' ? 'resumed' : kind === 'teardown' ? 'tore down' : 'stopped';
  const names = labelsText(labels);
  const tail = output.trim().slice(-STOP_OUTPUT_MAX);
  const writer = createNdjsonWriter(join(workspaceLogsDir(root), 'metro.ndjson'));
  writer.write({
    src: 'metro',
    level: failure ? 'warn' : 'info',
    event: `port_${kind}${failure ? '_failed' : ''}`,
    msg: failure ? `${command} for ${names} ${failure}` : `${command} ${verb} ${names}`,
    command: argv,
    labels: labels.map(([name]) => name),
    ...(tail ? { output: tail } : {}),
  });
  writer.close();
  log(
    failure
      ? `could not ${kind === 'teardown' ? 'tear down' : kind} ${names}: ${command} ${failure}`
      : `${verb} ${names}: ${command}`,
  );
  return failure;
}

/**
 * Runs the recorded `kind` command of each selected label, once per distinct command, from the workspace root, or from
 * the home folder once that root is gone. `always` also runs a command whose ports have no listener.
 */
async function runStops(
  projectPath: string,
  selected: readonly [string, number][],
  {
    kind,
    always,
    dryRun,
    log,
    signal,
    operation,
  }: {
    kind: CommandKind;
    always: boolean;
    dryRun: boolean;
    log: (line: string) => void;
    signal?: AbortSignal;
    operation?: StimContext;
  },
): Promise<StopRun> {
  const run: StopRun = { handled: new Set(), failures: new Map(), done: [], doneLabels: [] };
  const metroPorts = new Set(Object.values(loadConfig()?.projects ?? {}).map((project) => project.metroPort));
  for (const group of stopGroups(projectPath, selected, kind)) {
    signal?.throwIfAborted();
    const command = group.argv.join(' ');
    const names = labelsText(group.labels);
    for (const [name] of group.labels) run.handled.add(name);
    const fail = (reason: string) => {
      for (const [name, port] of group.labels) run.failures.set(name, `${name} (${port}): ${reason}`);
    };
    const metro = group.labels.find(([, port]) => metroPorts.has(port));
    if (metro) {
      fail(`Port ${metro[1]} is reserved for managed Metro; allocation kept.`);
      continue;
    }
    if (dryRun) {
      log(`would run ${command} for ${names}`);
      continue;
    }
    const ports = group.labels.map(([, port]) => port);
    if (group.gated && !always) {
      const taken = await portsWithListener(ports);
      if (kind === 'resume' ? taken.length === ports.length : !taken.length) continue;
    }
    const present = existsSync(projectPath);
    const failure = await runStopCommand(projectPath, present ? projectPath : homedir(), kind, group, {
      log,
      signal,
      operation,
    });
    // @ref LLP 0027#a-workspace-folder-that-is-gone -- one try from the home folder, then the allocation goes
    if (failure && !present)
      log(`released ${names} anyway: ${projectPath} no longer exists; run ${command} yourself if its server remains`);
    else if (failure)
      fail(
        kind === 'resume'
          ? `${command} ${failure}. Fix the cause and start the server yourself, or run stim revive again.`
          : `${command} ${failure}; allocation kept. Fix the cause and run stim ports stop again, or stim ports release to drop it without stopping.`,
      );
    else {
      run.done.push(`${names}: ${command}`);
      run.doneLabels.push(...group.labels.map(([name]) => name));
    }
  }
  return run;
}

/**
 * Runs the recorded `stop` commands of the workspace's named ports that have a listener, or the `resume` commands of
 * those among `labels` that have none, and keeps the allocations: what ran, the labels it covered, and why each label
 * that failed did.
 */
export async function runPortCommands(
  projectPath: string,
  kind: 'stop' | 'resume',
  options: {
    labels?: readonly string[];
    log?: (line: string) => void;
    signal?: AbortSignal;
    operation?: StimContext;
  } = {},
): Promise<{ done: string[]; labels: string[]; failures: string[] }> {
  const { labels, ...rest } = options;
  const selected = Object.entries(getProject(projectPath)?.ports ?? {}).filter(
    ([name]) => name !== BROWSER_LABEL && (!labels || labels.includes(name)),
  );
  const run = await runStops(projectPath, selected, { kind, always: false, dryRun: false, log: () => {}, ...rest });
  return { done: run.done, labels: run.doneLabels, failures: [...run.failures.values()] };
}

export async function clearNamedPorts(
  projectPath: string,
  {
    label,
    stop = false,
    teardown = false,
    dryRun = false,
    log = console.error,
    platform = process.platform,
    signal,
    operation,
  }: {
    label?: string;
    /** Stop each server first: through its recorded stop command, else by signalling its listener. */
    stop?: boolean;
    /** Run each server's recorded teardown command, or its stop command while it listens; never signal a listener. */
    teardown?: boolean;
    dryRun?: boolean;
    log?: (line: string) => void;
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
    operation?: StimContext;
  } = {},
): Promise<void> {
  if (label !== undefined) validatePortLabel(label);
  const select = () =>
    Object.entries(getProject(projectPath)?.ports ?? {}).filter(
      ([name]) => name !== BROWSER_LABEL && (label === undefined || name === label),
    );
  // @ref LLP 0027#stop-commands-run-outside-the-ports-lock -- a slow stop must not block every workspace's ports
  const commands =
    stop || teardown
      ? await runStops(projectPath, select(), {
          kind: teardown ? 'teardown' : 'stop',
          always: stop,
          dryRun,
          log,
          signal,
          operation,
        })
      : { handled: new Set<string>(), failures: new Map<string, string>() };
  await withPortsLock(async () => {
    const selected = select();
    const signalled = stop ? selected.filter(([name]) => !commands.handled.has(name)) : [];
    if (signalled.length > 0 && platform !== 'win32' && !getExecutor().findExecutable('lsof')) {
      throw new Error('Cannot stop named ports: lsof is not installed.');
    }
    const failures: string[] = [];
    for (const [name, port] of selected) {
      signal?.throwIfAborted();
      const failed = commands.failures.get(name);
      if (failed) {
        failures.push(failed);
        continue;
      }
      try {
        if (!Number.isInteger(port) || port < FIRST_PORT || port > LAST_PORT) {
          throw new Error(`Invalid named port ${name} (${port}); repair its config record before cleanup.`);
        }
        if (stop && !commands.handled.has(name)) {
          if (Object.values(loadConfig()?.projects ?? {}).some((project) => project.metroPort === port)) {
            throw new Error(`Port ${port} is reserved for managed Metro; allocation kept.`);
          }
          await stopListeners(port, name, dryRun, log, platform, signal);
        }
        if (dryRun) {
          log(`would release ${name} (${port})`);
          continue;
        }
        await withConfigLockAsync(() => {
          const cfg = loadConfig();
          const project = cfg?.projects?.[projectPath];
          if (!cfg || !project || project.ports?.[name] !== port) return;
          delete project.ports[name];
          if (project.portCommands && Object.hasOwn(project.portCommands, name)) {
            delete project.portCommands[name];
            if (!Object.keys(project.portCommands).length) delete project.portCommands;
          }
          saveConfig(cfg);
        }, signal);
        log(`released ${name} (${port})`);
      } catch (error) {
        signal?.throwIfAborted();
        failures.push(`${name} (${port}): ${(error as Error).message}`);
      }
    }
    if (failures.length) throw new Error(failures.join('\n'));
  }, signal);
}
