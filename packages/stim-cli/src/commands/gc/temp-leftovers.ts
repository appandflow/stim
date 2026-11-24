import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { lstat, readdir, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import chalk from 'chalk';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { isJsonObject } from '@stim-cli/core/state';
import { getExecutor } from '../../exec.ts';
import { formatBytes } from '../../fs-util.ts';
import { plural } from '../../command-output.ts';
import { removeTemporaryEntryAsync } from '../../temporary.ts';
import { PARITY_PREFIX, parityLeftoverKept, removeParityLeftover } from '../../diagnostics/parity-worktrees.ts';
import { loadConfig } from '../../workspace/config.ts';
import { deviceSweepIsScoped } from './devices.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';
import { TEMP_LEFTOVERS_TEST_GUARD_ENV } from './temp-leftovers-guard-env.ts';
import type { StimContext } from '@stim-cli/core';
import { runOperationFileQuiet } from '../../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';

const TEMP_LEFTOVER_MIN_AGE_HOURS = 24;
const MIN_AGE_MS = TEMP_LEFTOVER_MIN_AGE_HOURS * 60 * 60 * 1000;
const STIM_PREFIXES = [
  'stim-claim-',
  'stim-host-',
  'stim-fakehome-',
  'stim-hosted-macos-',
  'stim-server-',
  'stim-ws-',
  PARITY_PREFIX,
];
const STAGING_PREFIX = '.stim-delete-';
const AGENT_DEVICE_LAUNCHES = 'stim-server-agent-device-';
const LAUNCH_ID = /^[0-9a-f]{16}$/;
export const TRACE_PATTERN: RegExp = /^instruments.*\.ktrace$/;
const TRACE_PROCESSES = new Set(['xctrace', 'Instruments']);
export const SWIFTPM_PATTERN: RegExp = /^TemporaryDirectory\.[A-Za-z0-9]{6}$/;
const SWIFTPM_PROCESSES = new Set([
  'swift',
  'swift-build',
  'swift-frontend',
  'swift-package',
  'swift-run',
  'swift-test',
  'xcodebuild',
]);

type TempLeftoverKind = 'stim' | 'xctrace' | 'swiftpm' | 'jest';
type DeletableKind = Exclude<TempLeftoverKind, 'jest'>;

interface TempLeftover {
  kind: TempLeftoverKind;
  path: string;
  bytes: number;
  willDelete: boolean;
  kept: string | null;
}

export interface TempLeftoverReport {
  root: string;
  entries: TempLeftover[];
  /** Judges an entry again right before deletion (a Stim directory after its rename to `staged`), so a claim or recording use since the scan keeps it. */
  recheck?: (staged: string, original: string, kind: DeletableKind) => Promise<string | null>;
}

const REMEDIES: Record<DeletableKind, string> = {
  stim: 'stim gc --pressure high removes them once they are idle for 24 hours',
  xctrace:
    'stim gc --pressure high removes them once they are idle for 24 hours and no xctrace or Instruments process runs; export a recording you need first',
  swiftpm:
    'stim gc --pressure high removes them once they are idle for 24 hours and no swift or xcodebuild process runs',
};

function kindOf(name: string, stat: Stats): DeletableKind | null {
  const unstaged = name.startsWith(STAGING_PREFIX) ? name.slice(STAGING_PREFIX.length) : name;
  if (stat.isDirectory() && STIM_PREFIXES.some((prefix) => unstaged.startsWith(prefix))) return 'stim';
  if ((stat.isFile() || stat.isDirectory()) && TRACE_PATTERN.test(name)) return 'xctrace';
  if (stat.isDirectory() && SWIFTPM_PATTERN.test(name)) return 'swiftpm';
  return null;
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : String(error);
}

async function lstatOrError(path: string): Promise<Stats | undefined | { error: string }> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' ? undefined : { error: code };
  }
}

interface Walk {
  bytes: number;
  newest: number;
  claimRoots: string[];
  locks: string[];
  unreadable: string | null;
}

