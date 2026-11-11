import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { androidHome } from '../../devices/android.ts';
import { getExecutor } from '../../exec.ts';
import { runOperationFile } from '../../engine/operation-exec.ts';
import { formatBytes, measuredDirectorySizeAsync } from '../../fs-util.ts';
import { readRunningProcessesAsync } from '../../workspace/running-from.ts';

const SIZE_TIMEOUT_MS = 300_000;
const LOOKUP_TIMEOUT_MS = 30_000;
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
export const commandText = (argv: readonly string[]): string => argv.join(' ');

/**
 * The child environment for a tool command: run from the home directory, never prompting, and with a UTF-8 locale
 * CocoaPods requires. Corepack would otherwise ask before it downloads a package manager.
 */
function toolEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  };
}

async function lookup(argv: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | null> {
  const [file, ...args] = argv;
  if (!file) return null;
  const out = await getExecutor().runFileQuietAsync(file, args, {
    timeoutMs: LOOKUP_TIMEOUT_MS,
    env: toolEnv(env),
    cwd: homedir(),
    signal,
  });
  const line = out?.trim().split('\n').at(-1)?.trim();
  return line && line.startsWith('/') ? line : null;
}

function gradleHome(env: NodeJS.ProcessEnv): string {
  return env.GRADLE_USER_HOME || join(homedir(), '.gradle');
}

/** Gradle's version-independent caches: downloaded dependencies, artifact transforms and the local build cache. */
function gradleSharedCaches(env: NodeJS.ProcessEnv): string[] {
  const caches = join(gradleHome(env), 'caches');
  let names: string[];
  try {
    names = readdirSync(caches);
  } catch {
    return [];
  }
  return names
    .filter((name) => name === 'modules-2' || /^transforms-\d+$/.test(name) || /^build-cache-\d+$/.test(name))
    .map((name) => join(caches, name));
}

/** The caches of the package managers and build tools installed on this machine, with where each keeps its data. */
export async function discoverToolCaches(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ToolCache[]> {
  const exec = getExecutor();
  const present = (tool: string) => exec.findExecutable(tool, { env }) !== null;
  const found: ToolCache[] = [];
  if (present('npm')) {
    const dir = await lookup(['npm', 'config', 'get', 'cache'], env, signal);
    if (dir)
      found.push({
        tool: 'npm',
        label: 'npm cache',
        paths: [dir],
        command: ['npm', 'cache', 'clean', '--force'],
        running: /(^|[\s/])(npm|npx)(\s|$)|npm-cli\.js/,
      });
  }
  if (present('yarn')) {
    const dir = await lookup(['yarn', 'cache', 'dir'], env, signal);
    if (dir)
      found.push({
        tool: 'yarn',
        label: 'Yarn cache',
        paths: [dir],
        command: ['yarn', 'cache', 'clean'],
        running: /(^|[\s/])yarn(\.c?js)?(\s|$)/,
      });
  }
  if (present('pnpm')) {
    const dir = await lookup(['pnpm', 'store', 'path'], env, signal);
    if (dir)
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
  const caches = await discoverToolCaches(env, signal);
  const sizes = new Map<ToolCache, number | null>();
  for (const cache of caches) sizes.set(cache, await pathsBytes(cache.paths, signal));
  const running = await readRunningProcessesAsync(signal);
  return planToolCaches(
    caches,
    running ? running.commands.filter(({ pid }) => pid !== process.pid).map(({ line }) => line) : null,
    sizes,
  );
}

/** Empties one tool cache through its tool's command, or removes Gradle's shared caches, measuring before and after. */
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
  try {
    if (cache.command) {
      const [file, ...args] = cache.command;
      if (!file) throw new Error('the cache names no command');
      await runOperationFile(operation, getExecutor(), file, args, {
        timeoutMs: CLEAN_TIMEOUT_MS,
        env: toolEnv(operation?.env ?? process.env),
        cwd: homedir(),
      });
    } else for (const path of cache.paths) rmSync(path, { recursive: true, force: true });
  } catch (error) {
    if (isClaimUnavailable(error)) throw error;
    signal?.throwIfAborted();
    return {
      outcome: 'failed',
      before: plan.bytes,
      after: await pathsBytes(cache.paths, signal),
      detail: `${how} failed: ${error instanceof Error ? error.message : String(error)}`,
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
