import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { SettingsObject } from './types.ts';

export const OPTIMIZATION_SHAPES = {
  optimizations: 'object',
  'optimizations.buildCache': 'boolean',
  'optimizations.remoteBuildCache': 'boolean',
  'optimizations.releaseBundleSwap': 'boolean',
  'optimizations.metroSharedCache': 'boolean',
  'optimizations.ios': 'object',
  'optimizations.ios.compilationCache': 'boolean',
  'optimizations.ios.swiftCompilationCache': 'boolean',
  'optimizations.ios.prefixMapping': 'boolean',
  'optimizations.android': 'object',
  'optimizations.android.compilerCache': 'string',
  'optimizations.android.casToolchain': 'path',
  'optimizations.android.pch': 'string',
  'optimizations.android.gradleBuildCache': 'boolean',
  'optimizations.android.targetAbiOnly': 'boolean',
} as const;

export interface Optimizations {
  buildCache: boolean;
  remoteBuildCache: boolean;
  releaseBundleSwap: boolean;
  metroSharedCache: boolean;
  ios: { compilationCache: boolean; swiftCompilationCache: boolean; prefixMapping: boolean };
  android: {
    compilerCache: 'ccache' | 'cas' | 'none';
    casToolchain: string | null;
    compilerCacheFallback: CompilerCacheFallback | null;
    pch: 'auto' | 'on' | 'off';
    gradleBuildCache: boolean;
    targetAbiOnly: boolean;
  };
}

export interface CompilerCacheFallback {
  key: string;
  reason: string;
  fromEnvironment: boolean;
}

export function compilerCacheFallbackMessage({
  fallback,
  compilerCache,
  file = null,
}: {
  fallback: CompilerCacheFallback;
  compilerCache: 'ccache' | 'none';
  file?: string | null;
}): string {
  const origin = fallback.fromEnvironment ? 'the environment' : file;
  const backend =
    compilerCache === 'none'
      ? 'Android builds use no compiler cache, because optimizations.android.compilerCache is "none".'
      : 'Android builds fall back to ccache when it is available.';
  return `${fallback.key}${origin ? ` in ${origin}` : ''} ${fallback.reason}. ${backend}`;
}

export function optimizationBuildProfile(platform: 'ios' | 'android', options: Optimizations): string | undefined {
  const selected = platform === 'ios' ? options.ios : { pch: options.android.pch };
  const defaults =
    platform === 'ios'
      ? { compilationCache: true, swiftCompilationCache: false, prefixMapping: true }
      : { pch: 'auto' };
  if (JSON.stringify(selected) === JSON.stringify(defaults)) return undefined;
  return `opt-${createHash('sha256').update(JSON.stringify(selected)).digest('hex').slice(0, 16)}`;
}

export function resolveOptimizations(
  settings: SettingsObject = {},
  env: NodeJS.ProcessEnv = process.env,
): Optimizations {
  function choice<T extends string>(path: string, choices: readonly T[], fallback: T): T {
    const raw = optimizationValue(settings, path);
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !choices.includes(raw as T)) {
      throw new Error(`Invalid optimizations.${path}. Expected ${choices.join(', ')}.`);
    }
    return raw as T;
  }
  const compiler = choice('android.compilerCache', ['auto', 'ccache', 'cas', 'none'], 'auto');
  const fromEnvironment = Boolean(env.STIM_ANDROID_CAS_TOOLCHAIN);
  const manifest = env.STIM_ANDROID_CAS_TOOLCHAIN || optimizationValue(settings, 'android.casToolchain');
  let fallback: CompilerCacheFallback | null = null;
  let toolchain: string | null = null;
  if (manifest !== undefined) {
    if (typeof manifest === 'string' && isAbsolute(manifest) && !/[\r\n\0]/.test(manifest)) {
      toolchain = manifest;
    } else {
      fallback = {
        key: fromEnvironment ? 'STIM_ANDROID_CAS_TOOLCHAIN' : 'optimizations.android.casToolchain',
        reason: `is ${JSON.stringify(manifest)}, which is not an absolute path to a toolchain JSON manifest`,
        fromEnvironment,
      };
    }
  }
  let compilerCache = compiler === 'auto' ? (toolchain ? 'cas' : 'ccache') : compiler;
  if (compilerCache === 'cas' && !toolchain) {
    fallback ??= {
      key: 'optimizations.android.compilerCache',
      reason:
        'is "cas", but no optimizations.android.casToolchain or STIM_ANDROID_CAS_TOOLCHAIN names the toolchain manifest',
      fromEnvironment: false,
    };
    compilerCache = 'ccache';
  }
  return {
    buildCache: optimizationBoolean(settings, 'buildCache'),
    remoteBuildCache: optimizationBoolean(settings, 'remoteBuildCache'),
    releaseBundleSwap: optimizationBoolean(settings, 'releaseBundleSwap'),
    metroSharedCache: optimizationBoolean(settings, 'metroSharedCache'),
    ios: {
      compilationCache: optimizationBoolean(settings, 'ios.compilationCache'),
      swiftCompilationCache: optimizationBoolean(settings, 'ios.swiftCompilationCache', false),
      prefixMapping: optimizationBoolean(settings, 'ios.prefixMapping'),
    },
    android: {
      compilerCache,
      casToolchain: toolchain,
      compilerCacheFallback: fallback,
      pch: choice('android.pch', ['auto', 'on', 'off'], 'auto'),
      gradleBuildCache: optimizationBoolean(settings, 'android.gradleBuildCache'),
      targetAbiOnly: optimizationBoolean(settings, 'android.targetAbiOnly'),
    },
  };
}

export function artifactCachePolicy(
  options: Optimizations,
  reuse: boolean,
  release: boolean,
): { read: boolean; write: boolean; remote: boolean } {
  return {
    read: reuse && options.buildCache && (!release || options.releaseBundleSwap),
    write: options.buildCache,
    remote: options.buildCache && options.remoteBuildCache,
  };
}

function optimizationValue(settings: SettingsObject, path: string): unknown {
  let node: unknown = settings;
  for (const key of ['optimizations', ...path.split('.')]) {
    if (node === undefined) return undefined;
    if (!node || typeof node !== 'object' || Array.isArray(node))
      throw new Error('Invalid optimizations setting. Expected nested objects.');
    node = (node as SettingsObject)[key];
  }
  return node;
}

function optimizationBoolean(settings: SettingsObject, path: string, fallback = true): boolean {
  const raw = optimizationValue(settings, path);
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') throw new Error(`Invalid optimizations.${path}. Expected true or false.`);
  return raw;
}

export function resolveMetroSharedCache(settings: SettingsObject): boolean {
  return optimizationBoolean(settings, 'metroSharedCache');
}
