import type { StimContext } from '@stim-cli/core';
import { lstatSync, readdirSync, realpathSync, renameSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { childEnvironment } from '../../workspace/git-read.ts';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { envDir } from '../../devices/activity.ts';
import { getExecutor } from '../../exec.ts';
import { formatBytes } from '../../fs-util.ts';
import { plural } from '../../command-output.ts';
import { getConfigDir, loadConfig } from '../../workspace/config.ts';
import { measureDu } from '../../devices/report-only-usage.ts';
import { gradleUserHome, gradleVersionDirs, projectGradleVersions } from '../../devices/machine-cache-usage.ts';
import { deviceSweepIsScoped } from './devices.ts';
import { describeError } from './eas-sessions.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';
import { runOperationFile } from '../../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';

const GRADLE_VERSIONS_KIND = 'gradle-versions';
const DAY_MS = 24 * 60 * 60 * 1000;
const PS_TIMEOUT_MS = 10_000;
const MAX_WALK_ENTRIES = 500_000;
const STAGING_PREFIX = '.stim-delete-';
const STAGING = /^\.stim-delete-.+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRADLE_PROCESS =
  /\borg\.gradle\.(?:launcher\.daemon\.bootstrap\.GradleDaemon|wrapper\.GradleWrapperMain|launcher\.GradleMain|launcher\.Main)\b/;
const GRADLE_JAR = /\/gradle\/wrapper\/gradle-wrapper\.jar\b|\/lib\/gradle-[^\s/]*\.jar\b/;
const JAVA = /(?:^|\/)java(?:\.exe)?\s/;
const USER_HOME_ARG = /(?:-Dgradle\.user\.home=|(?:^|\s)(?:-g|--gradle-user-home)[=\s])(\S+)/g;

type GradleSweepBlock =
  | 'machine-global'
  | 'no-registry'
  | 'unsafe-layout'
  | 'listing-failed'
  | 'unreadable-project'
  | 'gradle-running'
  | 'processes-unknown';

type GradleVersionKeptCode =
  | GradleSweepBlock
  | 'pinned'
  | 'not-a-directory'
  | 'walk-failed'
  | 'too-many-entries'
  | 'recently-modified';

interface GradleVersionEntry {
  version: string;
  dirs: string[];
  bytes: number | null;
  lastModifiedAt: string | null;
  willDelete: boolean;
  reason: GradleVersionKeptCode | null;
  detail: string | null;
}

export interface GradleVersionSweep {
  home: string;
  olderThanDays: number | null;
  blocked: { reason: GradleSweepBlock; detail: string } | null;
  /** Why running Gradle blocks deletion; with `pastRunningGradle`, versions are judged as if it had stopped. */
  gradleRunning: string | null;
  /** The pids of the Gradle processes behind `gradleRunning`. */
  gradleRunningPids: number[];
  versions: GradleVersionEntry[];
  leftovers: string[];
}

export function includesGradleVersions(name: string | null | undefined): boolean {
  return name?.trim().toLowerCase() === GRADLE_VERSIONS_KIND;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function missing(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : null;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function layoutProblem(home: string): string | null {
  for (const segment of [['caches'], ['wrapper'], ['wrapper', 'dists']]) {
    const path = join(home, ...segment);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (missing(error)) continue;
      return `${path} cannot be read: ${describeError(error)}`;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return `${path} is not a plain directory`;
    if (realpathOrNull(path) !== path) return `${path} resolves outside ${home}`;
  }
  return null;
}

function plainChild(dir: string, home: string): boolean {
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  } catch {
    return false;
  }
  const real = realpathOrNull(dir);
  const rel = real === null ? '..' : relative(home, real);
  return real === dir && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

interface Walk {
  newestMs: number;
  entries: number;
  error: string | null;
}

function walk(dir: string, into: Walk, maxEntries: number): Walk {
  if (into.error || into.entries > maxEntries) return into;
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    into.error = `${dir}: ${describeError(error)}`;
    return into;
  }
  into.entries += 1;
  into.newestMs = Math.max(into.newestMs, stat.mtimeMs);
  if (!stat.isDirectory()) return into;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    into.error = `${dir}: ${describeError(error)}`;
    return into;
  }
  for (const name of names) walk(join(dir, name), into, maxEntries);
  return into;
}

async function walkAsync(dir: string, into: Walk, maxEntries: number, signal: AbortSignal): Promise<Walk> {
  signal.throwIfAborted();
  if (into.error || into.entries > maxEntries) return into;
  try {
    const stat = await lstat(dir);
    signal.throwIfAborted();
    into.entries += 1;
    into.newestMs = Math.max(into.newestMs, stat.mtimeMs);
    if (stat.isDirectory())
      for (const name of await readdir(dir)) await walkAsync(join(dir, name), into, maxEntries, signal);
  } catch (error) {
    signal.throwIfAborted();
    into.error = `${dir}: ${describeError(error)}`;
  }
  return into;
}

function gradleUserHomeSetting(env: NodeJS.ProcessEnv, cwd: string): string {
  return envDir('GRADLE_USER_HOME', env, cwd) ?? join(env.HOME || env.USERPROFILE || homedir(), '.gradle');
}

function looksLikeGradleHome(arg: string): string | null {
  if (!isAbsolute(arg) || /["']/.test(arg)) return null;
  const real = realpathOrNull(arg);
  if (real === null) return null;
  return [join(real, 'caches'), join(real, 'wrapper')].some((path) => realpathOrNull(path) !== null) ? real : null;
}

function mayUseHome(command: string, homes: readonly string[]): boolean {
  const java = JAVA.test(command);
  const named = homes.some((home) => command.includes(home));
  if (!GRADLE_PROCESS.test(command) && !(java && (GRADLE_JAR.test(command) || named))) return false;
  if (named) return true;
  const declared = [...command.matchAll(USER_HOME_ARG)].map((arg) => arg[1] ?? '');
  return !(
    declared.length > 0 &&
    declared.every((arg) => {
      const real = looksLikeGradleHome(arg);
      return real !== null && !homes.includes(real);
    })
  );
}

async function gradleProcesses(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  signal?: AbortSignal,
  operation?: StimContext,
): Promise<number[] | string> {
  signal?.throwIfAborted();
  let table: string;
  try {
    table = await runOperationFile(operation, getExecutor(), 'ps', ['-axww', '-o', 'pid=,command='], {
      timeoutMs: PS_TIMEOUT_MS,
      cwd,
      ...childEnvironment(env),
      signal,
    });
    signal?.throwIfAborted();
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    signal?.throwIfAborted();
    return describeError(error);
  }
  const homes = [...new Set([home, gradleUserHomeSetting(env, cwd)])];
  return table.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match?.[2] && mayUseHome(match[2], homes) ? [Number(match[1])] : [];
  });
}

function insideConfigDir(dir: string): boolean {
  const config = getConfigDir();
  const rel = relative(realpathOrNull(config) ?? config, dir);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

interface SweepState {
  home: string;
  running: string | null;
  runningPids: number[];
  blocked: GradleVersionSweep['blocked'];
  pinned: Set<string>;
  versionDirs: Map<string, string[]>;
  leftovers: string[];
}

interface LiveCheck {
  blocked: GradleVersionSweep['blocked'];
  pinned: Set<string>;
  running: string | null;
  runningPids: number[];
}

async function liveBlock(
  home: string,
  {
    pastRunning = false,
    env = process.env,
    cwd = process.cwd(),
    operation,
  }: { pastRunning?: boolean; env?: NodeJS.ProcessEnv; cwd?: string; operation?: StimContext } = {},
): Promise<LiveCheck> {
  const processes = await gradleProcesses(home, env, cwd, operation?.signal, operation);
  const config = loadConfig();
  if (config === null)
    return {
      blocked: { reason: 'no-registry', detail: 'no Stim config lists the projects that pin a version' },
      pinned: new Set(),
      running: null,
      runningPids: [],
    };
  const { used, unreadable } = await projectGradleVersions(Object.keys(config.projects ?? {}), operation);
  operation?.signal.throwIfAborted();
  const pinned = new Set(used.keys());
  if (typeof processes === 'string')
    return {
      blocked: { reason: 'processes-unknown', detail: `ps failed: ${processes}` },
      pinned,
      running: null,
      runningPids: [],
    };
  const running = processes.length
    ? `Gradle pid ${processes.join(', ')} may use ${home}; stop idle daemons with stim gc --delete --cache gradle-daemons`
    : null;
  const runningPids = processes;
  if (running && !pastRunning)
    return { blocked: { reason: 'gradle-running', detail: running }, pinned, running, runningPids };
  if (unreadable.length)
    return {
      blocked: {
        reason: 'unreadable-project',
        detail: `${plural(unreadable.length, 'registered project')} could not be read and may pin any version: ${unreadable.join(', ')}`,
      },
      pinned,
      running,
      runningPids,
    };
  return { blocked: null, pinned, running, runningPids };
}

function stagedDirs(home: string): string[] {
  return [join(home, 'caches'), join(home, 'wrapper', 'dists')].flatMap((parent) => {
    try {
      return readdirSync(parent)
        .filter((name) => STAGING.test(name))
        .map((name) => join(parent, name));
    } catch {
      return [];
    }
  });
}

async function sweepState(
  pastRunning = false,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  operation?: StimContext,
): Promise<SweepState> {
  operation?.signal.throwIfAborted();
  const home = gradleUserHome(env, cwd);
  const empty = {
    home,
    pinned: new Set<string>(),
    versionDirs: new Map<string, string[]>(),
    leftovers: [],
    running: null,
    runningPids: [],
  };
  if (deviceSweepIsScoped(env) && !insideConfigDir(home))
    return {
      ...empty,
      blocked: { reason: 'machine-global', detail: `STIM_HOME scopes this config, but ${home} is outside it` },
    };
  const unsafe = layoutProblem(home);
  if (unsafe) return { ...empty, blocked: { reason: 'unsafe-layout', detail: unsafe } };
  const notices: string[] = [];
  const versionDirs = gradleVersionDirs(home, notices);
  const leftovers = stagedDirs(home);
  if (notices.length)
    return { ...empty, versionDirs, leftovers, blocked: { reason: 'listing-failed', detail: notices.join('; ') } };
  const live = await liveBlock(home, { pastRunning, env, cwd, operation });
  return { home, versionDirs, leftovers, ...live };
}

function judgeVersion(
  version: string,
  dirs: string[],
  state: SweepState,
  olderThanDays: number | null,
  now: number,
  maxEntries = MAX_WALK_ENTRIES,
  tree?: Walk,
): Omit<GradleVersionEntry, 'bytes'> {
  const keep = (reason: GradleVersionKeptCode, detail: string, lastModifiedAt: string | null = null) => ({
    version,
    dirs,
    lastModifiedAt,
    willDelete: false,
    reason,
    detail,
  });
  if (state.blocked) return keep(state.blocked.reason, state.blocked.detail);
  if (state.pinned.has(version)) return keep('pinned', 'a registered project pins it');
  if (!dirs.every((dir) => plainChild(dir, state.home)))
    return keep('not-a-directory', `one of its paths is not a plain directory inside ${state.home}`);
  tree ??= dirs.reduce<Walk>((into, dir) => walk(dir, into, maxEntries), { newestMs: 0, entries: 0, error: null });
  const at = tree.entries ? new Date(tree.newestMs).toISOString() : null;
  if (tree.error) return keep('walk-failed', `its files could not all be read: ${tree.error}`, at);
  if (tree.entries > maxEntries)
    return keep('too-many-entries', `it holds more than ${maxEntries} entries, too many to prove it idle`, at);
  if (olderThanDays !== null && now - tree.newestMs < olderThanDays * DAY_MS)
    return keep('recently-modified', `modified within the last ${plural(olderThanDays, 'day')}`, at);
  return { version, dirs, lastModifiedAt: at, willDelete: true, reason: null, detail: null };
}

async function directoryBytes(dirs: string[], operation?: StimContext): Promise<number | null> {
  const size = async (dir: string) => {
    const result = await measureDu(['-sk', dir], operation);
    return result.complete ? (result.sizes.get(dir) ?? null) : null;
  };
  const sizes = [];
  if (operation) for (const dir of dirs) sizes.push(await size(dir));
  else sizes.push(...(await Promise.all(dirs.map(size))));
  return sizes.includes(null) ? null : sizes.reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0);
}

/**
 * The Gradle versions under GRADLE_USER_HOME that no registered project pins, each with whether `--delete` removes
 * its `caches/<version>` and `wrapper/dists/gradle-<version>-*` directories, and the staging directories an earlier
 * removal left. Shared caches such as `modules-2` are never candidates.
 */
export async function collectGradleVersions({
  olderThanDays = null,
  now = Date.now(),
  measure = true,
  maxWalkEntries = MAX_WALK_ENTRIES,
  pastRunningGradle = false,
  operation,
}: {
  olderThanDays?: number | null;
  now?: number;
  measure?: boolean;
  /** The most entries a version may hold for its age to be checked; a larger one is kept. */
  maxWalkEntries?: number;
  /** Judge versions as if running Gradle had stopped, for a caller that stops idle daemons before deleting. */
  pastRunningGradle?: boolean;
  operation?: StimContext;
} = {}): Promise<GradleVersionSweep> {
  const env = operation?.env ?? process.env;
  const state = await sweepState(pastRunningGradle, env, operation?.cwd, operation);
  const read = async ([version, dirs]: [string, string[]]): Promise<GradleVersionEntry> => {
    let tree: Walk | undefined;
    if (operation && !state.blocked && dirs.every((dir) => plainChild(dir, state.home))) {
      tree = { newestMs: 0, entries: 0, error: null };
      for (const dir of dirs) await walkAsync(dir, tree, maxWalkEntries, operation.signal);
    }
    return Object.assign(judgeVersion(version, dirs, state, olderThanDays, now, maxWalkEntries, tree), {
      bytes: measure ? await directoryBytes(dirs, operation) : null,
    });
  };
  const entries = [...state.versionDirs].filter(([version]) => !state.pinned.has(version));
  const versions = [];
  if (operation) for (const entry of entries) versions.push(await read(entry));
  else versions.push(...(await Promise.all(entries.map(read))));
  return {
    home: state.home,
    olderThanDays,
    blocked: state.blocked,
    gradleRunning: state.running,
    gradleRunningPids: state.runningPids,
    versions: versions.toSorted((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1)),
    leftovers: state.leftovers,
  };
}

/** Waits up to `timeoutMs` for these pids to leave the Gradle processes that may use the home; returns those left. */
export async function waitForGradleExit(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const home = gradleUserHome();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const running = await gradleProcesses(home);
    const left = typeof running === 'string' ? [...pids] : pids.filter((pid) => running.includes(pid));
    if (left.length === 0 || Date.now() >= deadline) return left;
    await new Promise((done) => setTimeout(done, 200));
  }
}

