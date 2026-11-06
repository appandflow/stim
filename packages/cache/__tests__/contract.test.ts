import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runCacheProviderContract } from '../contract.ts';
import type { CacheProvider } from '../provider.ts';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'stim-cache-contract-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function memoryProvider(): CacheProvider {
  const builds = new Map<string, string>();
  return {
    builds: {
      resolve: ({ key, destinationDir }) => {
        const source = builds.get(key);
        if (!source) return null;
        const target = join(destinationDir, basename(source));
        cpSync(source, target, { recursive: true });
        return target;
      },
      store: ({ key, sourcePath, overwrite }) => {
        if (builds.has(key) && !overwrite) return;
        const kept = join(workDir, `kept-${key}`);
        mkdirSync(kept, { recursive: true });
        const target = join(kept, basename(sourcePath));
        cpSync(sourcePath, target, { recursive: true });
        builds.set(key, target);
      },
    },
  };
}

test('the contract covers an iOS artifact directory', async () => {
  const results = await runCacheProviderContract({
    provider: memoryProvider(),
    projectRoot: workDir,
    workDir,
    platform: 'ios',
  });

  expect(results.filter((result) => !result.passed)).toEqual([]);
});