async function walk(
  path: string,
  stat: Stats,
  signal?: AbortSignal,
  state: Walk = { bytes: 0, newest: 0, claimRoots: [], locks: [], unreadable: null },
): Promise<Walk> {
  signal?.throwIfAborted();
  state.bytes += stat.size;
  state.newest = Math.max(state.newest, stat.mtimeMs);
  if (!stat.isDirectory()) return state;
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    state.unreadable ??= `${path} cannot be listed: ${errorCode(error)}`;
    return state;
  }
  for (const name of names) {
    const child = join(path, name);
    const childStat = await lstatOrError(child);
    if (!childStat) continue;
    if ('error' in childStat) {
      state.unreadable ??= `${child} cannot be read: ${childStat.error}`;
      continue;
    }
    if ((name === 'exclusive' || name === 'shared') && !state.claimRoots.includes(path)) state.claimRoots.push(path);
    await walk(child, childStat, signal, state);
  }
  if (path.endsWith('.lock') && !state.claimRoots.includes(path)) state.locks.push(path);
  return state;
}

function canonicalKey(path: string): string {
  try {
    const rest: string[] = [];
    let current = resolve(path);
    while (!lstatSync(current, { throwIfNoEntry: false }) && dirname(current) !== current) {
      rest.unshift(basename(current));
      current = dirname(current);
    }
    return join(realpathSync(current), ...rest);
  } catch {
    return resolve(path);
  }
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Basenames of running executables, or null when the process list cannot be read. */
async function runningExecutables(operation?: StimContext, signal?: AbortSignal): Promise<Set<string> | null> {
  const out = await runOperationFileQuiet(operation, getExecutor(), 'ps', ['-axww', '-o', 'comm='], {
    timeoutMs: 10_000,
    cwd: operation?.cwd,
    signal,
  });
  if (out === null) return null;
  return new Set(
    out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => basename(line)),
  );
}

function stimKept(identity: string, scan: Walk, projects: readonly string[]): string | null {
  if (basename(identity).startsWith(PARITY_PREFIX)) {
    const parity = parityLeftoverKept(identity);
    if (parity) return parity;
  }
  const registered = projects.find((root) => inside(identity, root) || inside(root, identity));
  if (registered) return `the registered project ${registered} is in it; gc handles it as a project entry`;
  if (scan.unreadable) return scan.unreadable;
  if (scan.locks.length) return `the lock directory ${scan.locks[0]} has no verifiable owner`;
  for (const root of scan.claimRoots) {
    const survey = readClaimSet(root);
    if (survey.live.length) return `it holds a live ownership claim at ${root}`;
    if (survey.unresolved.length) return `the ownership claim at ${root} cannot be verified`;
  }
  return null;
}

