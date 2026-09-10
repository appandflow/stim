import { resolveOptimizations, optimizationBuildProfile } from '../optimizations.ts';
import { buildCacheKey } from '@stim-cli/core';
import { settingShapeErrors, unknownSettingKeys } from '../settings.ts';

test('the retired cas compiler cache degrades to ccache instead of refusing', () => {
  for (const android of [
    { compilerCache: 'cas' },
    { compilerCache: 'cas', casToolchain: '/gone/toolchain.json' },
    { casToolchain: 'not-even-a-path' },
    { compilerCache: 'auto' },
    {},
  ]) {
    expect(resolveOptimizations({ optimizations: { android } }).android.compilerCache).toBe('ccache');
  }
  expect(resolveOptimizations({}).android.compilerCache).toBe('ccache');
  expect(resolveOptimizations({ optimizations: { android: { compilerCache: 'none' } } }).android.compilerCache).toBe(
    'none',
  );
});

test('a set STIM_ANDROID_CAS_TOOLCHAIN no longer reaches the resolved optimizations', () => {
  const previous = process.env.STIM_ANDROID_CAS_TOOLCHAIN;
  process.env.STIM_ANDROID_CAS_TOOLCHAIN = '/machine/toolchain.json';
  try {
    expect(resolveOptimizations({})).toEqual(resolveOptimizations({}));
    expect(resolveOptimizations({}).android).toEqual({
      compilerCache: 'ccache',
      pch: 'auto',
      gradleBuildCache: true,
      targetAbiOnly: true,
    });
  } finally {
    if (previous === undefined) delete process.env.STIM_ANDROID_CAS_TOOLCHAIN;
    else process.env.STIM_ANDROID_CAS_TOOLCHAIN = previous;
  }
});

test.each([
  { optimizations: false },
  { optimizations: { ios: null } },
  { optimizations: { buildCache: 'false' } },
  { optimizations: { android: { pch: true } } },
  { optimizations: { android: { compilerCache: 'sccache' } } },
])('invalid optimization values refuse rather than silently enabling a default: %j', (settings) => {
  expect(() => resolveOptimizations(settings)).toThrow(/Invalid/);
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
    const defaults = resolveOptimizations({});
    const changed = resolveOptimizations({
      optimizations: { ios: { swiftCompilationCache: true }, android: { pch: 'on' } },
    });
    expect(optimizationBuildProfile(platform, defaults)).toBeUndefined();
    const profile = optimizationBuildProfile(platform, changed);
    expect(buildCacheKey(platform, 'same-source', { buildProfile: profile })).not.toBe(
      buildCacheKey(platform, 'same-source', {}),
    );
    expect(
      optimizationBuildProfile(
        platform,
        resolveOptimizations({ optimizations: { remoteBuildCache: false, buildCache: false } }),
      ),
    ).toBeUndefined();
  },
);
