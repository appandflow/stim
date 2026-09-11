import { compilerCacheFallbackMessage, resolveOptimizations, optimizationBuildProfile } from '../optimizations.ts';
import { buildCacheKey } from '@stim-cli/core';
import { settingShapeErrors, unknownSettingKeys } from '../settings.ts';
import assert from 'node:assert';

test('explicit compiler selection can opt out of an inherited CAS manifest', () => {
  const env = { STIM_ANDROID_CAS_TOOLCHAIN: '/machine/toolchain.json' };
  expect(resolveOptimizations({}, env).android.compilerCache).toBe('cas');
  for (const compilerCache of ['none', 'ccache']) {
    expect(resolveOptimizations({ optimizations: { android: { compilerCache } } }, env).android.compilerCache).toBe(
      compilerCache,
    );
  }
  expect(
    resolveOptimizations({ optimizations: { android: { casToolchain: '/config/toolchain.json' } } }, env).android
      .casToolchain,
  ).toBe('/machine/toolchain.json');
});

test.each([
  { optimizations: false },
  { optimizations: { ios: null } },
  { optimizations: { buildCache: 'false' } },
  { optimizations: { android: { pch: true } } },
  { optimizations: { android: { compilerCache: 'sccache' } } },
])('invalid optimization values refuse rather than silently enabling a default: %j', (settings) => {
  expect(() => resolveOptimizations(settings, {})).toThrow(/Invalid|requires/);
});

test('a CAS selection with no toolchain degrades to ccache instead of refusing the build', () => {
  const options = resolveOptimizations({ optimizations: { android: { compilerCache: 'cas' } } }, {});
  expect(options.android.compilerCache).toBe('ccache');
  expect(options.android.casToolchain).toBeNull();
  const fallback = options.android.compilerCacheFallback;
  assert(fallback);
  expect(fallback.key).toBe('optimizations.android.compilerCache');
  expect(compilerCacheFallbackMessage({ fallback, compilerCache: 'ccache', file: '/home/.stim/config.json' })).toBe(
    'optimizations.android.compilerCache in /home/.stim/config.json is "cas", but no ' +
      'optimizations.android.casToolchain or STIM_ANDROID_CAS_TOOLCHAIN names the toolchain manifest. ' +
      'Android builds fall back to ccache when it is available.',
  );
});

test('a toolchain path that is not absolute degrades without claiming a cache the build will not run', () => {
  const relative = { android: { compilerCache: 'none', casToolchain: 'relative.json' } };
  const options = resolveOptimizations({ optimizations: relative }, {});
  expect(options.android.compilerCache).toBe('none');
  const fallback = options.android.compilerCacheFallback;
  assert(fallback);
  expect(fallback.key).toBe('optimizations.android.casToolchain');
  expect(compilerCacheFallbackMessage({ fallback, compilerCache: 'none', file: '/home/.stim/config.json' })).toBe(
    'optimizations.android.casToolchain in /home/.stim/config.json is "relative.json", which is not an absolute ' +
      'path to a toolchain JSON manifest. Android builds use no compiler cache, because ' +
      'optimizations.android.compilerCache is "none".',
  );
});

test('an unusable toolchain in the environment is named as the environment, not as a config key', () => {
  const options = resolveOptimizations({}, { STIM_ANDROID_CAS_TOOLCHAIN: 'relative.json' });
  expect(options.android.compilerCache).toBe('ccache');
  const fallback = options.android.compilerCacheFallback;
  assert(fallback);
  expect(compilerCacheFallbackMessage({ fallback, compilerCache: 'ccache', file: '/home/.stim/config.json' })).toBe(
    'STIM_ANDROID_CAS_TOOLCHAIN in the environment is "relative.json", which is not an absolute path to a ' +
      'toolchain JSON manifest. Android builds fall back to ccache when it is available.',
  );
});

test.each([null, 5, true, {}, []])(
  'a casToolchain of %j degrades in every compiler cache state and never refuses a build',
  (casToolchain) => {
    for (const compilerCache of ['auto', 'ccache', 'cas', 'none'] as const) {
      const settings = { optimizations: { android: { compilerCache, casToolchain } } };
      expect(settingShapeErrors(settings)).toEqual([]);
      const options = resolveOptimizations(settings, {});
      expect(options.android.compilerCache).toBe(compilerCache === 'none' ? 'none' : 'ccache');
      expect(options.android.casToolchain).toBeNull();
      const fallback = options.android.compilerCacheFallback;
      assert(fallback);
      expect(fallback).toMatchObject({ key: 'optimizations.android.casToolchain', fromEnvironment: false });
      expect(
        compilerCacheFallbackMessage({
          fallback,
          compilerCache: options.android.compilerCache === 'none' ? 'none' : 'ccache',
          file: '/home/.stim/config.json',
        }),
      ).toContain(
        `optimizations.android.casToolchain in /home/.stim/config.json is ${JSON.stringify(casToolchain)}, which is ` +
          'not an absolute path to a toolchain JSON manifest.',
      );
    }
  },
);

test('a toolchain that exists keeps CAS selected and reports no fallback', () => {
  const options = resolveOptimizations(
    { optimizations: { android: { compilerCache: 'cas', casToolchain: '/machine/toolchain.json' } } },
    {},
  );
  expect(options.android.compilerCache).toBe('cas');
  expect(options.android.compilerCacheFallback).toBeNull();
});

test('nested optimization settings are validated and misspelled names are reported', () => {
  const settings = {
    optimizations: {
      android: { pch: 'on', gradleBuildCache: false, gradleCache: false },
      ios: { compilationCache: 'false' },
    },
  };
  expect(unknownSettingKeys(settings)).toEqual(['optimizations.android.gradleCache']);
  expect(settingShapeErrors(settings)).toEqual([
    'Invalid optimizations.ios.compilationCache setting "false". Expected true or false.',
  ]);
});

test.each(['ios', 'android'] as const)(
  'compiler changes separate %s artifacts without discarding default cache keys',
  (platform) => {
    const defaults = resolveOptimizations({}, {});
    const changed = resolveOptimizations(
      { optimizations: { ios: { swiftCompilationCache: true }, android: { pch: 'on' } } },
      {},
    );
    expect(optimizationBuildProfile(platform, defaults)).toBeUndefined();
    const profile = optimizationBuildProfile(platform, changed);
    expect(buildCacheKey(platform, 'same-source', { buildProfile: profile })).not.toBe(
      buildCacheKey(platform, 'same-source', {}),
    );
    expect(
      optimizationBuildProfile(
        platform,
        resolveOptimizations({ optimizations: { remoteBuildCache: false, buildCache: false } }, {}),
      ),
    ).toBeUndefined();
  },
);
