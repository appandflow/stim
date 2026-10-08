import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = join(import.meta.dirname, '..');
const require = createRequire(join(repositoryRoot, 'packages', 'stim-cli', 'package.json'));
const packageDirs = ['stim-cli', 'core', 'cache', 'metro', 'expo-build-cache', 'server'];

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
  ['stim', 'createStim'],
  ['@stim-cli/core', 'configDir'],
  ['@stim-cli/core/process-identity', 'captureProcessIdentity'],
  ['@stim-cli/core/ownership-claim', 'tryAcquireClaim'],
  ['@stim-cli/core/state', 'loadConfig'],
  ['@stim-cli/core/oversight', 'oversee'],
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

const apiScratch = mkdtempSync(join(tmpdir(), 'stim-runtime-api-'));
try {
  mkdirSync(join(apiScratch, 'node_modules'));
  symlinkSync(join(repositoryRoot, 'packages', 'stim-cli'), join(apiScratch, 'node_modules', 'stim'), 'junction');
  const consumer = join(apiScratch, 'consumer.mts');
  writeFileSync(
    consumer,
    `import { createStim, type StimStopResult } from 'stim';
const result: StimStopResult = await createStim({ projectRoot: '.' }).stop();
const ok: boolean = result.ok;
const status: string = result.outcomes.supervisor.status;
const summary: string = result.summary;
`,
  );
  execFileSync(
    process.execPath,
    [
      join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      'false',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--typeRoots',
      join(repositoryRoot, 'node_modules', '@types'),
      consumer,
    ],
    { cwd: repositoryRoot, stdio: 'inherit' },
  );
  const stim = require('stim').createStim({ projectRoot: apiScratch, home: join(apiScratch, 'home') });
  const diagnostics = await stim.diagnostics({ tail: 0 });
  assert.equal(diagnostics.records.length, 0, 'the API worker reads an empty workspace on the runtime floor');
  assert.ok(diagnostics.directory.startsWith(join(apiScratch, 'home')), 'the API worker uses its explicit home');
} finally {
  rmSync(apiScratch, { recursive: true, force: true });
}

const core = require('@stim-cli/core');
const importedCore = await import(pathToFileURL(require.resolve('@stim-cli/core')).href);
const identity = require('@stim-cli/core/process-identity');
const claims = await import(pathToFileURL(require.resolve('@stim-cli/core/ownership-claim')).href);
const state = require('@stim-cli/core/state');
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
  assert.equal(
    state.withConfigLock(() => core.withDirLock(join(home, 'config.lock'), () => 'shared', { waitMs: 0 })),
    'shared',
  );
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

const serverVersion = execFileSync(process.execPath, ['packages/server/dist/stim-server.mjs', '--version'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
const serverPackage = JSON.parse(readFileSync(join(repositoryRoot, 'packages', 'server', 'package.json'), 'utf8'));
assert.equal(serverVersion, serverPackage.version);

execFileSync(process.execPath, ['packages/stim-cli/dist/cli.mjs', '--help'], {
  cwd: repositoryRoot,
  stdio: 'pipe',
});

const statsHome = mkdtempSync(join(tmpdir(), 'stim-stats-runtime-'));
try {
  writeFileSync(join(statsHome, 'stats.json'), JSON.stringify({ version: 1, machine: { ios: { runs: 3, hits: 2 } } }));
  const options = { cwd: statsHome, env: { ...process.env, STIM_HOME: statsHome }, encoding: 'utf8' };
  const cli = execFileSync(
    process.execPath,
    [join(repositoryRoot, 'packages/stim-cli/dist/cli.mjs'), 'stats', '--json'],
    options,
  );
  const report = execFileSync(process.execPath, [join(repositoryRoot, 'packages/server/dist/stats-read.mjs')], options);
  assert.deepEqual(JSON.parse(report), JSON.parse(cli));
  assert.equal(JSON.parse(report).machine.ios.runs, 3);
} finally {
  rmSync(statsHome, { recursive: true, force: true });
}
