import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkFingerprint, selectBenchmarkCacheKey } from './cache-key.mjs';

it.skipIf(process.platform === 'win32')(
  'gets a stable key from the built CLI and changes it when native input changes',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'benchmark fingerprint '));
    const stimPackage = fileURLToPath(new URL('../../packages/stim-cli/', import.meta.url));
    const modules = fileURLToPath(new URL('../../apps/mobile/node_modules', import.meta.url));
    const previous = Object.fromEntries(
      ['STIM_HOME', 'STIM_ENGINE_ROOT', 'ANDROID_HOME', 'ANDROID_AVD_HOME'].map((name) => [name, process.env[name]]),
    );
    const home = join(root, 'stim-home');
    const sdk = join(root, 'sdk');
    process.env.STIM_HOME = home;
    process.env.STIM_ENGINE_ROOT = join(root, 'engine');
    process.env.ANDROID_HOME = sdk;
    process.env.ANDROID_AVD_HOME = join(root, 'avds');
    try {
      mkdirSync(home);
      writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { mode: 'off' } }));
      const cli = join(stimPackage, 'dist', 'cli.mjs');
      for (const setting of ['iosSimulatorApp', 'androidEmulatorApp'])
        execFileSync(process.execPath, [cli, 'settings', 'set', setting, 'stim-desktop'], { cwd: root });
      const arch = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
      mkdirSync(join(sdk, 'system-images/android-35/google_apis', arch), { recursive: true });
      mkdirSync(join(root, 'android/app/src/main'), { recursive: true });
      mkdirSync(join(root, 'ios'));
      symlinkSync(modules, join(root, 'node_modules'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'fingerprint-fixture',
          version: '1.0.0',
          dependencies: { expo: '*', 'react-native': '*' },
        }),
      );
      writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { name: 'Fixture', slug: 'fixture' } }));
      writeFileSync(
        join(root, 'android/settings.gradle'),
        "rootProject.name = 'Fixture'\ninclude ':app'\nex.autolinkLibrariesFromCommand(expoAutolinking.rnConfigCommand)\n",
      );
      writeFileSync(
        join(root, 'android/app/build.gradle'),
        'android { namespace "dev.stim.fixture" }\nversion = "one"',
      );
      writeFileSync(join(root, 'android/app/src/main/AndroidManifest.xml'), '<manifest package="dev.stim.fixture" />');
      writeFileSync(join(root, 'ios/native.m'), 'one');
      execFileSync('git', ['init', '--quiet', root]);
      execFileSync('git', ['-C', root, 'add', 'android', 'ios']);
      const initial = benchmarkFingerprint(root, stimPackage, 'android');
      expect(initial).toBeTruthy();
      writeFileSync(join(root, 'android/local.properties'), 'sdk.dir=/machine-specific-sdk');
      writeFileSync(join(root, 'ios/native.m'), 'two');
      expect(benchmarkFingerprint(root, stimPackage, 'android')).toBe(initial);
      writeFileSync(
        join(root, 'android/app/build.gradle'),
        'android { namespace "dev.stim.fixture" }\nversion = "two"',
      );
      expect(benchmarkFingerprint(root, stimPackage, 'android')).not.toBe(initial);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

describe('benchmark cache key selection', () => {
  it('selects the exact iOS simulator key', () => {
    expect(selectBenchmarkCacheKey('ios', 'abc', ['abc-debug-sim', 'abc-debug-sim-arm64-v8a'])).toBe('abc-debug-sim');
  });

  it('selects a current architecture-scoped iOS key and refuses ambiguous artifacts', () => {
    expect(selectBenchmarkCacheKey('ios', 'abc', ['abc-debug-sim-arm64'])).toBe('abc-debug-sim-arm64');
    expect(() => selectBenchmarkCacheKey('ios', 'abc', ['abc-debug-sim-arm64', 'abc-debug-sim-x86_64'])).toThrow(
      /arm64.*x86_64/,
    );
    expect(() => selectBenchmarkCacheKey('ios', 'abc', ['abc-debug-sim', 'abc-debug-sim-arm64'])).toThrow(/got/);
  });

  it('selects the ABI-scoped Android simulator key', () => {
    expect(selectBenchmarkCacheKey('android', 'abc', ['abc-debug-sim-arm64-v8a'])).toBe('abc-debug-sim-arm64-v8a');
  });

  it('rejects missing or ambiguous Android keys', () => {
    expect(() => selectBenchmarkCacheKey('android', 'abc', [])).toThrow(/got \[\]/);
    expect(() =>
      selectBenchmarkCacheKey('android', 'abc', ['abc-debug-sim-arm64-v8a', 'abc-debug-sim-x86_64']),
    ).toThrow(/arm64-v8a.*x86_64/);
  });
});
