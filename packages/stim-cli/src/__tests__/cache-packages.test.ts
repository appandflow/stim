import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { METRO_NAMED_CACHE_LAYOUT, metroCacheRoot } from '@stim-cli/core';
import { readManifest } from '../cache/cache-manifest.ts';
import { hasStoreAt } from '../supervisor/metro-store.ts';

async function waitForRegistration(dir: string, timeoutMs = 5000) {
  return vi.waitUntil(() => readManifest().caches.find((cache) => cache.dir === dir), {
    timeout: timeoutMs,
    interval: 10,
  });
}

test('the Metro cache store registers itself on this Node, at the shard depth', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pkg-home2-'));
  const cacheRoot = join(tmpdir(), `stim-pkg-metro-${process.pid}`);
  const namedRoot = join(cacheRoot, 'demo');
  mkdirSync(cacheRoot, { recursive: true });
  process.env.STIM_HOME = home;
  process.env.STIM_METRO_CACHE = cacheRoot;
  writeFileSync(
    join(home, 'caches.json'),
    JSON.stringify({
      version: 1,
      caches: [
        { dir: cacheRoot, name: 'Metro transform cache', prune: 'entries', entriesDepth: 2 },
        {
          dir: cacheRoot,
          name: 'Metro transform cache',
          prune: 'entries',
          entriesDepth: 2,
          layout: METRO_NAMED_CACHE_LAYOUT,
        },
        { dir: cacheRoot, name: 'Unrelated same-root cache', prune: 'entries' },
        { dir: join(home, 'unrelated'), name: 'Unrelated cache', prune: 'entries' },
      ],
    }),
  );
  try {
    const { sharedCacheStores } = await import('@stim-cli/metro');
    class FakeStore {
      root: string;
      constructor(options: { root: string }) {
        this.root = options.root;
      }
    }
    const stores = sharedCacheStores('demo', { FileStore: FakeStore });
    expect((stores[0] as { root: string }).root).toBe(namedRoot);
    expect(hasStoreAt(stores, namedRoot)).toBe(true);

    const record = await waitForRegistration(namedRoot);
    expect(record).toBeTruthy();
    assert(record);
    expect(record.entriesDepth).toBe(2);
    expect(record.prune).toBe('entries');
    expect(record.layout).toBe(METRO_NAMED_CACHE_LAYOUT);
    expect(
      readManifest().caches.some(
        (cache) => cache.dir === cacheRoot && cache.name === 'Metro transform cache' && cache.layout === undefined,
      ),
    ).toBe(false);
    expect(
      readManifest().caches.some((cache) => cache.dir === cacheRoot && cache.layout === METRO_NAMED_CACHE_LAYOUT),
    ).toBe(true);
    expect(readManifest().caches.some((cache) => cache.name === 'Unrelated same-root cache')).toBe(true);
    expect(readManifest().caches.some((cache) => cache.dir === join(home, 'unrelated'))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_METRO_CACHE;
  }
});

test('the Metro package resolves the same cache roots the CLI does', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pkg-home3-'));
  process.env.STIM_HOME = home;
  try {
    const metro = await import('@stim-cli/metro');

    expect(metro.cacheRoot()).toBe(metroCacheRoot());
    expect(metro.cacheRoot('demo')).toBe(metroCacheRoot('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'metro-cache', 'demo'));

    writeFileSync(join(home, 'config.json'), JSON.stringify({ caches: { metroCache: join(home, 'cfg-metro') } }));
    expect(metro.cacheRoot()).toBe(join(home, 'cfg-metro'));
    expect(metro.cacheRoot('demo')).toBe(metroCacheRoot('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'cfg-metro', 'demo'));
    expect(metro.cacheRoot('@scope/app')).toBe(join(home, 'cfg-metro', '-scope-app'));

    process.env.STIM_METRO_CACHE = join(home, 'elsewhere-metro');
    expect(metro.cacheRoot()).toBe(join(home, 'elsewhere-metro'));
    expect(metro.cacheRoot('demo')).toBe(metroCacheRoot('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'elsewhere-metro', 'demo'));

    delete process.env.STIM_METRO_CACHE;
    writeFileSync(join(home, 'config.json'), JSON.stringify({ caches: { metroCache: 'relative/nope' } }));
    expect(metro.cacheRoot()).toBe(join(home, 'metro-cache'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'metro-cache', 'demo'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_METRO_CACHE;
  }
});

test('the Metro package ignores relative overrides, so every cwd resolves the same roots', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'stim-pkg-relhome-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const cwd = process.cwd();
  const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.STIM_HOME = 'rel-home';
  process.env.STIM_METRO_CACHE = 'rel-metro';
  try {
    const metro = await import('@stim-cli/metro');
    const roots = ['a', 'b'].map((name) => {
      const dir = join(fakeHome, name);
      mkdirSync(dir);
      process.chdir(dir);
      return metro.cacheRoot('demo');
    });
    expect(roots[0]).toEqual(join(fakeHome, '.stim', 'metro-cache', 'demo'));
    expect(roots[1]).toEqual(roots[0]);
    const warned = emitWarning.mock.calls.map((call) => String(call[0])).join('\n');
    for (const name of ['STIM_HOME', 'STIM_METRO_CACHE']) expect(warned).toContain(name);
  } finally {
    process.chdir(cwd);
    emitWarning.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fakeHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_METRO_CACHE;
  }
});
