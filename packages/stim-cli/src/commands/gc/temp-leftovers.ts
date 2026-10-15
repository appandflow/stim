import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { lstat, readdir, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import chalk from 'chalk';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { getExecutor } from '../../exec.ts';
import { directorySizeAsync, formatBytes } from '../../fs-util.ts';
import { plural } from '../../command-output.ts';
import { removeTemporaryEntry } from '../../temporary.ts';
import { loadConfig } from '../../workspace/config.ts';
import { deviceSweepIsScoped } from './devices.ts';
import { recordGcResult } from './results.ts';
import { TEMP_LEFTOVERS_TEST_GUARD_ENV } from './temp-leftovers-guard-env.ts';

const TEMP_LEFTOVER_MIN_AGE_HOURS = 24;
const MIN_AGE_MS = TEMP_LEFTOVER_MIN_AGE_HOURS * 60 * 60 * 1000;
const STIM_PREFIXES = ['stim-claim-', 'stim-host-', 'stim-fakehome-', 'stim-hosted-macos-', 'stim-server-', 'stim-ws-'];
const STAGING_PREFIX = '.stim-delete-';
const TRACE_PATTERN = /^instruments.*\.ktrace$/;
const TRACE_PROCESSES = new Set(['xctrace', 'Instruments']);

type TempLeftoverKind = 'stim' | 'xctrace' | 'jest';

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
  recheck?: (staged: string, original: string, kind: 'stim' | 'xctrace') => Promise<string | null>;
}

const REMEDIES: Record<TempLeftoverKind, string> = {
  stim: 'stim gc --delete removes them once they are idle for 24 hours',
  xctrace:
    'stim gc --delete removes them once they are idle for 24 hours and no xctrace or Instruments process runs; export a recording you need first',
  jest: 'Jest owns this cache; clear it with `npx jest --clearCache`',
};

const LABELS: Record<TempLeftoverKind, string> = {
  stim: 'Stim temp directories',
  xctrace: 'xctrace recordings (instruments*.ktrace)',
  jest: 'Jest cache',
};

function kindOf(name: string, stat: Stats, jestName: string | null): TempLeftoverKind | null {
  const unstaged = name.startsWith(STAGING_PREFIX) ? name.slice(STAGING_PREFIX.length) : name;
  if (stat.isDirectory() && STIM_PREFIXES.some((prefix) => unstaged.startsWith(prefix))) return 'stim';
  if ((stat.isFile() || stat.isDirectory()) && TRACE_PATTERN.test(name)) return 'xctrace';
  if (stat.isDirectory() && name === jestName) return 'jest';
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
    if (childStat.isDirectory() && (name === 'exclusive' || name === 'shared') && !state.claimRoots.includes(path))
      state.claimRoots.push(path);
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
async function runningExecutables(): Promise<Set<string> | null> {
  try {
    const out = await getExecutor().runFileAsync('ps', ['-axww', '-o', 'comm='], { timeoutMs: 10_000 });
    return new Set(
      out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => basename(line)),
    );
  } catch {
    return null;
  }
}

function stimKept(identity: string, scan: Walk, projects: readonly string[]): string | null {
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

/** The temporary root `env` selects, with Node's `os.tmpdir()` precedence. */
function temporaryRoot(env: NodeJS.ProcessEnv): string {
  if (env === process.env) return tmpdir();
  const chosen =
    process.platform === 'win32'
      ? (env.TEMP ?? env.TMP ?? join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'temp'))
      : (env.TMPDIR ?? env.TMP ?? env.TEMP ?? '/tmp');
  return chosen.length > 1 && chosen.endsWith(sep) ? chosen.slice(0, -1) : chosen;
}

/**
 * Recognized leftovers directly inside the user's TMPDIR, never following a symlink: Stim's own temp directories,
 * xctrace recordings and Jest's cache. Only the first two are ever deleted, and only once nothing in them changed for
 * 24 hours. Null with STIM_HOME set, because TMPDIR is shared by every Stim home, and for the real TMPDIR a test
 * process recorded in STIM_TEST_GUARD_REAL_TMPDIR.
 */
