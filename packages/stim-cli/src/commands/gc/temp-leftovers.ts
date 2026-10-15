import { lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep, isAbsolute } from 'node:path';
import chalk from 'chalk';
import { readClaimSet } from '../../ownership-claim.ts';
import { getExecutor } from '../../exec.ts';
import { directorySize, formatBytes } from '../../fs-util.ts';
import { plural } from '../../command-output.ts';
import { removeTemporaryEntry } from '../../temporary.ts';
import { loadConfig } from '../../workspace/config.ts';
import { deviceSweepIsScoped } from './devices.ts';
import { recordGcResult } from './results.ts';

const TEMP_LEFTOVER_MIN_AGE_HOURS = 24;
const MIN_AGE_MS = TEMP_LEFTOVER_MIN_AGE_HOURS * 60 * 60 * 1000;
const STIM_PREFIXES = ['stim-claim-', 'stim-host-', 'stim-fakehome-', 'stim-hosted-macos-', 'stim-server-', 'stim-ws-'];
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
  if (stat.isDirectory() && STIM_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'stim';
  if ((stat.isFile() || stat.isDirectory()) && TRACE_PATTERN.test(name)) return 'xctrace';
  if (stat.isDirectory() && name === jestName) return 'jest';
  return null;
}

interface Walk {
  bytes: number;
  newest: number;
  claimRoots: string[];
  unreadable: string | null;
}

function walk(
  path: string,
  stat: Stats,
  state: Walk = { bytes: 0, newest: 0, claimRoots: [], unreadable: null },
): Walk {
  state.bytes += stat.size;
  state.newest = Math.max(state.newest, stat.mtimeMs);
  if (!stat.isDirectory()) return state;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (error) {
    state.unreadable ??= `${path} cannot be listed: ${error instanceof Error && 'code' in error ? String(error.code) : String(error)}`;
    return state;
  }
  for (const name of names) {
    const child = join(path, name);
    const childStat = lstatSync(child, { throwIfNoEntry: false });
    if (!childStat) continue;
    if (childStat.isDirectory() && (name === 'exclusive' || name === 'shared') && !state.claimRoots.includes(path))
      state.claimRoots.push(path);
    walk(child, childStat, state);
  }
  return state;
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Basenames of running executables, or null when the process list cannot be read. */
function runningExecutables(): Set<string> | null {
  try {
    const out = getExecutor().runFile('ps', ['-axww', '-o', 'comm='], { timeoutMs: 10_000 });
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

function stimKept(path: string, scan: Walk, projects: readonly string[]): string | null {
  const registered = projects.find((root) => inside(path, root) || inside(root, path));
  if (registered) return `the registered project ${registered} is in it; gc handles it as a project entry`;
  if (scan.unreadable) return scan.unreadable;
  for (const root of scan.claimRoots) {
    const survey = readClaimSet(root);
    if (survey.live.length) return `it holds a live ownership claim at ${root}`;
    if (survey.unresolved.length) return `the ownership claim at ${root} cannot be verified`;
  }
  return null;
}

/**
 * Recognized leftovers directly inside the user's TMPDIR, never following a symlink: Stim's own temp directories,
 * xctrace recordings and Jest's cache. Only the first two are ever deleted, and only once nothing in them changed for
 * 24 hours. Null with STIM_HOME set, because TMPDIR is shared by every Stim home.
 */
export function collectTempLeftovers({
  now = Date.now(),
  env = process.env,
}: { now?: number; env?: NodeJS.ProcessEnv } = {}): TempLeftoverReport | null {
  if (deviceSweepIsScoped(env)) return null;
  let root: string;
  let names: string[];
  try {
    root = realpathSync(tmpdir());
    names = readdirSync(root);
  } catch {
    return null;
  }
  const uid = process.getuid?.();
  const jestName = uid === undefined ? null : `jest_${uid.toString(36)}`;
  const projects = Object.keys(loadConfig()?.projects ?? {});
  let executables: Set<string> | null | undefined;
  const traceBusy = (): string | null => {
    if (executables === undefined) executables = runningExecutables();
    const listed = executables;
    if (listed === null) return 'the running processes could not be listed';
    const running = [...TRACE_PROCESSES].filter((name) => listed.has(name));
    return running.length ? `${running.join(' and ')} is running` : null;
  };
  const entries: TempLeftover[] = [];
  for (const name of names.toSorted()) {
    const path = join(root, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) continue;
    const kind = kindOf(name, stat, jestName);
    if (!kind) continue;
    if (kind === 'jest') {
      const bytes = directorySize(path, { timeoutMs: 10_000 });
      entries.push({ kind, path, bytes, willDelete: false, kept: 'report only: Jest owns it' });
      continue;
    }
    const scan = walk(path, stat);
    const age = now - scan.newest;
    const kept =
      age < MIN_AGE_MS
        ? `modified within the last ${TEMP_LEFTOVER_MIN_AGE_HOURS}h`
        : kind === 'stim'
          ? stimKept(path, scan, projects)
          : (scan.unreadable ?? traceBusy());
    entries.push({ kind, path, bytes: scan.bytes, willDelete: kept === null, kept });
  }
  return { root, entries };
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
export function deleteTempLeftovers(options: { now?: number; env?: NodeJS.ProcessEnv } = {}): {
  count: number;
  bytes: number;
  failures: number;
} {
  const report = collectTempLeftovers(options);
  const done = { count: 0, bytes: 0, failures: 0 };
  if (!report) return done;
  for (const entry of report.entries) {
    if (!entry.willDelete) continue;
    try {
      removeTemporaryEntry(entry.path);
      done.count++;
      done.bytes += entry.bytes;
    } catch (error) {
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
