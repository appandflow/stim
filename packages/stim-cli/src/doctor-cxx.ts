import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { getExecutor } from './exec.ts';
import { listBuildLocks } from './engine/build-lock.ts';
import { projectCmakeLauncher } from './engine/ccache.ts';

export interface CxxLauncherState {
  path: string;
  launcher: string | null;
}

export function parseCmakeCacheLauncher(source: unknown): string | null {
  if (typeof source !== 'string') return null;
  const match = /^CMAKE_CXX_COMPILER_LAUNCHER(?::[A-Z]+)?=(.*)$/m.exec(source);
  return match?.[1]?.trim() || null;
}

function children(path: string): string[] {
  try {
    return readdirSync(path).toSorted();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
}

function moduleRoots(root: string): string[] {
  const modules = [join(root, 'android', 'app')];
  const dependencies = join(root, 'node_modules');
  for (const name of children(dependencies)) {
    if (name.startsWith('.')) continue;
    const entry = join(dependencies, name);
    const packages = name.startsWith('@') ? children(entry).map((child) => join(entry, child)) : [entry];
    modules.push(...packages.map((pkg) => join(pkg, 'android')));
  }
  return modules;
}

function cacheFiles(base: string, depth = 0): string[] {
  const files: string[] = [];
  for (const name of children(base)) {
    const path = join(base, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) continue;
    if (name === 'CMakeCache.txt' && entry.isFile()) files.push(path);
    else if (depth < 3 && entry.isDirectory() && name !== 'CMakeFiles') files.push(...cacheFiles(path, depth + 1));
  }
  return files;
}

export function readCxxLauncherStates(root: string): CxxLauncherState[] {
  return moduleRoots(root).flatMap((module) =>
    cacheFiles(join(module, '.cxx')).map((path) => ({
      path: relative(root, path),
      launcher: parseCmakeCacheLauncher(readFileSync(path, 'utf8')),
    })),
  );
}

function declaredLauncher(module: string): boolean {
  return ['build.gradle', 'build.gradle.kts', 'CMakeLists.txt'].some((name) => {
    const path = join(module, name);
    return existsSync(path) && Boolean(projectCmakeLauncher(readFileSync(path, 'utf8')));
  });
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface CxxRepairResult {
  removed: string[];
  refused: { path: string; reason: string }[];
}

export function repairCxxLauncherState(root: string): CxxRepairResult {
  const canonicalRoot = realpathSync(root);
  const result: CxxRepairResult = { removed: [], refused: [] };
  const ccache = getExecutor().runQuiet('command -v ccache', { timeoutMs: 5000 });
  if (!ccache) return result;
  const appOverrides = declaredLauncher(join(root, 'android', 'app'));
  const states = readCxxLauncherStates(root);
  const targets = states.filter(({ launcher }) => {
    if (!launcher) return true;
    const command = launcher.split(';')[0]?.trim();
    return Boolean(command && isAbsolute(command) && basename(command) === 'ccache' && !existsSync(command));
  });
  for (const state of targets) {
    const target = dirname(join(root, state.path));
    const label = relative(root, target);
    try {
      let cxx = target;
      while (contained(root, cxx) && basename(cxx) !== '.cxx') cxx = dirname(cxx);
      if (basename(cxx) !== '.cxx' || target === cxx) throw new Error('unrecognized generated CMake layout');
      if (appOverrides || declaredLauncher(dirname(cxx)))
        throw new Error('project configures its own compiler launcher');
      const canonicalTarget = realpathSync(target);
      if (!contained(canonicalRoot, canonicalTarget))
        throw new Error('generated directory resolves outside this checkout');
      if (realpathSync(cxx) !== join(realpathSync(dirname(cxx)), '.cxx')) throw new Error('.cxx is a symbolic link');
      const tracked = getExecutor().runFile('git', ['ls-files', '-z', '--', `:(literal)${label}`], {
        cwd: root,
        timeoutMs: 5000,
      });
      if (tracked) throw new Error('directory contains tracked files');
      getExecutor().runFile('git', ['check-ignore', '-q', '--', label], { cwd: root, timeoutMs: 5000 });
      const active = listBuildLocks().some((lock) => {
        if (lock.platform !== 'android' || !lock.alive || !lock.projectRoot) return false;
        return realpathSync(lock.projectRoot) === canonicalRoot;
      });
      if (active) throw new Error('an Android build is active in this checkout');
      if (realpathSync(target) !== canonicalTarget) throw new Error('directory changed during inspection');
      rmSync(target, { recursive: true });
      result.removed.push(label);
    } catch (error) {
      result.refused.push({ path: label, reason: (error as Error).message });
    }
  }
  return result;
}
