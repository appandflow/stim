import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from '../cache-manifest.ts';
import { getConfigDir } from '../config.ts';
import { withDirLock } from '../dir-lock.ts';
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

const CAS_TOOLCHAIN_FIELDS: readonly (keyof AndroidCasToolchain)[] = ['clang', 'clangxx', 'lld', 'ar', 'ranlib', 'ndk'];

export interface AndroidCasSetup {
  id: string;
  dir: string;
  initScript: string;
  env: Record<string, string>;
}

export function resolveAndroidCas(root: string, env: NodeJS.ProcessEnv = process.env): AndroidCasSetup | null {
  const manifest = env.STIM_ANDROID_CAS_TOOLCHAIN;
  if (!manifest) return null;
  const toolchain = JSON.parse(readFileSync(manifest, 'utf8')) as AndroidCasToolchain;
  const missing = CAS_TOOLCHAIN_FIELDS.filter((field) => typeof toolchain?.[field] !== 'string');
  if (missing.length > 0) throw new Error(`${manifest} declares no ${missing.join(', ')}.`);
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
  const properties = readFileSync(join(toolchain.ndk, 'source.properties'), 'utf8');
  hash.update(properties);
  const ndkVersion = /Pkg.Revision\s*=\s*([^\r\n]+)/.exec(properties)?.[1]?.trim();
  if (!ndkVersion) throw new Error(`Missing NDK version in ${toolchain.ndk}/source.properties.`);
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
