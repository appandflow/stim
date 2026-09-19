import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCacheKey, trimBuildCache } from './e2e-build-cache.mjs';

const roots = [];

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'stim-e2e-build-cache-'));
  roots.push(dir);
  return dir;
}

function entry(base, platform, name, ageMinutes) {
  const dir = join(base, platform, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fingerprint-sources.json'), '[]');
  const at = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(dir, at, at);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('e2e build cache trim', () => {
  it('keeps the newest entries per platform and drops older ones and staging leftovers', () => {
    const base = root();
    const newest = entry(base, 'ios', 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111-debug-sim', 0);
    const previous = entry(base, 'ios', 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222-debug-sim', 60);
    const stale = entry(base, 'ios', 'cccc3333cccc3333cccc3333cccc3333cccc3333-debug-sim', 120);
    const staging = entry(base, 'ios', 'dddd4444dddd4444dddd4444dddd4444dddd4444-debug-sim.staging-123', 0);
    const android = entry(base, 'android', 'eeee5555eeee5555eeee5555eeee5555eeee5555-debug-sim-x86-64', 0);

    const kept = trimBuildCache(base);

    expect(kept).toEqual([
      'android/eeee5555eeee5555eeee5555eeee5555eeee5555-debug-sim-x86-64',
      'ios/aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111-debug-sim',
      'ios/bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222-debug-sim',
    ]);
    expect(existsSync(newest)).toBe(true);
    expect(existsSync(previous)).toBe(true);
    expect(existsSync(android)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(staging)).toBe(false);
  });

  it('keys the kept set so an unchanged set reuses the restored entry', () => {
    const base = root();
    entry(base, 'android', 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111-debug-sim-x86-64', 0);
    entry(base, 'android', 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222-debug-sim-x86-64', 60);
    const key = buildCacheKey('stim-cli-buildcache-v2-android-bare', trimBuildCache(base));
    expect(key).toBe('stim-cli-buildcache-v2-android-bare-aaaa1111aaaa-bbbb2222bbbb');

    entry(base, 'android', 'cccc3333cccc3333cccc3333cccc3333cccc3333-debug-sim-x86-64', 0);
    expect(buildCacheKey('stim-cli-buildcache-v2-android-bare', trimBuildCache(base))).not.toBe(key);
  });

  it('returns no key for an empty or missing root', () => {
    expect(buildCacheKey('p', trimBuildCache(join(root(), 'missing')))).toBe('');
    expect(buildCacheKey('p', trimBuildCache(root()))).toBe('');
  });
});
