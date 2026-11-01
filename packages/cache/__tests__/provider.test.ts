import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHE_PROVIDER_ENV,
  cacheProviderConfigFromEnv,
  loadCacheProvider,
  type CacheProviderConfig,
} from '../provider.ts';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'stim-cache-provider-'));
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function config(provider: string, options: Record<string, unknown> = {}): CacheProviderConfig {
  return { provider, options, baseDir: projectRoot };
}

function writeModule(file: string, source: string): void {
  writeFileSync(join(projectRoot, file), source);
}

test('unwraps a default export only when the namespace carries no apiVersion', async () => {
  writeModule(
    'default.mjs',
    `export default {
  apiVersion: 1,
  createCacheProvider: () => ({ builds: { resolve: () => null, store: () => {} } }),
};
`,
  );

  const loaded = await loadCacheProvider({ projectRoot, config: config('./default.mjs') });
  expect(loaded.unavailable).toBeUndefined();
  expect(typeof loaded.provider?.builds?.store).toBe('function');
});

test('rejects malformed capability methods without throwing', async () => {
  writeModule(
    'bad-metro.mjs',
    `export const apiVersion = 1;
export const createCacheProvider = () => ({ metro: { get: () => null } });
`,
  );
  writeModule(
    'bad-builds.mjs',
    `export const apiVersion = 1;
export const createCacheProvider = () => ({ builds: { store: () => {} } });
`,
  );
  writeModule(
    'empty.mjs',
    `export const apiVersion = 1;
export const createCacheProvider = () => ({});
`,
  );

  expect((await loadCacheProvider({ projectRoot, config: config('./bad-metro.mjs') })).unavailable).toMatch(
    /metro.*get\(\) and set\(\)/,
  );
  expect((await loadCacheProvider({ projectRoot, config: config('./bad-builds.mjs') })).unavailable).toMatch(
    /builds.*resolve\(\) and store\(\)/,
  );
  expect((await loadCacheProvider({ projectRoot, config: config('./empty.mjs') })).unavailable).toMatch(
    /no files, metro or builds capability/,
  );
});

test('the environment transport rejects malformed payloads', () => {
  expect(cacheProviderConfigFromEnv({})).toBeNull();
  expect(cacheProviderConfigFromEnv({ [CACHE_PROVIDER_ENV]: 'not json' })).toBeNull();
  expect(cacheProviderConfigFromEnv({ [CACHE_PROVIDER_ENV]: '{"provider":"./x.cjs"}' })).toBeNull();
  expect(cacheProviderConfigFromEnv({ [CACHE_PROVIDER_ENV]: '{"baseDir":"/tmp"}' })).toBeNull();
  expect(cacheProviderConfigFromEnv({ [CACHE_PROVIDER_ENV]: '{"provider":"./x.cjs","baseDir":"/tmp"}' })).toEqual({
    provider: './x.cjs',
    options: {},
    baseDir: '/tmp',
  });
});
