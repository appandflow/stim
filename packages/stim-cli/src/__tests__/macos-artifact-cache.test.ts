import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as providers from '@stim-cli/cache';
import { swiftpmArtifactCache } from '../macos/artifact-cache.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';
import { testContext } from './_context.ts';
import { runReport } from '../report-runtime.ts';
import { packMacosArtifact } from '../macos/artifact-file.ts';
import { registeredCaches } from '../cache/cache-manifest.ts';

let root: string;
const settings = { macos: { artifactInputs: { complete: true } } };
const recipe = { product: 'App', bundleId: 'dev.proof', validateFetched: async () => {} };
const build = { product: 'App', infoPlist: 'Info.plist', resources: {}, assetCatalog: null };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-macos-provider-'));
  process.env.STIM_HOME = join(root, 'home');
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ cache: { provider: './provider.mjs' } }));
  writeFileSync(join(root, 'Package.swift'), 'pinned package');
  writeFileSync(join(root, 'Info.plist'), 'original plist');
  setExecutor(
    makeExecutor({
      runFile: (file, args) => {
        if (file === 'git') {
          if (args?.includes('ls-files')) return 'Package.swift\0Info.plist\0.stim.json\0';
          return args?.includes('--git-common-dir') ? join(root, '.git') : root;
        }
        if (file === 'swift') return 'Swift 6.3';
        if (file === 'xcodebuild') return 'Xcode 27';
        if (file === 'xcrun') {
          if (args?.[0] === 'lipo') return process.arch === 'x64' ? 'x86_64' : process.arch;
          if (args?.[0] === 'vtool') return 'platform MACOS';
          return '27A266';
        }
        if (file === 'plutil' || file === 'codesign') return '';
        throw new Error(`Unexpected command ${file}`);
      },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

test('disabling remote artifact caching keeps local reuse and disables peer inventory', () => {
  const cache = swiftpmArtifactCache(
    testContext(),
    root,
    { ...settings, optimizations: { remoteBuildCache: false } },
    recipe,
    build,
  );
  expect(cache).toBeDefined();
  expect(cache?.peer?.()).toBeNull();
});

test.skipIf(process.platform === 'win32')('a provider hit becomes a managed reusable local cache entry', async () => {
  const bundle = join(root, 'Built.app');
  mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(bundle, 'Contents/Info.plist'), 'built plist');
  writeFileSync(join(bundle, 'Contents/MacOS/App'), 'compiled bytes');
  chmodSync(join(bundle, 'Contents/MacOS/App'), 0o755);
  const archive = join(root, 'provider.cache');
  await packMacosArtifact(bundle, 'key', archive, new AbortController().signal);
  vi.spyOn(providers, 'loadCacheProvider').mockResolvedValue({
    provider: {
      files: {
        async resolve({ destinationDir }) {
          const path = join(destinationDir, 'download.cache');
          copyFileSync(archive, path);
          return path;
        },
        async store() {},
      },
    },
  });
  const cache = swiftpmArtifactCache(testContext(), root, settings, recipe, build);
  assert(cache);
  expect((await cache.restore('key', join(root, 'first')))?.tier).toBe('provider');
  expect(registeredCaches()).toContainEqual(
    expect.objectContaining({ dir: join(root, 'home/build-cache'), prune: 'entries', entriesDepth: 2 }),
  );
  expect((await cache.restore('key', join(root, 'second')))?.tier).toBe('local');
});

describe.skipIf(process.platform === 'win32')('local cache ownership', () => {
  test.each(['restore', 'has'] as const)(
    'local validation cleanup refusal preserves the bundle during %s',
    async (operation) => {
      const lookup = vi.fn<providers.FileCacheCapability['resolve']>().mockResolvedValue(null);
      vi.spyOn(providers, 'loadCacheProvider').mockResolvedValue({
        provider: { files: { resolve: lookup, store: async () => {} } },
      });
      const refusal = Object.assign(new Error('Native validation child cleanup is unresolved'), {
        code: 'STIM_CLAIM_UNAVAILABLE',
        reportCleanup: true,
      });
      let refuse = false;
      let retainedBundle = '';
      const cache = swiftpmArtifactCache(
        testContext(),
        root,
        settings,
        {
          ...recipe,
          validateFetched: async (bundle) => {
            if (refuse) {
              retainedBundle = bundle;
              throw refusal;
            }
          },
        },
        build,
      );
      assert(cache);
      const identity = await cache.identity();
      const bundle = join(root, 'Built.app');
      mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
      writeFileSync(join(bundle, 'Contents/Info.plist'), 'built plist');
      writeFileSync(join(bundle, 'Contents/MacOS/App'), 'compiled bytes');
      chmodSync(join(bundle, 'Contents/MacOS/App'), 0o755);
      const staging = join(root, 'store');
      mkdirSync(staging);
      await cache.store(identity.key, bundle, staging);
      refuse = true;
      try {
        await expect(
          operation === 'has' ? cache.has(identity.key) : cache.restore(identity.key, join(root, 'restore')),
        ).rejects.toBe(refusal);
        expect(existsSync(join(retainedBundle, 'Contents/MacOS/App'))).toBe(true);
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        if (operation === 'has' && retainedBundle) rmSync(dirname(retainedBundle), { recursive: true, force: true });
      }
    },
  );
});

test.each(['timeout', 'cancellation'])('a provider that ignores %s refuses within one cleanup budget', async (mode) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(providers, 'loadCacheProvider').mockResolvedValue({
    provider: {
      files: {
        resolve: () => {
          started();
          return new Promise<null>(() => {});
        },
        store: async () => {},
      },
    },
  });
  const controller = new AbortController();
  const context = testContext({
    signal: controller.signal,
    env: {
      ...process.env,
      STIM_CACHE_BUILD_RESOLVE_TIMEOUT_MS: mode === 'timeout' ? '10' : '60000',
    },
  });
  const destination = join(root, 'retained');
  let lookupSettled = false;
  const result = runReport(
    context,
    async (operation) => {
      const cache = swiftpmArtifactCache(operation, root, settings, recipe, build);
      assert(cache);
      try {
        return await cache.restore('key', destination);
      } finally {
        lookupSettled = true;
      }
    },
    120_000,
  ).catch((error: unknown) => error);
  try {
    await entered;
    if (mode === 'cancellation') controller.abort(new Error('cancelled'));
    else await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await result).toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
      message: expect.stringContaining(destination),
    });
    expect(existsSync(destination)).toBe(true);
    expect(lookupSettled).toBe(true);
  } finally {
    vi.clearAllTimers();
  }
});

