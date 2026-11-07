import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { connect } from 'net';
import { homedir } from 'os';
import { basename, dirname, join, sep } from 'path';
import { stimdSocket } from '@stim-cli/core/state';
import type { Finding } from './doctor.ts';
import { engineRoot } from '../engine-store/store.ts';
import { engineLockSocket } from '../engine-store/locks.ts';

export type Harness = 'claude-code' | 'codex' | null;

export interface SandboxAllowance {
  allowWrite: string[];
  allowMachLookup: string[];
  allowUnixSockets: string[];
  allowLocalBinding: boolean;
}

const allowancePaths = (path: string) => {
  if (process.platform === 'win32') return [path];
  const missing: string[] = [];
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  try {
    return [...new Set([path, join(realpathSync(existing), ...missing)])];
  } catch {
    return [path];
  }
};

/**
 * What a sandboxed harness has to permit for Stim to work: its state
 * directory, the XPC service simctl talks to, stimd's socket (also under its
 * resolved directory, as /tmp is /private/tmp on macOS), and the port adb's
 * server binds.
 */
export function sandboxAllowance(
  stimHome: string = '~/.stim',
  socket: string = stimdSocket(),
  env: NodeJS.ProcessEnv = process.env,
): SandboxAllowance {
  const store = engineRoot(env);
  const lock = engineLockSocket(store);
  const socketWrites = [socket, lock].flatMap((path) =>
    path.startsWith('/tmp/stim-sockets-') ? allowancePaths(dirname(path)) : [],
  );
  return {
    allowWrite: [...new Set([stimHome, ...allowancePaths(store), ...socketWrites])],
    allowMachLookup: ['com.apple.coresimulator.*'],
    allowUnixSockets: [...new Set([...allowancePaths(socket), ...allowancePaths(lock)])],
    allowLocalBinding: true,
  };
}

const denied = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES');

/** The error connecting to `path` raised, or null once it connected. */
const reach = (path: string): Promise<unknown> =>
  new Promise((done) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      done(null);
    });
    probe.once('error', done);
  });