function stage(dir: string): string {
  const staging = join(dirname(dir), `${STAGING_PREFIX}${basename(dir)}-${randomUUID()}`);
  renameSync(dir, staging);
  return staging;
}

/**
 * Checks one version again and removes its directories when it is still unpinned and unused: each directory is
 * renamed to a `.stim-delete-*` sibling right after the last process and pin check, then deleted.
 */
export async function deleteGradleVersion(
  version: string,
  {
    olderThanDays = null,
    now = Date.now(),
    operation,
  }: { olderThanDays?: number | null; now?: number; operation?: StimContext } = {},
): Promise<{ deleted: boolean; detail: string }> {
  const state = await sweepState(false, operation?.env, operation?.cwd, operation);
  const dirs = state.versionDirs.get(version) ?? [];
  if (dirs.length === 0 && !state.blocked) return { deleted: false, detail: 'its directories are already gone' };
  let tree: Walk | undefined;
  if (operation && !state.blocked && dirs.every((dir) => plainChild(dir, state.home))) {
    tree = { newestMs: 0, entries: 0, error: null };
    for (const dir of dirs) await walkAsync(dir, tree, MAX_WALK_ENTRIES, operation.signal);
  }
  const judged = judgeVersion(version, dirs, state, olderThanDays, now, MAX_WALK_ENTRIES, tree);
  if (!judged.willDelete) return { deleted: false, detail: judged.detail ?? 'it is no longer eligible' };
  const live = await liveBlock(state.home, { env: operation?.env, cwd: operation?.cwd, operation });
  if (live.blocked) return { deleted: false, detail: live.blocked.detail };
  if (live.pinned.has(version)) return { deleted: false, detail: 'a registered project now pins it' };
  if (!dirs.every((dir) => plainChild(dir, state.home)))
    return { deleted: false, detail: `one of its paths is no longer a plain directory inside ${state.home}` };
  operation?.signal.throwIfAborted();
  const staged = dirs.map(stage);
  for (const dir of staged) {
    operation?.signal.throwIfAborted();
    await rm(dir, { recursive: true, force: true });
  }
  return { deleted: true, detail: dirs.join(', ') };
}

