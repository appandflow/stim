import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, renameSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { isScopedHome, type StimContext } from '@stim-cli/core';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { androidHome } from '../../devices/android.ts';
import { getExecutor, runsRealCommands } from '../../exec.ts';
import { listBuildLocks } from '../../engine/build-lock.ts';
import { listBuildSlots } from '../../engine/build-slots.ts';
import { MACHINE_CLEANUP_TEST_GUARD_ENV } from './machine-cleanup-guard-env.ts';
import { STAGING as STAGED } from '../../commands/gc/gradle-versions.ts';
import { runOperationFile } from '../../engine/operation-exec.ts';
import { formatBytes, measuredDirectorySizeAsync } from '../../fs-util.ts';
import { readRunningProcessesAsync } from '../../workspace/running-from.ts';

const SIZE_TIMEOUT_MS = 300_000;
const CLEAN_TIMEOUT_MS = 15 * 60_000;

/** A cache another tool owns, which the last rung empties through that tool's own command. */
export interface ToolCache {
  /** The tool, as its executable is named. */
  tool: string;
  label: string;
  paths: string[];
  /** The argv that empties it, or null when Stim removes `paths` itself because the tool has no command for it. */
  command: readonly string[] | null;
  /** Matches a command line of a running process of the tool. */
  running: RegExp;
}

/** A cache or tool component the last rung only reports, with the command a person runs. */
export interface ReportedCache {
  label: string;
  path: string;
  command: string;
}

export interface ToolCachePlan {
  cache: ToolCache;
  bytes: number | null;
  /** Why the rung leaves it, or null when it runs the command. */
  kept: string | null;
}

export interface ToolCacheResult {
  outcome: 'would' | 'done' | 'kept' | 'failed';
  before: number | null;
  after: number | null;
  detail: string;
}

/** The command line `argv` as a person types it. */
const commandText = (argv: readonly string[]): string => argv.join(' ');

/**
 * The child environment for a tool command: run from the home directory, never prompting, and with a UTF-8 locale
 * CocoaPods requires. Corepack would otherwise ask before it downloads a package manager.
 */
function toolEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    COREPACK_ENABLE_NETWORK: '0',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  };
}

/** Yarn 1's cache, where Yarn itself would report it; looked up by path so no package manager runs or downloads. */
function yarnCacheDirs(env: NodeJS.ProcessEnv): string[] {
  if (env.YARN_CACHE_FOLDER) return [env.YARN_CACHE_FOLDER];
  return [
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'Yarn')
      : join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'yarn'),
  ];
}

/** pnpm's default content-addressed store, looked up by path so no package manager runs or downloads. */
function pnpmStoreDir(env: NodeJS.ProcessEnv): string {
  if (env.PNPM_HOME) return join(env.PNPM_HOME, 'store');
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'pnpm', 'store')
    : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'pnpm', 'store');
}

function gradleHome(env: NodeJS.ProcessEnv): string {
  return env.GRADLE_USER_HOME || join(homedir(), '.gradle');
}

const sharedGradleCache = (name: string): boolean =>
  name === 'modules-2' || /^transforms-\d+$/.test(name) || /^build-cache-\d+$/.test(name);

/** Gradle's version-independent caches: downloaded dependencies, artifact transforms and the local build cache. */
function gradleSharedCaches(env: NodeJS.ProcessEnv): string[] {
  const caches = join(gradleHome(env), 'caches');
  let names: string[];
  try {
    names = readdirSync(caches);
  } catch {
    return [];
  }
  return [
    ...names.filter(sharedGradleCache).map((name) => join(caches, name)),
    ...names
      .filter((name) => STAGED.test(name) && sharedGradleCache(name.slice('.stim-delete-'.length, -37)))
      .map((name) => join(caches, name)),
  ];
}

