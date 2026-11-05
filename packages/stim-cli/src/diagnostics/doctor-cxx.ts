import { access, lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import type { StimContext } from '@stim-cli/core';
import { trackReportResource } from '../report-runtime.ts';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { getExecutor } from '../exec.ts';
import { gitAsync } from '../workspace/git.ts';
import { readAndroidCasToolchain, resolveAndroidCompilerCache } from '../engine/android-cas.ts';
import { listBuildLocks } from '../engine/build-lock.ts';
import { projectCmakeLauncher } from '../engine/ccache.ts';
import { resolveOptimizations } from '../optimizations.ts';
import { defaultAndroidLayout, type AndroidLayout, type SettingsObject } from '../workspace/settings.ts';

export interface CxxLauncherState {
  path: string;
  launcher: string | null;
}

export function parseCmakeCacheLauncher(source: unknown): string | null {
  if (typeof source !== 'string') return null;
  const match = /^CMAKE_CXX_COMPILER_LAUNCHER(?::[A-Z]+)?=(.*)$/m.exec(source);
  return match?.[1]?.trim() || null;
}

async function children(path: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  try {
    return (await readdir(path)).toSorted();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
}

async function moduleRoots(root: string, layout: AndroidLayout, signal?: AbortSignal): Promise<string[]> {
  const modules = [layout.moduleDir];
  const dependencies = join(root, 'node_modules');
  for (const name of await children(dependencies, signal)) {
    if (name.startsWith('.')) continue;
    const entry = join(dependencies, name);
    const packages = name.startsWith('@')
      ? (await children(entry, signal)).map((child) => join(entry, child))
      : [entry];
    modules.push(...packages.map((pkg) => join(pkg, 'android')));
  }
  return modules;
}

async function cacheFiles(base: string, signal?: AbortSignal, depth = 0): Promise<string[]> {
  const files: string[] = [];
  for (const name of await children(base, signal)) {
    signal?.throwIfAborted();
    if (depth === 0 && /^(?:stim-[a-f0-9]{16}|[a-f0-9]{4})$/.test(name)) continue;
    const path = join(base, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) continue;
    if (name === 'CMakeCache.txt' && entry.isFile()) files.push(path);
    else if (depth < 3 && entry.isDirectory() && name !== 'CMakeFiles')
      files.push(...(await cacheFiles(path, signal, depth + 1)));
  }
  return files;
}

export async function readCxxLauncherStates(
  root: string,
  layout: AndroidLayout = defaultAndroidLayout(root),
  signal: AbortSignal | undefined = getExecutor().reportSignal?.(),
): Promise<CxxLauncherState[]> {
  const states: CxxLauncherState[] = [];
  for (const module of await moduleRoots(root, layout, signal)) {
    for (const path of await cacheFiles(join(module, '.cxx'), signal)) {
      states.push({
        path: relative(root, path),
        launcher: parseCmakeCacheLauncher(await readFile(path, { encoding: 'utf8', signal })),
      });
    }
  }
  signal?.throwIfAborted();
  return states;
}

async function declaredLauncher(module: string, signal?: AbortSignal): Promise<boolean> {
  for (const name of ['build.gradle', 'build.gradle.kts', 'CMakeLists.txt']) {
    try {
      if (projectCmakeLauncher(await readFile(join(module, name), { encoding: 'utf8', signal }))) return true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function selectedCompilerCache(settings: SettingsObject | null): string | null {
  if (!settings) return null;
  try {
    return resolveAndroidCompilerCache({ optimizations: resolveOptimizations(settings), use: readAndroidCasToolchain })
      .optimizations.android.compilerCache;
  } catch {
    return null;
  }
}

export interface CxxRepairResult {
  removed: string[];
  refused: { path: string; reason: string }[];
}

/**
 * Keep every native build stopped until repair finishes. The supplemental
 * cache-lock check cannot detect uncached builds, release-swap fallback, or direct Gradle.
 */
export async function repairCxxLauncherState(
  root: string,
  settings: SettingsObject | null,
  layout: AndroidLayout = defaultAndroidLayout(root),
  operation?: StimContext,
): Promise<CxxRepairResult> {
  const signal = operation?.signal;
  signal?.throwIfAborted();
  const canonicalRoot = await realpath(root);
  const result: CxxRepairResult = { removed: [], refused: [] };
  if (selectedCompilerCache(settings) !== 'ccache') return result;
  const ccache = getExecutor().findExecutable('ccache');
  if (!ccache) return result;
  const appOverrides = await declaredLauncher(layout.moduleDir, signal);
  const states = await readCxxLauncherStates(root, layout, signal);
  for (const state of states) {
    signal?.throwIfAborted();
    const command = state.launcher?.split(';')[0]?.trim();
    if (
      state.launcher &&
      !(command && isAbsolute(command) && basename(command) === 'ccache' && !(await exists(command)))
    )
      continue;
    const target = dirname(join(root, state.path));
    const label = relative(root, target);
    try {
      let cxx = target;
      while (contained(root, cxx) && basename(cxx) !== '.cxx') cxx = dirname(cxx);
      if (basename(cxx) !== '.cxx' || target === cxx) throw new Error('unrecognized generated CMake layout');
      if (appOverrides || (await declaredLauncher(dirname(cxx), signal)))
        throw new Error('project configures its own compiler launcher');
      const canonicalTarget = await realpath(target);
      if (!contained(canonicalRoot, canonicalTarget))
        throw new Error('generated directory resolves outside this checkout');
      if ((await realpath(cxx)) !== join(await realpath(dirname(cxx)), '.cxx'))
        throw new Error('.cxx is a symbolic link');
      const gitPath = relative(canonicalRoot, canonicalTarget);
      const tracked = await gitAsync(canonicalRoot, ['ls-files', '-z', '--', `:(literal)${gitPath}`], {
        timeoutMs: 5000,
        signal,
      });
      if (tracked) throw new Error('directory contains tracked files');
      await gitAsync(canonicalRoot, ['check-ignore', '-q', '--', gitPath], { timeoutMs: 5000, signal });
      const androidLocks = listBuildLocks().filter((lock) => lock.platform === 'android');
      if (androidLocks.some((lock) => lock.unresolved)) {
        throw new Error('an Android build lock holder cannot be identified, so a build may be active');
      }
      let active = false;
      for (const lock of androidLocks) {
        if (lock.alive && lock.projectRoot && (await realpath(lock.projectRoot)) === canonicalRoot) active = true;
      }
      if (active) throw new Error('an Android build is active in this checkout');
      if ((await realpath(target)) !== canonicalTarget) throw new Error('directory changed during inspection');
      signal?.throwIfAborted();
      const removed = rm(target, { recursive: true });
      const settled = removed.then(
        () => undefined,
        () => undefined,
      );
      const cleanupFailure = Object.assign(new Error(`CMake repair cleanup is still removing ${target}.`), {
        code: 'STIM_CLAIM_UNAVAILABLE',
        reportCleanup: true,
        cleanupComplete: settled,
      });
      trackReportResource(operation, settled, () => settled, signal, cleanupFailure);
      await removed;
      result.removed.push(label);
    } catch (error) {
      if (
        error instanceof Error &&
        ('reportCleanup' in error || ('code' in error && error.code === 'STIM_CLAIM_UNAVAILABLE'))
      )
        throw error;
      signal?.throwIfAborted();
      result.refused.push({ path: label, reason: (error as Error).message });
    }
  }
  return result;
}
