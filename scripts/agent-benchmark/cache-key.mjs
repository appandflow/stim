import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function benchmarkFingerprint(projectRoot, stimPackage, platform) {
  const script = [
    'import { createRequire } from "node:module";',
    'const fingerprint = createRequire(process.argv[1])("@expo/fingerprint");',
    'const result = await fingerprint.createFingerprintAsync(process.cwd(), {',
    '  platforms: [process.argv[2]],',
    '  silent: true,',
    '  ignorePaths: ["**/android/local.properties", "**/android/.idea/**"],',
    '});',
    'process.stdout.write(result.hash);',
  ].join('\n');
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script, join(stimPackage, 'package.json'), platform],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 2 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

export function selectBenchmarkCacheKey(platform, fingerprint, entries) {
  const base = `${fingerprint}-debug-sim`;
  const matches =
    platform === 'android'
      ? entries.filter((entry) => entry.startsWith(`${base}-`))
      : entries.filter((entry) => entry === base);
  if (matches.length !== 1) {
    throw new Error(`expected one ${platform} benchmark cache key for ${base}, got ${JSON.stringify(matches)}`);
  }
  return matches[0];
}