/** Whether the sandbox denies either stimd's socket or the engine store lock socket. */
export async function sandboxBlocksSocket(
  socket: string = stimdSocket(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (process.platform === 'win32') return false;
  if (denied(await reach(socket))) return true;
  return denied(await reach(engineLockSocket(engineRoot(env))));
}

export function detectHarness(env: NodeJS.ProcessEnv = process.env): Harness {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (Object.keys(env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  return null;
}

function expandHome(value: string, home: string): string {
  const v = value.trim();
  if (v === '~' || v === '$HOME') return home;
  if (v.startsWith('~/')) return join(home, v.slice(2));
  if (v.startsWith('$HOME/')) return join(home, v.slice(6));
  return v;
}

function sandboxBlocksStimHome(stimHome: string, home: string = homedir()): boolean {
  const dir = expandHome(stimHome, home);
  const probe = join(dir, `.probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES';
  }
}

/** Where a per-user, gitignored Claude Code settings file belongs for this project. */
export function claudeLocalSettingsPath(root: string): string {
  return join(root, '.claude', 'settings.local.json');
}

/** Every settings file that may already carry the allowance, most local first. */
export function allowanceSearchPaths(settingsRoot: string, home: string = homedir()): string[] {
  return [
    claudeLocalSettingsPath(settingsRoot),
    join(settingsRoot, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.json'),
  ];
}

type Settings = Record<string, unknown>;
type ReadResult = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'object'; value: Settings };

function isPlainObject(value: unknown): value is Settings {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Absent, unreadable and present-but-not-an-object are three different states.
 * Collapsing them loses the one distinction that matters before a write: a
 * file whose contents did not parse still holds settings we must not destroy.
 */
function readSettings(path: string): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'invalid' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? { kind: 'object', value: parsed } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function nested(source: Settings | null, ...keys: string[]): unknown {
  let cursor: unknown = source;
  for (const key of keys) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** Whether an allowWrite entry covers the Stim home, including as a parent. */
function covers(entry: string, target: string, home: string): boolean {
  const posix = (value: string): string => {
    const expanded = expandHome(value, home);
    return sep === '/' ? expanded : expanded.replaceAll(sep, '/');
  };
  const e = posix(entry)
    .replace(/\/+\*+$/, '')
    .replace(/\/+$/, '');
  const t = posix(target).replace(/\/+$/, '');
  return e === t || t.startsWith(`${e}/`);
}

/**
 * Which parts of the allowance the settings files already carry. Any file may
 * supply any part, so a project that solved this in one place is not asked to
 * repeat it in another.
 */
export function missingAllowance(
  paths: string[],
  stimHome: string = '~/.stim',
  home: string = homedir(),
  socket: string = stimdSocket(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const files = paths.map((p) => {
    const read = readSettings(p);
    return read.kind === 'object' ? read.value : null;
  });
  const list = (...keys: string[]): string[] =>
    files.flatMap((f) => {
      const value = nested(f, ...keys);
      return Array.isArray(value) ? value.map(String) : [];
    });

  const missing: string[] = [];
  const writeEntries = list('sandbox', 'filesystem', 'allowWrite');
  if (
    !sandboxAllowance(stimHome, socket, env).allowWrite.every((path) => writeEntries.some((w) => covers(w, path, home)))
  ) {
    missing.push('sandbox.filesystem.allowWrite');
  }
  if (
    !list('sandbox', 'network', 'allowMachLookup').some((l) => l.toLowerCase().startsWith('com.apple.coresimulator'))
  ) {
    missing.push('sandbox.network.allowMachLookup');
  }
  const socketEntries = list('sandbox', 'network', 'allowUnixSockets');
  if (
    !sandboxAllowance(stimHome, socket, env).allowUnixSockets.every((path) =>
      socketEntries.some((entry) => covers(entry, path, home)),
    )
  ) {
    missing.push('sandbox.network.allowUnixSockets');
  }
  if (!files.some((f) => nested(f, 'sandbox', 'network', 'allowLocalBinding') === true)) {
    missing.push('sandbox.network.allowLocalBinding');
  }
  return missing;
}

/**
 * The key that stops a merge, or null when the settings can take the
 * allowance. A value of an unexpected shape is someone else's, and rewriting
 * it would lose whatever it means.
 */
export function unmergeableKey(settings: Settings): string | null {
  if (!('sandbox' in settings)) return null;
  if (!isPlainObject(settings.sandbox)) return 'sandbox';
  const sandbox = settings.sandbox;
  if ('filesystem' in sandbox && !isPlainObject(sandbox.filesystem)) return 'sandbox.filesystem';
  if ('network' in sandbox && !isPlainObject(sandbox.network)) return 'sandbox.network';
  return null;
}

function withAllowance(settings: Settings, allowance: SandboxAllowance): Settings {
  const next = { ...settings };
  const sandbox = isPlainObject(next.sandbox) ? { ...next.sandbox } : {};
  const filesystem = isPlainObject(sandbox.filesystem) ? { ...sandbox.filesystem } : {};
  const network = isPlainObject(sandbox.network) ? { ...sandbox.network } : {};

  const writes = Array.isArray(filesystem.allowWrite) ? filesystem.allowWrite.map(String) : [];
  const lookups = Array.isArray(network.allowMachLookup) ? network.allowMachLookup.map(String) : [];
  const sockets = Array.isArray(network.allowUnixSockets) ? network.allowUnixSockets.map(String) : [];

  filesystem.allowWrite = [...new Set([...writes, ...allowance.allowWrite])];
  network.allowMachLookup = [...new Set([...lookups, ...allowance.allowMachLookup])];
  network.allowUnixSockets = [...new Set([...sockets, ...allowance.allowUnixSockets])];
  network.allowLocalBinding = true;

  sandbox.filesystem = filesystem;
  sandbox.network = network;
  next.sandbox = sandbox;
  return next;
}

export type ApplyResult = { status: 'created' | 'updated' } | { status: 'refused'; reason: string };

/**
 * Write the allowance into a Claude Code local settings file, creating it if
 * needed. Refuses whenever the current contents cannot be read back, because
 * the merge would replace settings rather than extend them.
 */
export function applyClaudeAllowance(path: string, allowance: SandboxAllowance): ApplyResult {
  const read = readSettings(path);
  if (read.kind === 'invalid') {
    return {
      status: 'refused',
      reason: `${path} is not a plain JSON object, so Stim cannot merge into it without losing what is there. Comments make a settings file unparseable here even though Claude Code accepts them.`,
    };
  }
  const existing = read.kind === 'object' ? read.value : {};
  const blocker = unmergeableKey(existing);
  if (blocker) {
    return {
      status: 'refused',
      reason: `${path} holds a "${blocker}" that is not an object, so Stim cannot merge into it without discarding that value.`,
    };
  }

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(withAllowance(existing, allowance), null, 2)}\n`);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { status: read.kind === 'absent' ? 'created' : 'updated' };
}

/**
 * The finding a sandboxed session should see: what fails, and the one command
 * that fixes it where the harness has a per-path allowance.
 */
export function sandboxFinding(
  settingsRoot: string,
  {
    env = process.env,
    home = homedir(),
    stimHome = process.env.STIM_HOME || '~/.stim',
    blocked,
    socketBlocked = false,
    platform = process.platform,
  }: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    stimHome?: string;
    blocked?: boolean;
    socketBlocked?: boolean;
    platform?: NodeJS.Platform;
  } = {},
): Finding | null {
  const harness = detectHarness(env);
  if (!harness) return null;
  if (!(blocked ?? (socketBlocked || sandboxBlocksStimHome(stimHome, home)))) return null;

  if (harness === 'claude-code' && platform === 'linux' && socketBlocked) {
    return {
      level: 'cost',
      title: "The sandbox blocks Stim's Unix socket",
      detail: 'Claude Code on Linux cannot allow a single Unix socket path through its sandbox.',
      fix: 'Run Stim outside the sandbox. See `stim guide errors sandbox`.',
    };
  }

  const symptoms = `Writes to ${stimHome} raise EPERM on a directory you can write, commands stop with STIM_SANDBOX_BLOCKED because stimd's socket is denied, the simulator service looks dead, and the adb server looks unreachable.`;
  const title = 'This session sandboxes shell commands, and Stim is not allowed through';

  if (harness === 'codex') {
    return {
      level: 'cost',
      title,
      detail: `${symptoms} Codex has one sandbox setting and no per-path allowance, so there is nothing to add.`,
      fix: 'Run Stim with the sandbox off, or start Codex with `codex -s danger-full-access`, which turns the whole sandbox off rather than allowing these four. See `stim guide errors sandbox`.',
    };
  }

  const paths = allowanceSearchPaths(settingsRoot, home);
  const missing = missingAllowance(paths, stimHome, home, undefined, env);
  if (missing.length === 0) {
    return {
      level: 'cost',
      title: 'Stim is allowed through this sandbox, but the session has not picked it up',
      detail: `${symptoms} ${paths[0]} already grants all four, so the settings were read before they were written.`,
      fix: 'Restart the session for the allowance to take effect.',
    };
  }
  return {
    level: 'cost',
    title,
    detail: `${symptoms} Missing: ${missing.join(', ')}.`,
    fix: `Run \`stim doctor --fix\` to write sandbox.filesystem.allowWrite, sandbox.network.allowMachLookup, sandbox.network.allowUnixSockets, and sandbox.network.allowLocalBinding into ${paths[0]}, merged with what is there, or add the missing keys by hand. See \`stim guide errors sandbox\`.`,
  };
}