/** The caches of the package managers and build tools installed on this machine, with where each keeps its data. */
function discoverToolCaches(env: NodeJS.ProcessEnv): ToolCache[] {
  const exec = getExecutor();
  const present = (tool: string) => exec.findExecutable(tool, { env }) !== null;
  const found: ToolCache[] = [];
  if (present('npm')) {
    const dir = env.npm_config_cache || env.NPM_CONFIG_CACHE || join(homedir(), '.npm');
    if (existsSync(dir))
      found.push({
        tool: 'npm',
        label: 'npm cache',
        paths: [dir],
        command: ['npm', 'cache', 'clean', '--force'],
        running: /(^|[\s/])(npm|npx)(\s|$)|npm-cli\.js/,
      });
  }
  if (present('yarn')) {
    const dirs = yarnCacheDirs(env).filter((dir) => existsSync(dir));
    if (dirs.length)
      found.push({
        tool: 'yarn',
        label: 'Yarn cache',
        paths: dirs,
        command: ['yarn', 'cache', 'clean'],
        running: /(^|[\s/])yarn(\.c?js)?(\s|$)/,
      });
  }
  if (present('pnpm')) {
    const dir = pnpmStoreDir(env);
    if (existsSync(dir))
      found.push({
        tool: 'pnpm',
        label: 'pnpm store, unreferenced packages',
        paths: [dir],
        command: ['pnpm', 'store', 'prune'],
        running: /(^|[\s/])pnpm(\.c?js)?(\s|$)/,
      });
  }
  if (present('pod'))
    found.push({
      tool: 'pod',
      label: 'CocoaPods cache',
      paths: [join(homedir(), 'Library', 'Caches', 'CocoaPods')],
      command: ['pod', 'cache', 'clean', '--all'],
      running: /(^|[\s/])pod(\s|$)/,
    });
  const swiftpm =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'org.swift.swiftpm')
      : join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'org.swift.swiftpm');
  const swiftpmPaths = [
    ...(existsSync(swiftpm) ? [swiftpm] : []),
    ...stagedLeftovers(dirname(swiftpm), [basename(swiftpm)]),
  ];
  if (swiftpmPaths.length)
    found.push({
      tool: 'swift',
      label: 'SwiftPM cache',
      paths: swiftpmPaths,
      command: null,
      running: /swift-build|swift-package|swift-frontend|xcodebuild|SourceKitService/,
    });
  const gradle = gradleSharedCaches(env);
  if (gradle.length)
    found.push({
      tool: 'gradle',
      label: "Gradle's dependency, transform and build caches",
      paths: gradle,
      command: null,
      running: /GradleDaemon|GradleWrapperMain|org\.gradle\.launcher|KotlinCompileDaemon/,
    });
  return found;
}

async function pathsBytes(paths: readonly string[], signal?: AbortSignal): Promise<number | null> {
  let total = 0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const bytes = await measuredDirectorySizeAsync(path, {
      timeoutMs: SIZE_TIMEOUT_MS,
      signal,
    });
    if (bytes === null) return null;
    total += bytes;
  }
  return total;
}

/**
 * Which tool caches the rung empties now: each one is kept while a process of its tool runs (an install or a build in
 * flight), and every one is kept when the processes cannot be listed.
 */
export function planToolCaches(
  caches: readonly ToolCache[],
  commandLines: readonly string[] | null,
  sizes: ReadonlyMap<ToolCache, number | null>,
): ToolCachePlan[] {
  return caches.map((cache) => {
    const bytes = sizes.get(cache) ?? null;
    if (commandLines === null) return { cache, bytes, kept: 'the running processes cannot be listed' };
    const busy = commandLines.find((line) => cache.running.test(line));
    return {
      cache,
      bytes,
      kept: busy ? `a ${cache.tool} process runs: ${busy.slice(0, 120)}` : null,
    };
  });
}

/** Sizes each tool cache and decides which the rung empties. */
export async function surveyToolCaches(operation?: StimContext): Promise<ToolCachePlan[]> {
  const env = operation?.env ?? process.env;
  const signal = operation?.signal;
  const caches = discoverToolCaches(env);
  const sizes = new Map<ToolCache, number | null>();
  for (const cache of caches) sizes.set(cache, await pathsBytes(cache.paths, signal));
  const running = await readRunningProcessesAsync(signal);
  return planToolCaches(
    caches,
    running ? running.commands.filter(({ pid }) => pid !== process.pid).map(({ line }) => line) : null,
    sizes,
  );
}

// @ref LLP 0002#machine-wide-deletion-refuses-in-a-scoped-home -- tests must not clean the real machine
/**
 * Why a machine-wide cleanup must not act from here: a home STIM_HOME scopes, or the test runner, which acts only on
 * paths inside its own temporary directory and runs no command through the process executor.
 */
export function machineCleanupRefusal(env: NodeJS.ProcessEnv, paths: readonly string[] = []): string | null {
  if (isScopedHome(env)) return 'STIM_HOME scopes this config, and these caches are machine-wide';
  const testRoot = process.env[MACHINE_CLEANUP_TEST_GUARD_ENV];
  if (!testRoot) return null;
  if (runsRealCommands()) return 'the test runner never cleans the real machine';
  const outside = paths.find((path) => path !== testRoot && !path.startsWith(`${testRoot}${sep}`));
  return outside ? `the test runner never deletes ${outside}, outside its temporary directory` : null;
}

/**
 * Whether a cache sits on a volume that is short: one of `shortDevices`, the device ids of the volumes under the
 * critical level, or any volume when `shortDevices` is null, as `stim gc --pressure critical` asks.
 */
export function onShortVolume(
  paths: readonly string[],
  shortDevices: ReadonlySet<number> | null,
  deviceOf: (path: string) => number | null = deviceOfPath,
): boolean {
  if (shortDevices === null) return true;
  return paths.some((path) => {
    const device = deviceOf(path);
    return device !== null && shortDevices.has(device);
  });
}

