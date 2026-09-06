import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExecutor } from '../exec.ts';
import type { CcacheSetup } from './ccache.ts';

export interface PchSetup {
  args: string[];
  env: Record<string, string>;
}

export function resolvePch(root: string, ccache: CcacheSetup, env: NodeJS.ProcessEnv): PchSetup | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = [resolve(here, '..'), resolve(here, '../..')].find((path) =>
    existsSync(join(path, 'shim/android-pch.cmake')),
  );
  if (!packageRoot || process.platform === 'win32') return null;
  const compiler = join(packageRoot, 'dist/pch-compiler.mjs');
  const binary = ccache.env.CMAKE_CXX_COMPILER_LAUNCHER;
  // ccache 4 splits prefix_command on spaces, without shell quoting.
  if (!binary || !existsSync(compiler) || /\s/.test(compiler + process.execPath)) return null;
  for (const [key, variable] of [
    ['prefix_command', 'CCACHE_PREFIX'],
    ['prefix_command_cpp', 'CCACHE_PREFIX_CPP'],
  ]) {
    if (env[variable!]) return null;
    const configured = getExecutor().runFileQuiet(binary, ['--get-config', key!], {
      cwd: root,
      timeoutMs: 5000,
      env: Object.fromEntries(
        Object.entries({ ...env, ...ccache.env }).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
    });
    if (configured === null || configured.trim()) return null;
  }
  const cmake = join(packageRoot, 'shim/android-pch.cmake');
  const identity = createHash('sha256').update(readFileSync(compiler)).update(readFileSync(cmake)).digest('hex');
  return {
    args: ['--init-script', join(packageRoot, 'shim/android-pch.gradle')],
    env: {
      STIM_PCH_CMAKE: cmake,
      STIM_PCH_ROOT: realpathSync(root),
      STIM_PCH_CCACHE: binary,
      STIM_PCH_NODE: process.execPath,
      STIM_PCH_COMPILER: compiler,
      STIM_PCH_HEADERS: join(ccache.dir, 'pch-headers'),
      STIM_PCH_IDENTITY: identity,
    },
  };
}
