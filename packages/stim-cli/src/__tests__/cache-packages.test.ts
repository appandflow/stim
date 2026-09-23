import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { METRO_NAMED_CACHE_LAYOUT } from '@stim-cli/core';
import { readManifest } from '../cache/cache-manifest.ts';
import { sharedBuildCache, sharedMetroCache } from '../workspace/paths.ts';
import { hasStoreAt } from '../supervisor/metro-store.ts';
import { buildCacheKey, resolveBuild, storeBuild, storedSources } from '../cache/build-cache.ts';

async function waitForRegistration(dir: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = readManifest().caches.find((c) => c.dir === dir);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

test.each(['ios', 'android'])(
  "the CLI and standalone provider read each other's %s artifacts without replacing existing entries",
  async (platform) => {
    const state = mkdtempSync(join(tmpdir(), 'stim-pkg-artifacts-'));
    process.env.STIM_HOME = state;
    process.env.STIM_BUILD_CACHE = join(state, 'cache');
    try {
      const provider = await import('@stim-cli/expo-build-cache');
      const build = join(state, platform === 'ios' ? 'My App.app' : 'My App.apk');
      if (platform === 'ios') mkdirSync(build);
      const binary = platform === 'ios' ? join(build, 'binary') : build;
      writeFileSync(binary, 'provider bytes');
      const runOptions = platform === 'android' ? { abi: 'arm64-v8a' } : {};

      const providerArtifact = await provider.uploadBuildCache({
        platform,
        fingerprintHash: 'provider',
        buildPath: build,
        runOptions,
      });
      const providerKey = buildCacheKey(platform, 'provider', runOptions);
      expect(resolveBuild(platform, providerKey)).toBe(providerArtifact);
      assert(providerArtifact);
      const providerBinary = platform === 'ios' ? join(providerArtifact, 'binary') : providerArtifact;
      expect(readFileSync(providerBinary, 'utf8')).toBe('provider bytes');

      writeFileSync(binary, 'CLI bytes');
      const cliKey = buildCacheKey(platform, 'cli', runOptions);
      const sources = [{ type: 'file' as const, filePath: 'native-input', reasons: [], hash: 'hash' }];
      const cliArtifact = storeBuild(platform, cliKey, build, { sources });
      const cliEntry = join(process.env.STIM_BUILD_CACHE, platform, cliKey);
      const old = new Date(0);
      utimesSync(cliEntry, old, old);
      expect(await provider.resolveBuildCache({ platform, fingerprintHash: 'cli', runOptions })).toBe(cliArtifact);
      expect(statSync(cliEntry).mtimeMs).toBeGreaterThan(old.getTime());

      writeFileSync(binary, 'replacement bytes');
      expect(await provider.uploadBuildCache({ platform, fingerprintHash: 'cli', buildPath: build, runOptions })).toBe(
        cliArtifact,
      );
      expect(storeBuild(platform, providerKey, build)).toBe(providerArtifact);
      expect(readFileSync(providerBinary, 'utf8')).toBe('provider bytes');
      assert(cliArtifact);
      const cliBinary = platform === 'ios' ? join(cliArtifact, 'binary') : cliArtifact;
      expect(readFileSync(cliBinary, 'utf8')).toBe('CLI bytes');
      expect(storedSources(platform, cliKey)).toEqual(sources);

      storeBuild(platform, cliKey, build, { overwrite: true });
      expect(await provider.resolveBuildCache({ platform, fingerprintHash: 'cli', runOptions })).toBe(cliArtifact);
      expect(readFileSync(cliBinary, 'utf8')).toBe('replacement bytes');
      expect(storedSources(platform, cliKey)).toBeNull();
      expect(await provider.uploadBuildCache({ platform, fingerprintHash: 'absent', runOptions })).toBeNull();
    } finally {
      delete process.env.STIM_BUILD_CACHE;
      delete process.env.STIM_HOME;
      rmSync(state, { recursive: true, force: true });
    }
  },
);

test('standalone Expo cache artifacts do not cross explicit iOS schemes or the automatic key', async () => {
  const state = mkdtempSync(join(tmpdir(), 'stim-pkg-schemes-'));
  process.env.STIM_HOME = state;
  process.env.STIM_BUILD_CACHE = join(state, 'cache');
  try {
    const provider = await import('@stim-cli/expo-build-cache');
    const schemes = ['App/Stage', 'App_Stage', 'App-Stage', 'app-stage'];
    for (const [index, scheme] of schemes.entries()) {
      const app = join(state, `${index}.app`);
      mkdirSync(app);
      writeFileSync(join(app, 'identity'), scheme);
      await provider.uploadBuildCache({
        platform: 'ios',
        fingerprintHash: 'same-inputs',
        buildPath: app,
        runOptions: { scheme },
      });
    }
    const paths = new Set<string>();
    for (const scheme of schemes) {
      const app = await provider.resolveBuildCache({
        platform: 'ios',
        fingerprintHash: 'same-inputs',
        runOptions: { scheme },
      });
      assert(app);
      paths.add(app);
      expect(readFileSync(join(app, 'identity'), 'utf8')).toBe(scheme);
    }
    expect(paths.size).toBe(schemes.length);
    expect(
      await provider.resolveBuildCache({ platform: 'ios', fingerprintHash: 'same-inputs', runOptions: {} }),
    ).toBeNull();
  } finally {
    delete process.env.STIM_BUILD_CACHE;
    delete process.env.STIM_HOME;
    rmSync(state, { recursive: true, force: true });
  }
});

test('the Expo build cache provider registers itself on this Node, at the right depth', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pkg-home-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'stim-pkg-bc-'));
  process.env.STIM_HOME = home;
  process.env.STIM_BUILD_CACHE = cacheRoot;
  try {
    const provider = await import('@stim-cli/expo-build-cache');
    expect(provider.cacheRoot()).toBe(cacheRoot);

    await provider.resolveBuildCache({ platform: 'ios', fingerprintHash: 'nothing', runOptions: {} });

    const record = await waitForRegistration(cacheRoot);
    expect(record).toBeTruthy();
    assert(record);
    expect(record.entriesDepth).toBe(2);
    expect(record.prune).toBe('entries');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_BUILD_CACHE;
  }
});

