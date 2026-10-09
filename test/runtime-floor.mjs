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
const packageDirs = ['stim-cli', 'core', 'cache', 'metro', 'expo-build-cache', 'ci', 'server'];

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
    `import { createStim, type StimPlatform, type StimRunOptions, type StimRunResult, type StimStopResult } from 'stim';
const stim = createStim({ projectRoot: '.' });
const ios = await stim.run({ platform: 'ios', scheme: 'App' });
const udid: string = ios.facts.udid;
const iosPlatform: 'ios' = ios.platform;
const android = await stim.run({ platform: 'android', variant: 'debug' });
const serial: string | null = android.facts.serial;
const androidPlatform: 'android' = android.platform;
const macos = await stim.run({ platform: 'macos' });
const executable: string = macos.facts.executable;
const macosPlatform: 'macos' = macos.platform;
const web = await stim.run({ platform: 'web', headed: true });
const webPlatform: 'web' = web.platform;
const reused: boolean = web.facts.reused;
declare const platform: 'ios' | 'android';
const native = await stim.run({ platform });
const nativePlatform: 'ios' | 'android' = native.platform;
if (native.platform === 'ios') {
  const nativeUdid: string = native.facts.udid;
} else {
  const nativeSerial: string | null = native.facts.serial;
}
declare const options: StimRunOptions;
const dynamic: StimRunResult = await stim.run(options);
function runPlatform<P extends StimPlatform>(platform: P) {
  return stim.run({ platform });
}
const generic: StimRunResult = await runPlatform('ios');
const builtIos = await stim.build({ platform: 'ios', scheme: 'App', arch: 'arm64' });
const appPath: string = builtIos.facts.appPath;
const builtIosPlatform: 'ios' = builtIos.platform;
const builtAndroid = await stim.build({ platform: 'android', variant: 'debug', abi: 'x86_64' });
const apkPath: string = builtAndroid.facts.apkPath;
const builtMacos = await stim.build({ platform: 'macos' });
const macosBundle: string = builtMacos.facts.bundle;
const builtNative = await stim.build({ platform });
if (builtNative.platform === 'ios') {
  const path: string = builtNative.facts.appPath;
} else {
  const path: string = builtNative.facts.apkPath;
}
const result: StimStopResult = await stim.stop();
const ok: boolean = result.ok;
const status: string = result.outcomes.supervisor.status;
const summary: string = result.summary;
`,
  );
  const compilerArgs = [
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
  ];
  execFileSync(process.execPath, compilerArgs, { cwd: repositoryRoot, stdio: 'inherit' });
  for (const [source, rejectedProperty] of [
    ["await stim.run({ platform: 'ios', variant: 'debug' });", 'variant'],
    ["await stim.run({ platform: 'android', scheme: 'App' });", 'scheme'],
    ["await stim.run({ platform: 'web', slot: 'browser' });", 'slot'],
    ["await stim.build({ platform: 'ios', variant: 'debug' });", 'variant'],
    ["await stim.build({ platform: 'android', scheme: 'App' });", 'scheme'],
    ["(await stim.build({ platform: 'ios' })).facts.apkPath;", 'apkPath'],
    ["(await stim.run({ platform: 'ios' })).facts.serial;", 'serial'],
  ]) {
    writeFileSync(
      consumer,
      `import { createStim } from 'stim';
const stim = createStim({ projectRoot: '.' });
${source}
`,
    );
    assert.throws(
      () => execFileSync(process.execPath, compilerArgs, { cwd: repositoryRoot, encoding: 'utf8', stdio: 'pipe' }),
      (error) => error.status === 1 && error.stdout.includes(rejectedProperty),
      `the public API must reject ${source}`,
    );
  }
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

const ciRequire = createRequire(join(repositoryRoot, 'packages', 'ci', 'package.json'));
assert.equal(typeof ciRequire('@stim-cli/ci').runCI, 'function');
assert.equal(typeof (await import(pathToFileURL(ciRequire.resolve('@stim-cli/ci')).href)).runCI, 'function');
const ciVersion = execFileSync(process.execPath, ['packages/ci/dist/stim-ci.mjs', '--version'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();
assert.equal(ciVersion, cliPackage.version);

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