async function deleteLeftovers(sweep: GradleVersionSweep, output: GcOutput, operation?: StimContext): Promise<number> {
  let failures = 0;
  for (const dir of sweep.leftovers) {
    operation?.signal.throwIfAborted();
    try {
      await rm(dir, { recursive: true, force: true });
      output.log(chalk.green(`Finished deleting ${dir}`));
      output.record('gradleVersion', 'done', basename(dir), { id: dir });
    } catch (error) {
      operation?.signal.throwIfAborted();
      failures += 1;
      output.log(chalk.red(`Failed to finish deleting ${dir}: ${describeError(error)}`));
      output.record('gradleVersion', 'failed', basename(dir), { id: dir, detail: describeError(error) });
    }
  }
  return failures;
}

export async function deleteGradleVersions(
  sweep: GradleVersionSweep | null | undefined,
  output: GcOutput = GC_OUTPUT,
  operation?: StimContext,
): Promise<number> {
  operation?.signal.throwIfAborted();
  if (!sweep) return 0;
  let failures = await deleteLeftovers(sweep, output, operation);
  for (const entry of sweep.versions) {
    operation?.signal.throwIfAborted();
    if (!entry.willDelete) continue;
    try {
      const result = await deleteGradleVersion(entry.version, { olderThanDays: sweep.olderThanDays, operation });
      if (result.deleted) {
        output.log(chalk.green(`Deleted Gradle ${entry.version}: ${result.detail}`));
        output.record('gradleVersion', 'done', `Gradle ${entry.version}`, { bytes: entry.bytes, id: entry.dirs[0] });
      } else {
        output.log(chalk.yellow(`Kept Gradle ${entry.version}: ${result.detail}`));
        output.record('gradleVersion', 'kept', `Gradle ${entry.version}`, { detail: result.detail });
      }
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
      operation?.signal.throwIfAborted();
      failures += 1;
      output.log(chalk.red(`Failed to delete Gradle ${entry.version}: ${describeError(error)}`));
      output.record('gradleVersion', 'failed', `Gradle ${entry.version}`, { detail: describeError(error) });
    }
  }
  return failures;
}