test('the standalone Expo build cache provider separates Android ABIs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pkg-home-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'stim-pkg-bc-'));
  const universalApk = join(home, 'universal.apk');
  const arm64Apk = join(home, 'arm64.apk');
  process.env.STIM_HOME = home;
  process.env.STIM_BUILD_CACHE = cacheRoot;
  writeFileSync(universalApk, 'universal');
  writeFileSync(arm64Apk, 'arm64');
  try {
    const provider = await import('@stim-cli/expo-build-cache');
    await provider.uploadBuildCache({
      platform: 'android',
      fingerprintHash: 'fingerprint',
      buildPath: universalApk,
      runOptions: { variant: 'debug', allArch: true },
    });
    await provider.uploadBuildCache({
      platform: 'android',
      fingerprintHash: 'fingerprint',
      buildPath: arm64Apk,
      runOptions: { variant: 'debug', abi: 'arm64-v8a' },
    });

    const universal = await provider.resolveBuildCache({
      platform: 'android',
      fingerprintHash: 'fingerprint',
      runOptions: { variant: 'debug', allArch: true },
    });
    const arm64 = await provider.resolveBuildCache({
      platform: 'android',
      fingerprintHash: 'fingerprint',
      runOptions: { variant: 'debug', abi: 'arm64-v8a' },
    });
    assert(universal);
    assert(arm64);
    expect(universal).not.toBe(arm64);
    expect(readFileSync(universal, 'utf8')).toBe('universal');
    expect(readFileSync(arm64, 'utf8')).toBe('arm64');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_BUILD_CACHE;
  }
});

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

