import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from '../cache-manifest.ts';
import { getConfigDir } from '../config.ts';
import { withDirLock } from '../dir-lock.ts';
import type { Optimizations } from '../optimizations.ts';
import { ensureWorkspaceStorage } from '../paths.ts';

interface AndroidCasToolchain {
  clang: string;
  clangxx: string;
  lld: string;
  ar: string;
  ranlib: string;
  ndk: string;
  resourceDir: string;
}

const CAS_TOOLCHAIN_FIELDS: readonly (keyof AndroidCasToolchain)[] = [
  'clang',
  'clangxx',
  'lld',
  'ar',
  'ranlib',
  'ndk',
  'resourceDir',
];

const CAS_TOOLCHAIN_BINARIES: readonly (keyof AndroidCasToolchain)[] = ['clang', 'clangxx', 'lld', 'ar', 'ranlib'];

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function directory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface AndroidCasSetup {
  id: string;
  dir: string;
  initScript: string;
  env: Record<string, string>;
}

export interface AndroidCasToolchainRead {
  toolchain: AndroidCasToolchain;
  ndkVersion: string;
  ndkProperties: string;
}

export function readAndroidCasToolchain(manifest: string): AndroidCasToolchainRead {
  const toolchain = JSON.parse(readFileSync(manifest, 'utf8')) as AndroidCasToolchain;
  const missing = CAS_TOOLCHAIN_FIELDS.filter((field) => typeof toolchain?.[field] !== 'string');
  if (missing.length > 0) throw new Error(`${manifest} declares no ${missing.join(', ')}.`);
  const notExecutable = CAS_TOOLCHAIN_BINARIES.filter((field) => !executableFile(toolchain[field]));
  if (notExecutable.length > 0) throw new Error(`${manifest} names no executable ${notExecutable.join(', ')}.`);
  if (!directory(toolchain.resourceDir))
    throw new Error(`${manifest} names resourceDir ${toolchain.resourceDir}, which is not a directory.`);
  const ndkProperties = readFileSync(join(toolchain.ndk, 'source.properties'), 'utf8');
  const ndkVersion = /Pkg.Revision\s*=\s*([^\r\n]+)/.exec(ndkProperties)?.[1]?.trim();
  if (!ndkVersion) throw new Error(`Missing NDK version in ${toolchain.ndk}/source.properties.`);
  return { toolchain, ndkVersion, ndkProperties };
}

export function resolveAndroidCompilerCache<T>({
  optimizations,
  use,
  env = process.env,
}: {
  optimizations: Optimizations;
  use: (manifest: string) => T;
  env?: NodeJS.ProcessEnv;
}): { cas: T | null; optimizations: Optimizations } {
  if (optimizations.android.compilerCache !== 'cas') return { cas: null, optimizations };
  const manifest = optimizations.android.casToolchain!;
  try {
    return { cas: use(manifest), optimizations };
  } catch (error) {
    const fromEnvironment = Boolean(env.STIM_ANDROID_CAS_TOOLCHAIN);
    return {
      cas: null,
      optimizations: {
        ...optimizations,
        android: {
          ...optimizations.android,
          compilerCache: 'ccache',
          compilerCacheFallback: {
            key: fromEnvironment ? 'STIM_ANDROID_CAS_TOOLCHAIN' : 'optimizations.android.casToolchain',
            reason: `could not be used: ${(error as Error).message.replace(/\.$/, '')}`,
            fromEnvironment,
            manifest,
          },
        },
      },
    };
  }
}

export function resolveAndroidCas(root: string, env: NodeJS.ProcessEnv = process.env): AndroidCasSetup | null {
  const manifest = env.STIM_ANDROID_CAS_TOOLCHAIN;
  if (!manifest) return null;
  const { toolchain, ndkVersion, ndkProperties } = readAndroidCasToolchain(manifest);
  const names = [
    'shim/android-cas.gradle',
    'shim/android-cas.toolchain.cmake',
    'shim/android-cas-pch.cmake',
    'dist/android-cas-compiler.mjs',
  ];
  const scripts = names.map((name) => {
    const path = [`../${name}`, `../../${name}`]
      .map((candidate) => fileURLToPath(new URL(candidate, import.meta.url)))
      .find((candidate) => existsSync(candidate));
    if (!path) throw new Error(`Stim installation is missing ${name}.`);
    return path;
  });
  const hash = createHash('sha256').update(JSON.stringify(toolchain));
  for (const path of [...scripts, toolchain.clang, toolchain.clangxx, toolchain.lld, toolchain.ar, toolchain.ranlib]) {
    hash.update(readFileSync(path));
  }
  hash.update(ndkProperties);
  const id = `apple-cas-${hash.digest('hex')}`;
  const dir = join(getConfigDir(), 'android-cas', id);
  const state = join(ensureWorkspaceStorage(root), 'android-cas', id);
  const context = join(state, 'context.json');
  mkdirSync(state, { recursive: true });
  mkdirSync(dir, { recursive: true });
  withDirLock(join(state, 'setup.lock'), () => {
    for (const name of ['clang', 'clang++']) {
      const path = join(state, name);
      const temporary = `${path}.${randomUUID()}.tmp`;
      symlinkSync(scripts[3]!, temporary);
      renameSync(temporary, path);
    }
    const temporary = `${context}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...toolchain, source: realpathSync(root), state, cache: dir }));
    renameSync(temporary, context);
  });
  register({ dir, name: 'android-cas', prune: 'atomic', note: 'Experimental Android compiler CAS' });
  return {
    id,
    dir,
    initScript: scripts[0]!,
    env: {
      STIM_ANDROID_CAS_CONTEXT: context,
      STIM_ANDROID_CAS_SOURCE_ROOT: realpathSync(root),
      STIM_ANDROID_CAS_STATE: state,
      STIM_ANDROID_CAS_NDK: toolchain.ndk,
      STIM_ANDROID_CAS_NDK_VERSION: ndkVersion,
      STIM_ANDROID_CAS_AR: toolchain.ar,
      STIM_ANDROID_CAS_RANLIB: toolchain.ranlib,
      STIM_ANDROID_CAS_CMAKE_TOOLCHAIN: scripts[1]!,
      STIM_ANDROID_CAS_CMAKE_PCH: scripts[2]!,
      CMAKE_C_COMPILER_LAUNCHER: '',
      CMAKE_CXX_COMPILER_LAUNCHER: '',
      CCACHE_DISABLE: '1',
    },
  };
}
