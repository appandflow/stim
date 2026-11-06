import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCacheProvider, type CacheProviderConfig } from '../provider.ts';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'stim-cache-provider-'));
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', stimPlugin: { kinds: { 'cache-provider': 1 } } }),
  );
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

test('unwraps a default factory export', async () => {
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

  expect((await loadCacheProvider({ projectRoot, config: config('./bad-builds.mjs') })).unavailable).toMatch(
    /builds.*resolve\(\) and store\(\)/,
  );
  expect((await loadCacheProvider({ projectRoot, config: config('./empty.mjs') })).unavailable).toMatch(
    /no files or builds capability/,
  );
});

test('a mismatched manifest refuses before importing project code', async () => {
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ stimPlugin: { kinds: { 'cache-provider': 2 } } }));
  writeModule('wrong.mjs', 'throw new Error("plugin code ran");');
  const loaded = await loadCacheProvider({ projectRoot, config: config('./wrong.mjs') });
  expect(loaded.unavailable).toBe('plugin ./wrong.mjs speaks cache-provider 2, this stim speaks 1: stim engine update');
});

test('ignores a malformed metro capability alongside an async build provider', async () => {
  writeModule(
    'ignored.mjs',
    `export const createCacheProvider = async ({ projectRoot, options, env }) => ({
    metro: { get: "invalid" },
    builds: { resolve: () => [projectRoot, options.bucket, env.TOKEN].join('|'), store: () => {} },
  });`,
  );
  const loaded = await loadCacheProvider({
    projectRoot,
    config: config('./ignored.mjs', { bucket: 'cache' }),
    env: { TOKEN: 'captured' },
  });
  expect(
    await loaded.provider?.builds?.resolve({
      projectRoot,
      platform: 'android',
      key: 'key',
      destinationDir: projectRoot,
      signal: new AbortController().signal,
    }),
  ).toBe(`${projectRoot}|cache|captured`);
});