export async function collectTempLeftovers({
  now = Date.now(),
  env = process.env,
  signal,
}: { now?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<TempLeftoverReport | null> {
  if (deviceSweepIsScoped(env)) return null;
  let root: string;
  let names: string[];
  try {
    root = await realpath(temporaryRoot(env));
    const guarded = process.env[TEMP_LEFTOVERS_TEST_GUARD_ENV];
    if (guarded && root === guarded) return null;
    names = await readdir(root);
  } catch {
    return null;
  }
  const uid = process.getuid?.();
  const jestName = uid === undefined ? null : `jest_${uid.toString(36)}`;
  const registeredProjects = () => Object.keys(loadConfig()?.projects ?? {}).flatMap((key) => [key, canonicalKey(key)]);
  let projects = registeredProjects();
  let executables: Set<string> | null | undefined;
  const traceBusy = async (): Promise<string | null> => {
    if (executables === undefined) executables = await runningExecutables();
    const listed = executables;
    if (listed === null) return 'the running processes could not be listed';
    const running = [...TRACE_PROCESSES].filter((name) => listed.has(name));
    return running.length ? `${running.join(' and ')} is running` : null;
  };
  const judge = async (path: string, stat: Stats, kind: 'stim' | 'xctrace', identity = path) => {
    const scan = await walk(path, stat, signal);
    const kept =
      now - scan.newest < MIN_AGE_MS
        ? `modified within the last ${TEMP_LEFTOVER_MIN_AGE_HOURS}h`
        : kind === 'stim'
          ? stimKept(identity, scan, projects)
          : (scan.unreadable ?? (await traceBusy()));
    return { bytes: scan.bytes, kept };
  };
  const recheck = async (staged: string, original: string, kind: 'stim' | 'xctrace') => {
    const stat = await lstatOrError(staged);
    if (!stat || 'error' in stat || stat.isSymbolicLink()) return 'it changed while it was being deleted';
    if (kind === 'xctrace') executables = undefined;
    else projects = registeredProjects();
    return (await judge(staged, stat, kind, original)).kept;
  };
  const entries: TempLeftover[] = [];
  for (const name of names.toSorted()) {
    const path = join(root, name);
    const stat = await lstatOrError(path);
    if (!stat || 'error' in stat || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) continue;
    const kind = kindOf(name, stat, jestName);
    if (!kind) continue;
    if (kind === 'jest') {
      const bytes = await directorySizeAsync(path, { timeoutMs: 10_000 });
      entries.push({ kind, path, bytes, willDelete: false, kept: 'report only: Jest owns it' });
      continue;
    }
    const { bytes, kept } = await judge(path, stat, kind);
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
  return (['stim', 'xctrace', 'jest'] as const).flatMap((kind) => {
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

export function tempLeftoverLines(report: TempLeftoverReport | null | undefined): string[] {
  if (!report?.entries.length) return [];
  const groups = summarize(report);
  const total = groups.reduce((sum, group) => sum + group.bytes, 0);
  const lines = [`TMPDIR leftovers (${formatBytes(total)} in ${report.entries.length}) - ${report.root}:`];
  for (const group of groups) {
    lines.push(`  ${formatBytes(group.bytes).padStart(10)}  ${LABELS[group.kind]}: ${group.count}`);
    if (group.deleteCount)
      lines.push(`              --delete would DELETE ${group.deleteCount} (${formatBytes(group.deleteBytes)})`);
    for (const { reason, count } of group.kept) lines.push(`              kept ${count}: ${reason}`);
    lines.push(`              remedy: ${group.remedy}`);
  }
  return lines;
}

export function tempLeftoverSection(
  report: TempLeftoverReport | null | undefined,
): { root: string; groups: TempLeftoverGroup[] } | null {
  return report ? { root: report.root, groups: summarize(report) } : null;
}

/** Deletes what a fresh `collectTempLeftovers` marks for deletion. Returns the bytes freed and the failures. */
export async function deleteTempLeftovers(
  options: { now?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<{ count: number; bytes: number; failures: number }> {
  const report = await collectTempLeftovers(options);
  const done = { count: 0, bytes: 0, failures: 0 };
  if (!report) return done;
  for (const entry of report.entries) {
    if (!entry.willDelete) continue;
    try {
      if (entry.kind === 'jest') continue;
      const name = basename(entry.path);
      const staged =
        entry.kind === 'xctrace' || name.startsWith(STAGING_PREFIX)
          ? entry.path
          : join(report.root, `${STAGING_PREFIX}${name}`);
      const before =
        staged === entry.path ? null : ((await report.recheck?.(entry.path, entry.path, entry.kind)) ?? null);
      if (before) {
        recordGcResult('tempLeftover', 'kept', entry.path, { bytes: entry.bytes, detail: before });
        continue;
      }
      if (staged !== entry.path) await rename(entry.path, staged);
      const kept = (await report.recheck?.(staged, entry.path, entry.kind)) ?? null;
      if (kept) {
        let detail = kept;
        try {
          if (staged !== entry.path) await rename(staged, entry.path);
        } catch (error) {
          detail = `${kept}; it stays at ${staged} because it could not be renamed back: ${errorCode(error)}`;
          console.log(chalk.yellow(`Kept ${entry.path} at ${staged}: ${detail}`));
        }
        recordGcResult('tempLeftover', 'kept', entry.path, { bytes: entry.bytes, detail });
        continue;
      }
      removeTemporaryEntry(staged);
      done.count++;
      done.bytes += entry.bytes;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      done.failures++;
      const detail = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`Could not delete ${entry.path}: ${detail}`));
      recordGcResult('tempLeftover', 'failed', entry.path, { bytes: entry.bytes, detail });
    }
  }
  if (done.count) {
    console.log(
      chalk.green(`Deleted ${plural(done.count, 'TMPDIR leftover')} (${formatBytes(done.bytes)}) in ${report.root}`),
    );
    recordGcResult('tempLeftover', 'done', report.root, {
      bytes: done.bytes,
      detail: `${plural(done.count, 'entry', 'entries')} deleted`,
    });
  }
  return done;
}
