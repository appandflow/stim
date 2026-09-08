import { expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchCrashSetup } from './launch-crash-setup.mjs';

const systemImage = 'system-images;android-36;google_apis_playstore_ps16k;arm64-v8a';

it('selects Android fixture inputs and owned-device launch instructions for both arms', () => {
  for (const arm of ['stim', 'control']) {
    const setup = launchCrashSetup({ platform: 'android', arm, systemImage });
    expect(setup.deviceKind).toBe('AVD');
    expect(setup.instructions).toContain(systemImage);
    expect(setup.instructions).not.toContain('stim ios');
    expect(setup.instructions).not.toContain('simulator');
  }
  expect(launchCrashSetup({ platform: 'android', arm: 'control', systemImage }).instructions).toContain(
    'inherited ANDROID_AVD_HOME',
  );
  expect(launchCrashSetup({ platform: 'ios', arm: 'control' }).ignoredPaths).toEqual([
    'node_modules',
    'ios/Pods',
    'ios/build',
  ]);
});

it.each(['ios', 'android'])('keeps managed control servers alive through %s proof', (platform) => {
  const { instructions } = launchCrashSetup({ platform, arm: 'control', systemImage });
  expect(instructions).toContain('runner-managed shell sessions');
  expect(instructions).toContain('wait for readiness instead of waiting for exit or stopping it');
  expect(instructions).not.toContain('Do not use a long-running foreground shell command');
  expect(instructions).toContain('explicit error-capture command completes');
});

it('carries reusable Android outputs without importing a sibling autolinking cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-android-carry-'));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const paths = [
    'node_modules/native-lib/package.json',
    'android/.gradle/cache.bin',
    'android/.cxx/config.bin',
    'android/app/build/outputs/apk/debug/app-debug.apk',
    'android/local.properties',
    'android/build/generated/autolinking/autolinking.json',
    'android/build/generated/autolinking/package.json.sha',
  ];
  try {
    for (const path of paths) {
      mkdirSync(dirname(join(source, path)), { recursive: true });
      writeFileSync(join(source, path), 'source checkout bytes');
    }
    for (const path of launchCrashSetup({ platform: 'android', arm: 'control', systemImage }).ignoredPaths) {
      mkdirSync(dirname(join(target, path)), { recursive: true });
      cpSync(join(source, path), join(target, path), { recursive: true });
    }
    for (const path of paths.slice(0, 5)) {
      expect(readFileSync(join(target, path), 'utf8')).toBe('source checkout bytes');
    }
    for (const path of paths.slice(5)) {
      expect(existsSync(join(target, path))).toBe(false);
      expect(readFileSync(join(source, path), 'utf8')).toBe('source checkout bytes');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
