import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkFingerprint, selectBenchmarkCacheKey } from './cache-key.mjs';

it('hashes native inputs with the pinned CLI dependency despite a conflicting fixture fingerprint package', () => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark fingerprint '));
  const stimPackage = fileURLToPath(new URL('../../packages/stim-cli/', import.meta.url));
  const previousStimHome = process.env.STIM_HOME;
  process.env.STIM_HOME = join(root, 'stim-home');
  try {
    mkdirSync(join(root, 'android'));
    mkdirSync(join(root, 'ios'));
    mkdirSync(join(root, 'node_modules/@expo/fingerprint'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fingerprint-fixture', version: '1.0.0' }));
    writeFileSync(
      join(root, 'node_modules/@expo/fingerprint/package.json'),
      JSON.stringify({ name: '@expo/fingerprint', main: 'index.js' }),
    );
    writeFileSync(
      join(root, 'node_modules/@expo/fingerprint/index.js'),
      'throw new Error("Fixture fingerprint must not be loaded");',
    );
    writeFileSync(join(root, 'android/build.gradle'), 'version = "one"');
    writeFileSync(join(root, 'ios/native.m'), 'one');
    const initial = benchmarkFingerprint(root, stimPackage, 'android');
    expect(initial).toMatch(/^[a-f0-9]{40}$/);
    writeFileSync(join(root, 'android/local.properties'), 'sdk.dir=/machine-specific-sdk');
    writeFileSync(join(root, 'ios/native.m'), 'two');
    expect(benchmarkFingerprint(root, stimPackage, 'android')).toBe(initial);
    writeFileSync(join(root, 'android/build.gradle'), 'version = "two"');
    expect(benchmarkFingerprint(root, stimPackage, 'android')).not.toBe(initial);
  } finally {
    if (previousStimHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousStimHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

describe('benchmark cache key selection', () => {
  it('selects the exact iOS simulator key', () => {
    expect(selectBenchmarkCacheKey('ios', 'abc', ['abc-debug-sim', 'abc-debug-sim-arm64-v8a'])).toBe('abc-debug-sim');
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
