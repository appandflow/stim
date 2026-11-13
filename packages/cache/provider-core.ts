import { reason } from './internal.ts';

export const CACHE_PROVIDER_API_VERSION = 1 as const;

export const PROVIDER_LOAD_TIMEOUT_MS = 10_000;

export const PROVIDER_LOAD_TIMEOUT_ENV = 'STIM_CACHE_LOAD_TIMEOUT_MS';

/**
 * Reads a positive integer millisecond override from the environment. Any other
 * value falls back to the shipped default.
 */
export function timeoutFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw.trim())) return fallback;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/**
 * One resolved provider selection: the module reference, the options passed to
 * its factory, and the directory the reference resolves from.
 */
export interface CacheProviderConfig {
  provider: string;
  options: Record<string, unknown>;
  baseDir: string;
}

export interface BuildCacheTarget {
  projectRoot: string;
  platform: 'ios' | 'android';
  key: string;
}

export interface BuildCacheContext extends BuildCacheTarget {
  signal: AbortSignal;
}

export interface BuildResolveInput extends BuildCacheContext {
  destinationDir: string;
}

export interface BuildStoreInput extends BuildCacheContext {
  sourcePath: string;
  overwrite: boolean;
}

/**
 * Native build artifacts.
 *
 * `resolve` returns an existing path to the artifact for the key, or `null` for
 * a miss. `destinationDir` is a scratch directory Stim creates and owns: a
 * capability that fetches the artifact must materialize it there and return a
 * path inside it, and a capability that already holds a local copy (the
 * built-in filesystem tier) returns that copy instead. A miss must leave
 * `destinationDir` empty.
 *
 * `store` publishes the `.app` directory or `.apk` file at `sourcePath`.
 * `overwrite: false` must keep an entry that already exists for the key;
 * `overwrite: true` must replace it. A capability that owns a local path
 * returns it, and any other capability returns nothing.
 *
 * Stim owns fingerprints and cache keys; the capability owns transport,
 * archive format, authentication, and retention.
 */
/** Stim's own local build cache, which the tiers consult before a provider; unlike a provider's, it may answer synchronously. */
export interface LocalBuildCache {
  resolve(input: BuildResolveInput): string | null | Promise<string | null>;
  store(input: BuildStoreInput): string | null | void | Promise<string | null | void>;
}

export interface BuildCacheCapability {
  resolve(input: BuildResolveInput): Promise<string | null>;
  store(input: BuildStoreInput): Promise<string | null | void>;
}

export interface FileCacheResolveInput {
  key: string;
  destinationDir: string;
  signal: AbortSignal;
}

export interface FileCacheStoreInput {
  key: string;
  sourcePath: string;
  overwrite: boolean;
  signal: AbortSignal;
}

/** Opaque, complete files. Downloads are materialized inside destinationDir; a miss leaves it empty. */
export interface FileCacheCapability {
  resolve(input: FileCacheResolveInput): Promise<string | null>;
  store(input: FileCacheStoreInput): Promise<void>;
  /** Checks presence without downloading; the bytes still need verification when fetched. */
  stat?(input: Pick<FileCacheResolveInput, 'key' | 'signal'>): Promise<{ size: number } | null>;
}

export interface CacheProvider {
  files?: FileCacheCapability;
  builds?: BuildCacheCapability;
}

/**
 * The module shape a provider author exports. `stimPlugin.kinds` declares the supported contract.
 */
export interface CacheProviderModule {
  apiVersion: typeof CACHE_PROVIDER_API_VERSION;
  createCacheProvider(input: {
    projectRoot: string;
    options: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
  }): CacheProvider | Promise<CacheProvider>;
}

export interface LoadCacheProviderResult {
  provider?: CacheProvider;
  name?: string;
  none?: true;
  unavailable?: string;
}

export interface ProviderCallResult<T> {
  value?: T;
  failed?: string;
  timedOut?: true;
}

export type WarnOnce = (code: string, message: string) => void;

export async function callWithTimeout<T>(
  call: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProviderCallResult<T>> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let timer: NodeJS.Timeout | null = null;
  // The timer stays referenced on purpose: an unreferenced one lets Node exit
  // while a provider call is pending, so the deadline never fires and the
  // caller never gets its result.
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => {
          signal?.throwIfAborted();
          return call(controller.signal);
        })
        .then(
          (value) => ({ value }) as ProviderCallResult<T>,
          (error: unknown) => ({ failed: reason(error) }) as ProviderCallResult<T>,
        ),
      expired,
    ]);
    signal?.throwIfAborted();
    return outcome === 'timeout' ? { timedOut: true } : outcome;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (timer) clearTimeout(timer);
  }
}

export function createWarnOnce(emit: (message: string) => void): WarnOnce {
  const seen = new Set<string>();
  return (code, message) => {
    if (seen.has(code)) return;
    seen.add(code);
    emit(message);
  };
}
