import { loadKind, projectPlugin } from '@stim-cli/core/plugin-loader';
import { isRecord } from './internal.ts';
import {
  CACHE_PROVIDER_API_VERSION,
  PROVIDER_LOAD_TIMEOUT_ENV,
  PROVIDER_LOAD_TIMEOUT_MS,
  timeoutFromEnv,
  type CacheProvider,
  type CacheProviderConfig,
  type LoadCacheProviderResult,
} from './provider-core.ts';

export * from './provider-core.ts';

function capabilityError(provider: CacheProvider): string | null {
  const files = provider.files;
  if (files !== undefined && (typeof files?.resolve !== 'function' || typeof files?.store !== 'function')) {
    return 'the files capability must implement resolve() and store()';
  }
  const builds = provider.builds;
  if (builds !== undefined && (typeof builds?.resolve !== 'function' || typeof builds?.store !== 'function')) {
    return 'the builds capability must implement resolve() and store()';
  }
  if (builds === undefined && files === undefined) {
    return 'the provider advertises no files or builds capability';
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

  const options = isRecord(config.options) ? config.options : {};
  const baseDir = typeof config.baseDir === 'string' && config.baseDir !== '' ? config.baseDir : projectRoot;
  const loaded = await loadKind<CacheProvider>({
    reference,
    kind: 'cache-provider',
    version: CACHE_PROVIDER_API_VERSION,
    source: projectPlugin(reference, baseDir),
    factory: 'createCacheProvider',
    input: { projectRoot, options, ...(env === undefined ? {} : { env: { ...env } }) },
    accept(provider) {
      if (!isRecord(provider)) throw new Error('createCacheProvider() did not return a provider object');
      const candidate = provider as CacheProvider;
      const invalid = capabilityError(candidate);
      if (invalid) throw new Error(invalid);
      return candidate;
    },
    timeoutMs,
  });
  return 'value' in loaded ? { name: reference, provider: loaded.value } : { name: reference, ...loaded };
}