// @ref LLP 0007#a-hosted-device-daemon-launch-shares-nothing-with-the-next -- gc removes a launch only when agent-device reports its daemon stopped
async function retireAgentDeviceLaunches(
  root: string,
  now: number,
  signal: AbortSignal | undefined,
  operation: StimContext | undefined,
): Promise<void> {
  const uid = process.getuid?.();
  for (const name of await readdir(root)) {
    if (!name.startsWith(AGENT_DEVICE_LAUNCHES)) continue;
    const parent = join(root, name);
    const stat = await lstatOrError(parent);
    if (!stat || 'error' in stat || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
    let launches: string[];
    try {
      launches = await readdir(parent);
    } catch {
      continue;
    }
    for (const id of launches) {
      if (!LAUNCH_ID.test(id)) continue;
      const dir = join(parent, id);
      const launch = await lstatOrError(dir);
      if (!launch || 'error' in launch || !launch.isDirectory()) continue;
      const scan = await walk(dir, launch, signal);
      if (scan.unreadable || now - scan.newest < MIN_AGE_MS) continue;
      if ((await agentDeviceDaemonState(join(dir, 'state'), signal, operation)) !== 'stopped') continue;
      await removeTemporaryEntryAsync(dir, signal);
    }
  }
}

/** The daemon state `agent-device daemon status --json` reads for `stateDir`, without contacting or stopping it. */
async function agentDeviceDaemonState(
  stateDir: string,
  signal: AbortSignal | undefined,
  operation: StimContext | undefined,
): Promise<string | null> {
  const { resolveAgentDevice } = await import('@stim-cli/agent-driver-agent-device/agent-device-bin');
  let invocation;
  try {
    invocation = resolveAgentDevice(process.env);
  } catch {
    return null;
  }
  const out = await runOperationFileQuiet(
    operation,
    getExecutor(),
    invocation.command,
    [...invocation.args, 'daemon', 'status', '--state-dir', stateDir, '--json'],
    { timeoutMs: 30_000, env: { AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' }, cwd: operation?.cwd, signal },
  );
  if (out === null) return null;
  try {
    const value: unknown = JSON.parse(out);
    return isJsonObject(value) && isJsonObject(value.data) && typeof value.data.state === 'string'
      ? value.data.state
      : null;
  } catch {
    return null;
  }
}

/** The temporary root `env` selects, with Node's `os.tmpdir()` precedence. */
function temporaryRoot(env: NodeJS.ProcessEnv): string {
  if (env === process.env) return tmpdir();
  const chosen =
    process.platform === 'win32'
      ? env.TEMP || env.TMP || join(env.SystemRoot || env.windir || 'C:\\Windows', 'temp')
      : env.TMPDIR || env.TMP || env.TEMP || '/tmp';
  const driveRoot = process.platform === 'win32' && chosen.endsWith(':\\');
  return chosen.length > 1 && chosen.endsWith(sep) && !driveRoot ? chosen.slice(0, -1) : chosen;
}

/**
 * Recognized leftovers directly inside the user's TMPDIR, never following a symlink: Stim's own temp directories,
 * xctrace recordings and SwiftPM's `TemporaryDirectory.*`. They are deleted only once
 * nothing in them changed for 24 hours. Null with STIM_HOME set, because TMPDIR is shared by every Stim home, and for the real TMPDIR a test
 * process recorded in STIM_TEST_GUARD_REAL_TMPDIR.
 */
export async function collectTempLeftovers({
  now = Date.now(),
  env = process.env,
  signal,
  operation,
  retireLaunches = false,
}: {
  now?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  operation?: StimContext;
  /** First removes idle hosted agent-device launch directories whose daemon agent-device reports stopped. */
  retireLaunches?: boolean;
} = {}): Promise<TempLeftoverReport | null> {
  if (deviceSweepIsScoped(env)) return null;
  let root: string;
  let names: string[];
  try {
    root = await realpath(temporaryRoot(env));
    const guarded = process.env[TEMP_LEFTOVERS_TEST_GUARD_ENV];
    if (guarded && root === guarded) return null;
    if (retireLaunches) await retireAgentDeviceLaunches(root, now, signal, operation);
    names = await readdir(root);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  const uid = process.getuid?.();
  const registeredProjects = () => Object.keys(loadConfig()?.projects ?? {}).flatMap((key) => [key, canonicalKey(key)]);
  let projects = registeredProjects();
  let executables: Set<string> | null | undefined;
  const busy = async (processes: ReadonlySet<string>): Promise<string | null> => {
    if (executables === undefined) executables = await runningExecutables(operation, signal);
    const listed = executables;
    if (listed === null) return 'the running processes could not be listed';
    const running = [...processes].filter((name) => listed.has(name));
    return running.length ? `${running.join(' and ')} is running` : null;
  };
  const judge = async (path: string, stat: Stats, kind: DeletableKind, identity = path) => {
    const scan = await walk(path, stat, signal);
    const kept =
      now - scan.newest < MIN_AGE_MS
        ? `modified within the last ${TEMP_LEFTOVER_MIN_AGE_HOURS}h`
        : kind === 'stim'
          ? stimKept(identity, scan, projects)
          : (scan.unreadable ?? (await busy(kind === 'xctrace' ? TRACE_PROCESSES : SWIFTPM_PROCESSES)));
    return { bytes: scan.bytes, kept };
  };
  const recheck = async (staged: string, original: string, kind: DeletableKind) => {
    const stat = await lstatOrError(staged);
    if (!stat || 'error' in stat || stat.isSymbolicLink()) return 'it changed while it was being deleted';
    if (kind !== 'stim') executables = undefined;
    else projects = registeredProjects();
    return (await judge(staged, stat, kind, original)).kept;
  };
  const entries: TempLeftover[] = [];
  for (const name of names.toSorted()) {
    const path = join(root, name);
    const stat = await lstatOrError(path);
    if (!stat || 'error' in stat || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) continue;
    const kind = kindOf(name, stat);
    if (!kind) continue;
    const identity =
      kind === 'stim' && name.startsWith(STAGING_PREFIX) ? join(root, name.slice(STAGING_PREFIX.length)) : path;
    const { bytes, kept } = await judge(path, stat, kind, identity);
    entries.push({ kind, path, bytes, willDelete: kept === null, kept });
  }
  return { root, entries, recheck };
}

export interface TempLeftoverGroup {
  kind: TempLeftoverKind;
  count: number;
  bytes: number;
  deleteCount: number;
  deleteBytes: number;
  kept: { reason: string; count: number }[];
  remedy: string;
}

function summarize(report: TempLeftoverReport): TempLeftoverGroup[] {
  return (['stim', 'xctrace', 'swiftpm'] as const).flatMap((kind) => {
    const entries = report.entries.filter((entry) => entry.kind === kind);
    if (!entries.length) return [];
    const deleting = entries.filter((entry) => entry.willDelete);
    const kept = new Map<string, number>();
    for (const entry of entries) if (entry.kept) kept.set(entry.kept, (kept.get(entry.kept) ?? 0) + 1);
    return [
      {
        kind,
        count: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        deleteCount: deleting.length,
        deleteBytes: deleting.reduce((sum, entry) => sum + entry.bytes, 0),
        kept: [...kept].map(([reason, count]) => ({ reason, count })),
        remedy: REMEDIES[kind],
      },
    ];
  });
}

export function tempLeftoverSection(
  report: TempLeftoverReport | null | undefined,
): { root: string; groups: TempLeftoverGroup[] } | null {
  return report ? { root: report.root, groups: summarize(report) } : null;
}

/** Deletes what a fresh `collectTempLeftovers` marks for deletion. Returns the bytes freed and the failures. */
export async function deleteTempLeftovers(
  options: { now?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; operation?: StimContext } = {},
  output: GcOutput = GC_OUTPUT,
): Promise<{ count: number; bytes: number; failures: number }> {
  const report = await collectTempLeftovers({ ...options, retireLaunches: true });
  const done = { count: 0, bytes: 0, failures: 0 };
  if (!report) return done;
  for (const entry of report.entries) {
    if (!entry.willDelete) continue;
    try {
      if (entry.kind === 'jest') continue;
      const name = basename(entry.path);
      if (name.startsWith(PARITY_PREFIX)) {
        const parity = await removeParityLeftover(entry.path, options.signal);
        if (!parity.removed) {
          output.record('tempLeftover', 'kept', entry.path, { bytes: entry.bytes, detail: parity.kept ?? 'kept' });
          continue;
        }
        done.count++;
        done.bytes += entry.bytes;
        continue;
      }
      const staged =
        entry.kind !== 'stim' || name.startsWith(STAGING_PREFIX)
          ? entry.path
          : join(report.root, `${STAGING_PREFIX}${name}`);
      const before =
        staged === entry.path ? null : ((await report.recheck?.(entry.path, entry.path, entry.kind)) ?? null);
      if (before) {
        output.record('tempLeftover', 'kept', entry.path, { bytes: entry.bytes, detail: before });
        continue;
      }
      if (staged !== entry.path) await rename(entry.path, staged);
      let kept: string | null;
      try {
        const original = name.startsWith(STAGING_PREFIX)
          ? join(report.root, name.slice(STAGING_PREFIX.length))
          : entry.path;
        kept = (await report.recheck?.(staged, original, entry.kind)) ?? null;
      } catch (error) {
        if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
          throw error;
        kept = `it could not be checked again: ${errorCode(error)}`;
        if (options.signal?.aborted) {
          if (staged !== entry.path) await rename(staged, entry.path).catch(() => {});
          throw error;
        }
      }
      if (kept) {
        let detail = kept;
        try {
          if (staged !== entry.path) await rename(staged, entry.path);
        } catch (error) {
          detail = `${kept}; it stays at ${staged} because it could not be renamed back: ${errorCode(error)}`;
          output.log(chalk.yellow(`Kept ${entry.path} at ${staged}: ${detail}`));
        }
        output.record('tempLeftover', 'kept', entry.path, { bytes: entry.bytes, detail });
        continue;
      }
      await removeTemporaryEntryAsync(staged, options.signal);
      done.count++;
      done.bytes += entry.bytes;
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
      if (options.signal?.aborted) throw error;
      if (errorCode(error) === 'ENOENT') continue;
      done.failures++;
      const detail = error instanceof Error ? error.message : String(error);
      output.log(chalk.red(`Could not delete ${entry.path}: ${detail}`));
      output.record('tempLeftover', 'failed', entry.path, { bytes: entry.bytes, detail });
    }
  }
  if (done.count) {
    output.log(
      chalk.green(`Deleted ${plural(done.count, 'TMPDIR leftover')} (${formatBytes(done.bytes)}) in ${report.root}`),
    );
    output.record('tempLeftover', 'done', report.root, {
      bytes: done.bytes,
      detail: `${plural(done.count, 'entry', 'entries')} deleted`,
    });
  }
  return done;
}
