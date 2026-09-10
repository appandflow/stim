export function applyMetroCacheGeneration<T extends { cacheVersion?: string }>(
  config: T,
  generation: string | undefined,
  directory: string,
): T;
