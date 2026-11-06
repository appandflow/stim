import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord, reason } from './internal.ts';
import {
  CACHE_PROVIDER_API_VERSION,
  PROVIDER_LOAD_TIMEOUT_ENV,
  PROVIDER_LOAD_TIMEOUT_MS,
  callWithTimeout,
  timeoutFromEnv,
  type CacheProvider,
  type CacheProviderConfig,
  type CacheProviderModule,
  type LoadCacheProviderResult,
} from './provider-core.ts';

export * from './provider-core.ts';

function moduleCandidate(namespace: unknown): unknown {
  if (!isRecord(namespace)) return namespace;
  if ('apiVersion' in namespace) return namespace;
  return 'default' in namespace ? namespace.default : namespace;
}

function capabilityError(provider: CacheProvider): string | null {
  const files = provider.files;
  if (files !== undefined && (typeof files?.resolve !== 'function' || typeof files?.store !== 'function')) {
    return 'the files capability must implement resolve() and store()';
  }
  const metro = provider.metro;
  if (metro !== undefined && (typeof metro?.get !== 'function' || typeof metro?.set !== 'function')) {
    return 'the metro capability must implement get() and set()';
  }
  const builds = provider.builds;
  if (builds !== undefined && (typeof builds?.resolve !== 'function' || typeof builds?.store !== 'function')) {
    return 'the builds capability must implement resolve() and store()';
  }
  if (metro === undefined && builds === undefined && files === undefined) {
    return 'the provider advertises no files, metro or builds capability';
  }
  return null;
}

export async function loadCacheProvider({
  projectRoot,
  config,
  env,
  timeoutMs = timeoutFromEnv(PROVIDER_LOAD_TIMEOUT_ENV, PROVIDER_LOAD_TIMEOUT_MS),
}: {
  projectRoot: string;
  config?: CacheProviderConfig | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<LoadCacheProviderResult> {
  const reference = typeof config?.provider === 'string' ? config.provider.trim() : '';
  if (!config || reference === '') return { none: true };

  const environment = env === undefined ? undefined : { ...env };
  const outcome = await callWithTimeout(
    () => importCacheProvider({ projectRoot, config, reference, env: environment }),
    timeoutMs,
  );
  if (outcome.timedOut) {
    return { name: reference, unavailable: `the module did not load within ${timeoutMs}ms` };
  }
  if (outcome.failed) return { name: reference, unavailable: outcome.failed };
  return outcome.value ?? { name: reference, unavailable: 'the module produced no provider' };
}

async function importCacheProvider({
  projectRoot,
  config,
  reference,
  env,
}: {
  projectRoot: string;
  config: CacheProviderConfig;
  reference: string;
  env?: NodeJS.ProcessEnv | undefined;
}): Promise<LoadCacheProviderResult> {
  const options = isRecord(config.options) ? config.options : {};
  const baseDir = typeof config.baseDir === 'string' && config.baseDir !== '' ? config.baseDir : projectRoot;

  let namespace: unknown;
  try {
    const resolved = createRequire(join(baseDir, 'package.json')).resolve(reference);
    namespace = await import(pathToFileURL(resolved).href);
  } catch (error) {
    return { name: reference, unavailable: reason(error) };
  }

  const candidate = moduleCandidate(namespace);
  if (!isRecord(candidate) || candidate.apiVersion !== CACHE_PROVIDER_API_VERSION) {
    return {
      name: reference,
      unavailable: `expected apiVersion ${CACHE_PROVIDER_API_VERSION}, found ${JSON.stringify(
        isRecord(candidate) ? candidate.apiVersion : candidate,
      )}`,
    };
  }
  if (typeof candidate.createCacheProvider !== 'function') {
    return { name: reference, unavailable: 'the module does not export createCacheProvider()' };
  }

  let provider: unknown;
  try {
    provider = await (candidate as unknown as CacheProviderModule).createCacheProvider({
      projectRoot,
      options,
      ...(env === undefined ? {} : { env: { ...env } }),
    });
  } catch (error) {
    return { name: reference, unavailable: `createCacheProvider() failed: ${reason(error)}` };
  }
  if (!isRecord(provider)) {
    return { name: reference, unavailable: 'createCacheProvider() did not return a provider object' };
  }
  const invalid = capabilityError(provider as CacheProvider);
  if (invalid) return { name: reference, unavailable: invalid };

  return { name: reference, provider: provider as CacheProvider };
}
