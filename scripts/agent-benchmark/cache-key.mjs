import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function benchmarkFingerprint(projectRoot, stimPackage, platform) {
  const output = execFileSync(process.execPath, [join(stimPackage, 'dist', 'cli.mjs'), platform, '--plan', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 2 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(output);
  if (typeof result.fingerprint !== 'string' || !result.fingerprint)
    throw new Error('installed stim did not return a fingerprint in its build plan');
  return result.fingerprint;
}

export function selectBenchmarkCacheKey(platform, fingerprint, entries) {
  const base = `${fingerprint}-debug-sim`;
  const matches =
    platform === 'android'
      ? entries.filter((entry) => entry.startsWith(`${base}-`))
      : entries.filter((entry) => entry === base || entry === `${base}-arm64` || entry === `${base}-x86_64`);
  if (matches.length !== 1) {
    throw new Error(`expected one ${platform} benchmark cache key for ${base}, got ${JSON.stringify(matches)}`);
  }
  return matches[0];
}
