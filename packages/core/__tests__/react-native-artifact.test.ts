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