test.skipIf(process.platform === 'win32')(
  'source changes during cache packing prevent local and shared publication',
  async () => {
    const upload = vi.fn<providers.FileCacheCapability['store']>().mockResolvedValue(undefined);
    vi.spyOn(providers, 'loadCacheProvider').mockResolvedValue({
      provider: {
        files: {
          resolve: async () => null,
          store: upload,
        },
      },
    });
    const cache = swiftpmArtifactCache(
      testContext(),
      root,
      settings,
      {
        ...recipe,
        validateFetched: async () => {
          writeFileSync(join(root, 'Info.plist'), 'changed during packing');
        },
      },
      build,
    );
    assert(cache);
    const identity = await cache.identity();
    const bundle = join(root, 'Built.app');
    mkdirSync(join(bundle, 'Contents/MacOS'), { recursive: true });
    writeFileSync(join(bundle, 'Contents/Info.plist'), 'built plist');
    writeFileSync(join(bundle, 'Contents/MacOS/App'), 'compiled bytes');
    chmodSync(join(bundle, 'Contents/MacOS/App'), 0o755);
    const staging = join(root, 'cache-store');
    mkdirSync(staging);
    await expect(cache.store(identity.key, bundle, staging)).rejects.toThrow('inputs changed');
    expect(upload).not.toHaveBeenCalled();
    expect(await cache.restore(identity.key, join(root, 'cache-read'))).toBeNull();
  },
);

test('a provider cannot return a file outside its download directory', async () => {
  const outside = join(root, 'outside');
  writeFileSync(outside, 'untrusted');
  vi.spyOn(providers, 'loadCacheProvider').mockResolvedValue({
    provider: {
      files: {
        resolve: async () => outside,
        store: async () => {},
      },
    },
  });
  const cache = swiftpmArtifactCache(testContext(), root, settings, recipe, build);
  assert(cache);
  const destination = join(root, 'download');
  mkdirSync(destination);
  await expect(cache.restore('key', destination)).rejects.toThrow('outside its download directory');
});
