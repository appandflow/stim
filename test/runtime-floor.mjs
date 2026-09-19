import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = join(import.meta.dirname, '..');
const require = createRequire(join(repositoryRoot, 'packages', 'stim-cli', 'package.json'));
const packageDirs = ['stim-cli', 'core', 'cache', 'metro', 'expo-build-cache'];

for (const directory of packageDirs) {
  const root = join(repositoryRoot, 'packages', directory);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module', `${pkg.name} must declare ESM`);
  assert.equal(pkg.engines.node, '>=22.12.0', `${pkg.name} must declare the runtime range`);

  const distFiles = readdirSync(join(root, 'dist'));
  assert.equal(
    distFiles.some((file) => file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.cts')),
    false,
    `${pkg.name} dist must contain only ESM JavaScript and ESM declarations`,
  );
}

const entrypoints = [
  ['@stim-cli/core', 'configDir'],
  ['@stim-cli/core/process-identity', 'captureProcessIdentity'],
  ['@stim-cli/core/ownership-claim', 'tryAcquireClaim'],
  ['@stim-cli/cache', 'loadCacheProvider'],
  ['@stim-cli/expo-build-cache', 'cacheRoot'],
  ['@stim-cli/metro', 'sharedCacheStores'],
  ['stim/cache-manifest', 'readManifest'],
];

for (const [specifier, exportName] of entrypoints) {
  assert.equal(typeof require(specifier)[exportName], 'function', `require(${specifier}) must load ESM synchronously`);
  const resolved = pathToFileURL(require.resolve(specifier)).href;
  assert.equal(typeof (await import(resolved))[exportName], 'function', `import(${specifier}) must load ESM`);
}

const core = require('@stim-cli/core');
const importedCore = await import(pathToFileURL(require.resolve('@stim-cli/core')).href);
const identity = require('@stim-cli/core/process-identity');
const claims = await import(pathToFileURL(require.resolve('@stim-cli/core/ownership-claim')).href);
const previousHome = process.env.STIM_HOME;
const home = mkdtempSync(join(tmpdir(), 'stim-runtime-lock-'));
process.env.STIM_HOME = home;
try {
  const captured = identity.captureProcessIdentity(process.pid);
  assert.equal(captured.ok, true, `process identity must work: ${captured.reason}`);
  assert.equal(identity.inspectProcessIdentity({ pid: process.pid, processToken: captured.token }), 'same');
  const lock = join(home, 'runtime.lock');
  assert.equal(
    core.withDirLock(lock, () => {
      assert.equal(claims.readClaimSet(`${lock}.claims`).live[0].owner.pid, process.pid);
      return importedCore.withDirLock(lock, () => 'nested', { waitMs: 0 });
    }),
    'nested',
  );
  assert.equal(existsSync(lock), false);
} finally {
  if (previousHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
}

const version = execFileSync(process.execPath, ['packages/stim-cli/dist/cli.mjs', '--version'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
const cliPackage = JSON.parse(readFileSync(join(repositoryRoot, 'packages', 'stim-cli', 'package.json'), 'utf8'));
assert.equal(version, cliPackage.version);

execFileSync(process.execPath, ['packages/stim-cli/dist/cli.mjs', '--help'], {
  cwd: repositoryRoot,
  stdio: 'pipe',
});
