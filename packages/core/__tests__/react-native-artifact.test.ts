import { reactNativeArtifactQuery } from '../react-native-artifact.ts';

const ios = {
  project: '',
  fingerprint: 'native-inputs',
  isExpo: false,
  platform: 'ios',
  toolchain: { stimBuild: 'b1', arch: 'arm64', xcode: 'Xcode 27', simulatorSdk: '27', cocoapods: '1.16.2' },
  ios: {
    runtime: 'iOS-27-0',
    configuration: 'Debug',
    scheme: null,
    projectPath: 'ios',
    optimizations: { compilationCache: true, swiftCompilationCache: null, prefixMapping: true },
  },
};
const android = {
  project: '',
  fingerprint: 'native-inputs',
  isExpo: true,
  platform: 'android',
  toolchain: { stimBuild: 'b1', arch: 'arm64', jdk: '17' },
  android: { variant: null, abi: 'all', gradleBuildCache: true, pch: 'auto', compilerCache: 'none' },
};

test('equivalent development build choices produce the same query without depending on property order', () => {
  const normalized = reactNativeArtifactQuery(android);
  expect(normalized).toMatchObject({ android: { variant: 'debug', abi: null, gradleRoot: 'android', module: ':app' } });
  expect(
    reactNativeArtifactQuery({
      ...android,
      android: { module: ':app', gradleRoot: 'android', ...android.android, variant: 'debug', abi: null },
    }),
  ).toEqual(normalized);
  expect(reactNativeArtifactQuery({ ...android, toolchain: { ...android.toolchain, arch: 'x64' } })).toEqual(
    normalized,
  );
  expect(reactNativeArtifactQuery(ios)).toMatchObject({ ios: { optimizations: { swiftCompilationCache: false } } });
});

test('queries retain target, toolchain and native options while refusing release, missing identity and escaping project paths', () => {
  for (const different of [
    { ...ios, fingerprint: 'new-inputs' },
    { ...ios, toolchain: { ...ios.toolchain, simulatorSdk: '28' } },
    { ...ios, ios: { ...ios.ios, scheme: 'Other', projectPath: 'native-ios' } },
    { ...android, android: { ...android.android, abi: 'x86_64', pch: 'off' } },
  ])
    expect(reactNativeArtifactQuery(different)).not.toEqual(
      reactNativeArtifactQuery(different.platform === 'ios' ? ios : android),
    );
  for (const invalid of [
    { ...ios, project: '../private' },
    { ...ios, fingerprint: '' },
    { ...ios, android: android.android },
    { ...ios, toolchain: { ...ios.toolchain, stimBuild: null } },
    { ...ios, ios: { ...ios.ios, configuration: 'Release' } },
    { ...android, android: { ...android.android, variant: 'paidRelease' } },
    { ...android, android: { ...android.android, gradleRoot: '/outside' } },
    { ...android, android: { ...android.android, module: ':..:app' } },
  ])
    expect(reactNativeArtifactQuery(invalid)).toBeNull();
});

test('a query with a build compatibility version names it instead of the Stim build', () => {
  const compat = (stimBuild: string, value: unknown) =>
    reactNativeArtifactQuery({ ...ios, toolchain: { ...ios.toolchain, stimBuild, compat: value } });
  expect(compat('b1', 1)?.toolchain).toEqual({
    compat: 1,
    arch: 'arm64',
    xcode: 'Xcode 27',
    simulatorSdk: '27',
    cocoapods: '1.16.2',
  });
  expect(compat('b2', 1)).toEqual(compat('b1', 1));
  expect(compat('b1', 2)).not.toEqual(compat('b1', 1));
  expect(reactNativeArtifactQuery(ios)?.toolchain).toMatchObject({ stimBuild: 'b1' });
  for (const invalid of [0, 1.5, '1']) expect(compat('b1', invalid)).toBeNull();
});