function deviceOfPath(path: string): number | null {
  let current = path;
  for (;;) {
    try {
      return statSync(current).dev;
    } catch {
      if (dirname(current) === current) return null;
      current = dirname(current);
    }
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function stagedName(path: string): string {
  return join(dirname(path), `.stim-delete-${basename(path)}-${randomUUID()}`);
}

/** Directories a removal renamed aside and did not finish, under `parent`, of the caches named `names`. */
function stagedLeftovers(parent: string, names: readonly string[]): string[] {
  try {
    return readdirSync(parent)
      .filter((name) => STAGED.test(name) && names.some((cache) => name.startsWith(`.stim-delete-${cache}-`)))
      .map((name) => join(parent, name));
  } catch {
    return [];
  }
}

function stimBuildRunning(): string | null {
  const held = [...listBuildLocks(), ...listBuildSlots()].find((entry) => entry.alive || entry.unresolved);
  return held ? `a Stim build holds ${held.path}${held.unresolved ? ', or its holder cannot be verified' : ''}` : null;
}

export async function cleanToolCache(
  plan: ToolCachePlan,
  act: boolean,
  operation?: StimContext,
): Promise<ToolCacheResult> {
  const { cache } = plan;
  const how = cache.command ? commandText(cache.command) : `remove ${cache.paths.join(', ')}`;
  if (plan.kept)
    return {
      outcome: 'kept',
      before: plan.bytes,
      after: plan.bytes,
      detail: plan.kept,
    };
  if (!act)
    return {
      outcome: 'would',
      before: plan.bytes,
      after: null,
      detail: `stim gc would run ${how}`,
    };
  const signal = operation?.signal;
  const refusal = machineCleanupRefusal(operation?.env ?? process.env, cache.paths);
  if (refusal) return { outcome: 'kept', before: plan.bytes, after: plan.bytes, detail: refusal };
  const linked = cache.command ? undefined : cache.paths.find(isLink);
  if (linked)
    return {
      outcome: 'kept',
      before: plan.bytes,
      after: plan.bytes,
      detail: `${linked} is a link; remove what it points to yourself once no build uses it`,
    };
  if (!cache.command) {
    const building = stimBuildRunning();
    if (building) return { outcome: 'kept', before: plan.bytes, after: plan.bytes, detail: building };
  }
  const running = await readRunningProcessesAsync(signal);
  const again = planToolCaches(
    [cache],
    running ? running.commands.filter(({ pid }) => pid !== process.pid).map(({ line }) => line) : null,
    new Map([[cache, plan.bytes]]),
  )[0];
  if (again?.kept)
    return {
      outcome: 'kept',
      before: plan.bytes,
      after: plan.bytes,
      detail: again.kept,
    };
  const asides: string[] = [];
  try {
    if (cache.command) {
      const [file, ...args] = cache.command;
      if (!file) throw new Error('the cache names no command');
      await runOperationFile(operation, getExecutor(), file, args, {
        timeoutMs: CLEAN_TIMEOUT_MS,
        env: toolEnv(operation?.env ?? process.env),
        cwd: homedir(),
      });
    } else
      for (const path of cache.paths) {
        if (!existsSync(path)) continue;
        const aside = STAGED.test(basename(path)) ? path : stagedName(path);
        if (aside !== path) renameSync(path, aside);
        asides.push(aside);
        await rm(aside, { recursive: true, force: true });
      }
  } catch (error) {
    if (isClaimUnavailable(error)) throw error;
    signal?.throwIfAborted();
    const left = await pathsBytes([...cache.paths, ...asides], signal);
    return {
      outcome: 'failed',
      before: plan.bytes,
      after: left ?? plan.bytes,
      detail: `${how} failed${asides.length ? `, ${left === null ? 'an unknown size' : formatBytes(left)} left aside in ${asides.join(', ')} for the next run to finish` : ''}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const after = await pathsBytes(cache.paths, signal);
  return {
    outcome: 'done',
    before: plan.bytes,
    after,
    detail: `${how}: ${plan.bytes === null ? 'size unknown' : formatBytes(plan.bytes)} before, ${after === null ? 'size unknown' : formatBytes(after)} after`,
  };
}

/** What the last rung only reports: Android NDKs and Exact's shared cache, each with the command a person runs. */
export function reportedCaches(env: NodeJS.ProcessEnv): ReportedCache[] {
  const reported: ReportedCache[] = [];
  const ndkRoot = join(androidHome(env), 'ndk');
  let versions: string[] = [];
  try {
    versions = readdirSync(ndkRoot);
  } catch {}
  for (const version of versions.filter((name) => /^\d+(\.\d+)+$/.test(name)))
    reported.push({
      label: `Android NDK ${version}`,
      path: join(ndkRoot, version),
      command: `sdkmanager --uninstall "ndk;${version}"`,
    });
  const exact = join(homedir(), '.cache', 'exact');
  if (existsSync(exact))
    reported.push({
      label: "Exact's shared cache",
      path: exact,
      command: `rm -rf ${exact} (when no Exact build runs)`,
    });
  return reported;
}

export async function reportedBytes(path: string, signal?: AbortSignal): Promise<number | null> {
  return pathsBytes([path], signal);
}