test('both packages resolve the same cache roots the CLI does', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pkg-home3-'));
  process.env.STIM_HOME = home;
  try {
    const provider = await import('@stim-cli/expo-build-cache');
    const metro = await import('@stim-cli/metro');

    expect(provider.cacheRoot()).toBe(sharedBuildCache());
    expect(provider.cacheRoot()).toBe(join(home, 'build-cache'));
    expect(metro.cacheRoot()).toBe(sharedMetroCache());
    expect(metro.cacheRoot('demo')).toBe(sharedMetroCache('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'metro-cache', 'demo'));

    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ caches: { buildCache: join(home, 'cfg-build'), metroCache: join(home, 'cfg-metro') } }),
    );
    expect(provider.cacheRoot()).toBe(sharedBuildCache());
    expect(provider.cacheRoot()).toBe(join(home, 'cfg-build'));
    expect(metro.cacheRoot()).toBe(join(home, 'cfg-metro'));
    expect(metro.cacheRoot('demo')).toBe(sharedMetroCache('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'cfg-metro', 'demo'));
    expect(metro.cacheRoot('@scope/app')).toBe(join(home, 'cfg-metro', '-scope-app'));

    process.env.STIM_BUILD_CACHE = join(home, 'elsewhere-build');
    process.env.STIM_METRO_CACHE = join(home, 'elsewhere-metro');
    expect(provider.cacheRoot()).toBe(sharedBuildCache());
    expect(provider.cacheRoot()).toBe(join(home, 'elsewhere-build'));
    expect(metro.cacheRoot()).toBe(join(home, 'elsewhere-metro'));
    expect(metro.cacheRoot('demo')).toBe(sharedMetroCache('demo'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'elsewhere-metro', 'demo'));

    delete process.env.STIM_BUILD_CACHE;
    delete process.env.STIM_METRO_CACHE;
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ caches: { buildCache: 'relative/nope', metroCache: 'relative/nope' } }),
    );
    expect(provider.cacheRoot()).toBe(join(home, 'build-cache'));
    expect(metro.cacheRoot()).toBe(join(home, 'metro-cache'));
    expect(metro.cacheRoot('demo')).toBe(join(home, 'metro-cache', 'demo'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_BUILD_CACHE;
    delete process.env.STIM_METRO_CACHE;
  }
});

test('both packages ignore relative overrides, so every cwd resolves the same roots', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'stim-pkg-relhome-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const cwd = process.cwd();
  const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.STIM_HOME = 'rel-home';
  process.env.STIM_BUILD_CACHE = 'rel-build';
  process.env.STIM_METRO_CACHE = 'rel-metro';
  try {
    const provider = await import('@stim-cli/expo-build-cache');
    const metro = await import('@stim-cli/metro');
    const roots = ['a', 'b'].map((name) => {
      const dir = join(fakeHome, name);
      mkdirSync(dir);
      process.chdir(dir);
      return [provider.cacheRoot(), metro.cacheRoot('demo')];
    });
    expect(roots[0]).toEqual([join(fakeHome, '.stim', 'build-cache'), join(fakeHome, '.stim', 'metro-cache', 'demo')]);
    expect(roots[1]).toEqual(roots[0]);
    const warned = emitWarning.mock.calls.map((call) => String(call[0])).join('\n');
    for (const name of ['STIM_HOME', 'STIM_BUILD_CACHE', 'STIM_METRO_CACHE']) expect(warned).toContain(name);
  } finally {
    process.chdir(cwd);
    emitWarning.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fakeHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_BUILD_CACHE;
    delete process.env.STIM_METRO_CACHE;
  }
});

test('the standalone cache provider never serves an artifact from another compiler profile', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-pkg-profile-'));
  process.env.STIM_HOME = home;
  try {
    const provider = await import('@stim-cli/expo-build-cache');
    const apk = join(home, 'app.apk');
    writeFileSync(apk, 'native build');
    await provider.uploadBuildCache({
      platform: 'android',
      fingerprintHash: 'same',
      buildPath: apk,
      runOptions: { abi: 'arm64-v8a', buildProfile: 'opt-pch' },
    });
    expect(
      await provider.resolveBuildCache({
        platform: 'android',
        fingerprintHash: 'same',
        runOptions: { abi: 'arm64-v8a' },
      }),
    ).toBeNull();
    expect(
      await provider.resolveBuildCache({
        platform: 'android',
        fingerprintHash: 'same',
        runOptions: { abi: 'arm64-v8a', buildProfile: 'opt-pch' },
      }),
    ).toBeTruthy();
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  }
});
