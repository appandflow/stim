import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installServer } from '@stim-cli/server/release-install';
import { fetchTree } from '../engine-store/tree.ts';

vi.mock('@stim-cli/server/release-install', () => ({ installServer: vi.fn<typeof installServer>() }));

let root: string;
let cache: string;
let dir: string;
const audit =
  "npm audit signatures failed: Invalid response body while trying to fetch https://registry.npmjs.org/-/npm/v1/attestations/which@5.0.0: ENOENT: no such file or directory, stat '***/.npm-cache/_cacache/content-v2/sha512/ae/94/34c1'. This is related to npm not being able to find a file.. Not switching to it.";
const packument =
  "npm install failed:\nnpm error enoent Invalid response body while trying to fetch https://registry.npmjs.org/stim: ENOENT: no such file or directory, stat '***\\.npm-cache\\_cacache\\content-v2\\sha512\\97\\6e\\5e62'";
const invalid = 'npm audit signatures failed: 1 package has an invalid registry signature. Not switching to it.';

beforeEach(() => {
  vi.mocked(installServer).mockReset();
  root = mkdtempSync(join(tmpdir(), "stim-engine-fetch-'"));
  cache = join(root, '.npm-cache');
  dir = join(root, 'installed');
  mkdirSync(cache);
  writeFileSync(join(cache, 'marker'), 'cache');
  mkdirSync(join(dir, 'node_modules', 'stim'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'stim', 'package.json'), 'result');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test.each([audit, packument])('retries a missing npm cache file: %s', async (message) => {
  vi.mocked(installServer)
    .mockRejectedValueOnce(new Error(message))
    .mockResolvedValueOnce({ dir, script: '', build: { version: '1.0.0', stimBuild: null } });
  const scratch = join(root, 'tree');
  const log = vi.fn<(line: string) => void>();
  await fetchTree(root, { from: 'packs' }, scratch, log);
  expect(existsSync(cache)).toBe(false);
  expect(installServer).toHaveBeenCalledTimes(2);
  expect(vi.mocked(installServer).mock.calls[1]).toEqual(vi.mocked(installServer).mock.calls[0]);
  expect(readFileSync(join(scratch, 'package.json'), 'utf8')).toBe('result');
  expect(log).toHaveBeenCalledTimes(1);
});

test('leaves unrelated signature failures and the cache unchanged', async () => {
  const error = new Error(invalid);
  vi.mocked(installServer).mockRejectedValueOnce(error);
  await expect(fetchTree(root, { release: '1.0.0' }, join(root, 'tree'), vi.fn())).rejects.toBe(error);
  expect(installServer).toHaveBeenCalledTimes(1);
  expect(existsSync(join(cache, 'marker'))).toBe(true);
});

test('adds a quoted cache removal remedy after a second missing file', async () => {
  vi.mocked(installServer).mockRejectedValue(new Error(audit));
  await expect(fetchTree(root, { release: '1.0.0' }, join(root, 'tree'), vi.fn())).rejects.toThrow(
    audit +
      "\nRemove the engine npm cache with rm -rf '" +
      cache.replaceAll("'", "'\\''") +
      "' and run the same command again.",
  );
  expect(installServer).toHaveBeenCalledTimes(2);
});

test('keeps an unrelated second failure unchanged', async () => {
  const error = new Error(invalid);
  vi.mocked(installServer).mockRejectedValueOnce(new Error(audit)).mockRejectedValueOnce(error);
  await expect(fetchTree(root, { release: '1.0.0' }, join(root, 'tree'), vi.fn())).rejects.toBe(error);
  expect(installServer).toHaveBeenCalledTimes(2);
});