export function gradleVersionsPending(sweep: GradleVersionSweep | null | undefined): boolean {
  return Boolean(sweep?.leftovers.length || sweep?.versions.some((entry) => entry.willDelete));
}

export function gradleVersionLines(sweep: GradleVersionSweep | null | undefined): string[] {
  if (!sweep) return [];
  const lines: string[] = [];
  if (sweep.blocked) lines.push(chalk.yellow(`Gradle versions are all kept: ${sweep.blocked.detail}`));
  for (const dir of sweep.leftovers) lines.push(`Unfinished Gradle removal to delete: ${dir}`);
  if (!sweep.versions.length) {
    lines.push(`Gradle versions no registered project pins: none in ${sweep.home}`);
    return lines;
  }
  const deleting = sweep.versions.filter((entry) => entry.willDelete);
  const known = deleting.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  lines.push(
    `Gradle versions no registered project pins (${plural(deleting.length, 'version')} deletable, ${formatBytes(known)}):`,
  );
  for (const entry of sweep.versions) {
    const size = entry.bytes === null ? 'unknown' : formatBytes(entry.bytes);
    lines.push(`  ${entry.version}: ${size}${entry.willDelete || sweep.blocked ? '' : `, kept: ${entry.detail}`}`);
    for (const dir of entry.dirs) lines.push(chalk.dim(`    ${dir}`));
  }
  lines.push(chalk.dim('  modules-2, build-cache-1, jdks and other shared Gradle caches are never deleted.'));
  return lines;
}
