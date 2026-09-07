import { expect, it } from 'vitest';
import { launchCrashSetup } from './launch-crash-setup.mjs';

const systemImage = 'system-images;android-36;google_apis_playstore_ps16k;arm64-v8a';

it('selects Android fixture inputs and owned-device launch instructions for both arms', () => {
  for (const arm of ['stim', 'control']) {
    const setup = launchCrashSetup({ platform: 'android', arm, systemImage });
    expect(setup.ignoredPaths).toEqual([
      'node_modules',
      'android/.gradle',
      'android/.cxx',
      'android/build',
      'android/app/build',
      'android/local.properties',
    ]);
    expect(setup.deviceKind).toBe('AVD');
    expect(setup.instructions).toContain(systemImage);
    expect(setup.instructions).not.toContain('stim ios');
    expect(setup.instructions).not.toContain('simulator');
  }
  expect(launchCrashSetup({ platform: 'ios', arm: 'control' }).ignoredPaths).toEqual([
    'node_modules',
    'ios/Pods',
    'ios/build',
  ]);
});

it('refuses missing, non-arm64, or shell-injectable Android image pins', () => {
  for (const image of [
    undefined,
    systemImage.replace('arm64-v8a', 'x86_64'),
    systemImage.replace('google_apis_playstore_ps16k', "google'apis"),
  ]) {
    expect(() => launchCrashSetup({ platform: 'android', arm: 'stim', systemImage: image })).toThrow(
      'pinned arm64 system image',
    );
  }
});
