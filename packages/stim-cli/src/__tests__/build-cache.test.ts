import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import type { FingerprintSource } from '@expo/fingerprint';
import { runCacheProviderContract } from '@stim-cli/cache';
import { androidBuildToolName } from '../devices/android.ts';
import { getExecutor, setExecutor, resetExecutor } from '../exec.ts';
import {
  buildCacheKey,
  filesystemBuildCapability,
  compareSourceLists,
  entryDir,
  evictBuild,
  resolveBuild,
  storeBuild,
  storedAssetManifest,
  storedSources,
  storedInputs,
  untrackedNativeFiles,
} from '../cache/build-cache.ts';
import { trackedPaths as gitTrackedPaths } from '../fingerprint/git-index.ts';
import { staticInputs } from '../fingerprint/inputs.ts';
import { walk } from '../fingerprint/walk.ts';
import { replayFiles } from '../fingerprint/replay.ts';
import { isUncertain, preimage, preimageHash } from '../fingerprint/key.ts';
import { writeSignedApk } from './_signed-apk.ts';
import { recordedSignedTail } from '../engine/apk-signed-tail.ts';
import { ASSET_MANIFEST_VERSION, type AssetManifest } from '../engine/asset-manifest.ts';

let root: string;
let tmpHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-bc-'));
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-bc-home-'));
  process.env.STIM_HOME = tmpHome;
});
afterEach(() => {
  resetExecutor();
  rmSync(root, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function seedEntry(platform: string, hash: string, name = 'MyApp.app') {
  const dir = entryDir(platform, hash, root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), 'binary');
  return join(dir, name);
}

function fpFile(filePath: string, hash: string): FingerprintSource {
  return { type: 'file', filePath, reasons: [], hash };
}

test('evictBuild removes one entry and leaves its neighbours and the cache directory', async () => {
  seedEntry('ios', 'fp-bad', 'MyApp.app');
  const neighbour = seedEntry('ios', 'fp-good', 'MyApp.app');

  expect(await evictBuild('ios', 'fp-bad', root)).toBe(true);
  expect(resolveBuild('ios', 'fp-bad', root)).toBeNull();
  expect(readdirSync(join(root, 'ios'))).toEqual(['fp-good']);
  expect(resolveBuild('ios', 'fp-good', root)).toBe(neighbour);
  expect(await evictBuild('ios', 'fp-bad', root)).toBe(false);
});

test('storeBuild refuses a path that is not there rather than creating an empty entry', async () => {
  await expect(storeBuild('ios', 'fp3', join(root, 'missing.app'), root)).rejects.toThrow(/No build to store/);
  expect(existsSync(entryDir('ios', 'fp3', root))).toBe(false);
});

test('a custom Android module keeps its build output out of the fingerprint', () => {
  const app = realpathSync(root);
  const module = join(app, 'android', 'mobile');
  mkdirSync(join(module, 'build'), { recursive: true });
  writeFileSync(join(module, 'build.gradle'), 'apply plugin: "com.android.application"');
  writeFileSync(join(module, 'build', 'generated.txt'), 'generated');
  const result = walk({ roots: { project: app, install: app }, trees: [module], tracked: null });
  if (isUncertain(result)) throw new Error(result.uncertain);
  expect(result.inputs.map((input) => input.name)).toEqual(['android/mobile/build.gradle']);
});

test('storeBuild carries the sources AND the asset manifest in the same store', async () => {
  resetExecutor();
  const build = join(root, 'build2', 'App.apk');
  mkdirSync(join(root, 'build2'), { recursive: true });
  writeFileSync(build, 'apk');

  const sources = [fpFile('android/app/build.gradle', 'aa')];
  const assetManifest: AssetManifest = { version: ASSET_MANIFEST_VERSION, assets: [] };
  const inputs = {
    schema: 2,
    hash: 'b'.repeat(64),
    inputs: [{ name: 'env:VARIANT', kind: 'env' as const, hash: 'a'.repeat(64) }],
  };
  await storeBuild('android', 'ak2', build, { root, sources, inputs, assetManifest });

  expect(storedInputs('android', 'ak2', root)).toEqual(inputs);
  expect(storedSources('android', 'ak2', root)).toEqual(sources);
  expect(storedAssetManifest('android', 'ak2', root)).toEqual(assetManifest);
});

test('storing an Android APK verifies its signature once and records the signed tail beside it', async () => {
  resetExecutor();
  const sdk = join(root, 'sdk');
  mkdirSync(join(sdk, 'build-tools', '36.0.0'), { recursive: true });
  const apksigner = join(sdk, 'build-tools', '36.0.0', androidBuildToolName('apksigner'));
  writeFileSync(apksigner, '');
  const build = join(root, 'build7', 'app-debug.apk');
  const apk = writeSignedApk(build, {}, false);
  const real = getExecutor();
  const signerCalls: string[][] = [];
  setExecutor({
    ...real,
    runFileAsync: async (file, args, options) => {
      if (file !== apksigner) return real.runFileAsync(file, args, options);
      signerCalls.push([file, ...(args ?? [])]);
      return 'Verified using v2 scheme (APK Signature Scheme v2): true\n';
    },
  });
  const androidHome = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
  try {
    const stored = await storeBuild('android', 'ak7', build, { root });
    assert(stored);
    expect(signerCalls.map((call) => call.slice(0, 3))).toEqual([[apksigner, 'verify', '--verbose']]);
    expect(recordedSignedTail(stored)).toEqual({
      file: 'app-debug.apk',
      size: apk.size,
      tailOffset: apk.tailOffset,
      tailSha256: apk.tailSha256,
    });
  } finally {
    if (androidHome === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = androidHome;
  }
});

test('compareSourceLists is empty when nothing moved, and ignores unnamed sources', () => {
  const sources = [{ filePath: 'a', hash: '1' }, { hash: 'anonymous' }];
  expect(compareSourceLists(sources, sources)).toEqual([]);
});

test('native tree fingerprints exclude signing files while keeping other ignored files', () => {
  const project = realpathSync(root);
  writeFileSync(join(project, '.gitignore'), 'ios/*.plist\nios/fastlane/\ncreds/\n');
  for (const path of [
    'ios/Podfile',
    'ios/GoogleService-Info.plist',
    'ios/fastlane/Appfile',
    'ios/fastlane/AuthKey_ABC.p8',
    'ios/dist.p12',
    'creds/App.mobileprovision',
  ]) {
    mkdirSync(join(project, path, '..'), { recursive: true });
    writeFileSync(join(project, path), path);
  }
  const trees = [join(project, 'ios'), join(project, 'creds')];
  const collect = (keepSigningFiles: boolean) => {
    const result = walk({ roots: { project, install: project }, trees, tracked: null, keepSigningFiles });
    if (isUncertain(result)) throw new Error(result.uncertain);
    return result.inputs.map((input) => input.name);
  };
  expect(collect(false)).toEqual(
    expect.arrayContaining(['ios/Podfile', 'ios/GoogleService-Info.plist', 'ios/fastlane/Appfile']),
  );
  for (const path of ['ios/fastlane/AuthKey_ABC.p8', 'ios/dist.p12', 'creds/App.mobileprovision'])
    expect(collect(false)).not.toContain(path);
  expect(collect(true)).toEqual(
    expect.arrayContaining(['ios/fastlane/AuthKey_ABC.p8', 'ios/dist.p12', 'creds/App.mobileprovision']),
  );
});

describe('fingerprints that depend on a local git exclude', () => {
  const git = (dir: string, ...args: string[]) =>
    getExecutor().runFile('git', ['-C', dir, ...args], { timeoutMs: 10_000 });
  const files: Record<string, string> = {
    'package.json': '{"name":"app"}',
    '.gitignore': 'node_modules/\n',
    'ios/Podfile': 'platform :ios',
    'ios/main.jsbundle': 'bundle',
    '.env.local': 'KEY=1',
  };
  let worker: string;
  const checkout = (dir: string) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    getExecutor().runFile('git', ['init', '--quiet', dir], { timeoutMs: 10_000 });
    git(dir, 'config', 'core.excludesFile', '/dev/null');
  };
  beforeEach(() => {
    resetExecutor();
    worker = mkdtempSync(join(tmpdir(), 'stim-bc-worker-'));
    checkout(root);
    checkout(worker);
    git(root, 'add', 'package.json', '.gitignore', 'ios');
  });
  afterEach(() => rmSync(worker, { recursive: true, force: true }));

  test('a build worker replays native files even when local gitignore rules match them', async () => {
    for (const dir of [root, worker]) {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.plist\nconfig/\n');
      mkdirSync(join(dir, 'config'));
      writeFileSync(join(dir, 'config/app.json'), 'tracked');
      writeFileSync(join(dir, 'GoogleService-Info.plist'), 'tracked');
      writeFileSync(join(dir, 'Other.plist'), 'untracked');
    }
    git(root, 'add', '.gitignore');
    git(root, 'add', '-f', 'GoogleService-Info.plist', 'config/app.json');
    const target = { platform: 'ios' as const, iosProjectPath: '.' };
    const project = realpathSync(root);
    const client = staticInputs(
      { root: project, tracked: await gitTrackedPaths(project), expoResolves: false },
      target,
    );
    if (isUncertain(client)) throw new Error(client.uncertain);
    const inputFiles = client.inputs.filter(
      (input) => input.kind === 'file' && !/^(?:exists|dir|tree|virtual):/.test(input.name),
    );
    expect(inputFiles.map((input) => input.name)).toEqual(
      expect.arrayContaining(['GoogleService-Info.plist', 'config/app.json', 'Other.plist']),
    );
    const mirror = realpathSync(worker);
    const replayed = replayFiles(
      inputFiles.map(({ name, kind, hash }) => ({ id: name, kind, hash })),
      { project: mirror, install: mirror },
      target,
    );
    if (isUncertain(replayed)) throw new Error(replayed.uncertain);
    expect(replayed.map(({ name, hash }) => ({ name, hash }))).toEqual(
      inputFiles.map(({ name, hash }) => ({ name, hash })),
    );
  }, 30_000);
});

describe('library example apps in linked worktrees', () => {
  test('fingerprint alike although each worktree has its own .git file', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'stim-bc-lib-'));
    const git = (...args: string[]) => getExecutor().runFile('git', ['-C', repo, ...args], { timeoutMs: 10_000 });
    try {
      mkdirSync(join(repo, 'example/ios'), { recursive: true });
      writeFileSync(join(repo, 'package.json'), '{"name":"lib"}');
      writeFileSync(join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(join(repo, 'example/package.json'), '{"name":"example"}');
      writeFileSync(join(repo, 'example/ios/Podfile'), 'platform :ios');
      git('init', '--quiet');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'init');
      git('worktree', 'add', '--quiet', '--detach', `${repo}-a`, 'HEAD');
      git('worktree', 'add', '--quiet', '--detach', `${repo}-b`, 'HEAD');
      const library = { extraSources: [{ type: 'dir', filePath: '..' }] };
      const hashes = await Promise.all(
        ['a', 'b'].map(async (suffix) => {
          const worktree = `${repo}-${suffix}`;
          expect(readFileSync(join(worktree, '.git'), 'utf8')).toContain('worktrees/');
          return await ownFingerprint(join(worktree, 'example'), library);
        }),
      );
      expect(hashes[0]).toBeTruthy();
      expect(hashes[0]).toBe(hashes[1]);
    } finally {
      for (const dir of [repo, `${repo}-a`, `${repo}-b`]) rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('library example apps in the main checkout', () => {
  test('fingerprint alike after git activity and Metro writing .expo state', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'stim-bc-lib-main-'));
    const git = (...args: string[]) => getExecutor().runFile('git', ['-C', repo, ...args], { timeoutMs: 10_000 });
    try {
      mkdirSync(join(repo, 'example/ios'), { recursive: true });
      writeFileSync(join(repo, 'package.json'), '{"name":"lib"}');
      writeFileSync(join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(join(repo, 'example/package.json'), '{"name":"example"}');
      writeFileSync(join(repo, 'example/ios/Podfile'), 'platform :ios');
      git('init', '--quiet');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'init');
      const library = { extraSources: [{ type: 'dir', filePath: '..' }] };
      const fingerprint = async () => await ownFingerprint(join(repo, 'example'), library);
      const before = await fingerprint();
      expect(before).toBeTruthy();

      git('worktree', 'add', '--quiet', '--detach', `${repo}-wt`, 'HEAD');
      git('update-ref', 'refs/heads/probe', 'HEAD');
      mkdirSync(join(repo, 'example/.expo/dev/logs'), { recursive: true });
      writeFileSync(join(repo, 'example/.expo/dev/logs/start.log'), 'metro started');
      expect(await fingerprint()).toBe(before);

      writeFileSync(join(repo, 'example/ios/Podfile'), 'platform :ios, 16');
      expect(await fingerprint()).not.toBe(before);
    } finally {
      for (const dir of [repo, `${repo}-wt`]) rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

const ownFingerprint = async (dir: string, fingerprintConfig?: unknown) => {
  const result = staticInputs(
    { root: dir, tracked: await gitTrackedPaths(dir), expoResolves: false, fingerprintConfig },
    { platform: 'ios' },
  );
  return isUncertain(result) ? null : preimageHash(preimage('ios', result.native, result.layout, result.inputs));
};

describe('Podfile.lock checksums of podspecs that embed the checkout path', () => {
  const hashOf = ownFingerprint;
  const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-bc-podlock-')));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function checkout(name: string, { version = '58.0.3', hook = false } = {}): string {
    const dir = join(base, name);
    mkdirSync(join(dir, 'ios/Pods/Local Podspecs'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"app"}');
    writeFileSync(join(dir, 'ios/Podfile'), 'platform :ios');
    if (hook) {
      writeFileSync(
        join(dir, 'fingerprint.config.js'),
        'module.exports = { fileHookTransform: (_s, chunk) => chunk && chunk.toString() };',
      );
    }
    const podspec = `{"name":"ExpoModulesCore","version":"${version}","source":{"http":"file://${dir}/node_modules/expo-modules-core/ExpoModulesCore.tar.gz"}}\n`;
    writeFileSync(join(dir, 'ios/Pods/Local Podspecs/ExpoModulesCore.podspec.json'), podspec);
    const filler = Array.from({ length: 80 }, (_, i) => `  Pod${i}: ${sha1(`pod ${i}`)}`).join('\n');
    writeFileSync(
      join(dir, 'ios/Podfile.lock'),
      `PODS:\n  - ExpoModulesCore (${version})\n\nSPEC CHECKSUMS:\n  ExpoModulesCore: ${sha1(podspec)}\n${filler}\n\nPODFILE CHECKSUM: abc\n\nCOCOAPODS: 1.16.2\n`,
    );
    getExecutor().runFile('git', ['-C', dir, 'init', '--quiet'], { timeoutMs: 10_000 });
    getExecutor().runFile('git', ['-C', dir, 'add', 'ios/Podfile', 'ios/Podfile.lock'], { timeoutMs: 10_000 });
    return dir;
  }

  test.each([false, true])(
    'two checkouts of one commit that ran pod install fingerprint alike (project hook: %s)',
    async (hook) => {
      const first = await hashOf(checkout('trailhead-saved', { hook }));
      expect(first).toBeTruthy();
      expect(await hashOf(checkout('trailhead-filters', { hook }))).toBe(first);
    },
    30_000,
  );

  test('a podspec that differs beyond the checkout path still changes the fingerprint', async () => {
    const first = await hashOf(checkout('one'));
    expect(await hashOf(checkout('two', { version: '58.0.4' }))).not.toBe(first);
  }, 30_000);

  test('a checksum that is not its podspec checksum keeps counting as written', async () => {
    const one = checkout('one');
    const two = checkout('two');
    const lock = join(two, 'ios/Podfile.lock');
    const first = await hashOf(one);
    writeFileSync(
      lock,
      readFileSync(lock, 'utf8').replace(/ExpoModulesCore: [0-9a-f]{40}/, `ExpoModulesCore: ${'1'.repeat(40)}`),
    );
    expect(await hashOf(two)).not.toBe(first);
  }, 30_000);
});

describe('untracked native files on a first miss', () => {
  test('runs git without a shell and returns one name per line', () => {
    const calls: { file: string; args: string[] }[] = [];
    setExecutor({
      run: () => {
        throw new Error("the path is the user's; it must not reach a shell");
      },
      runFile: (file: string, args: string[]) => {
        calls.push({ file, args });
        return 'ios/Podfile.lock\nandroid/local.properties\n';
      },
      runQuiet: () => '',
      spawn: () => {},
    });
    expect(untrackedNativeFiles({ projectRoot: root })).toEqual(['ios/Podfile.lock', 'android/local.properties']);
    expect(calls[0]?.file).toBe('git');
    expect(calls[0]?.args).toEqual([
      '--no-optional-locks',
      '-C',
      root,
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      'ios',
      'android',
    ]);
  });
});

test('the built-in filesystem build cache satisfies the provider contract', async () => {
  for (const platform of ['ios', 'android'] as const) {
    const results = await runCacheProviderContract({
      provider: { builds: filesystemBuildCapability({ root: join(root, `contract-${platform}`) }) },
      projectRoot: root,
      workDir: root,
      platform,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((result) => !result.passed)).toEqual([]);
  }
});

test('SIGINT during a cache copy drains its declared child and staging before the CLI exits', async () => {
  const source = join(root, 'source.apk');
  writeFileSync(source, 'new app');
  const previous = seedEntry('android', 'interrupt', 'App.apk');
  const script = `
    const { filesystemBuildCapability } = await import(${JSON.stringify(new URL('../cache/build-cache.ts', import.meta.url).href)});
    const { getExecutor, setExecutor } = await import(${JSON.stringify(new URL('../exec.ts', import.meta.url).href)});
    const { withNativeBuildRun, runCancellationSignal } = await import(${JSON.stringify(new URL('../engine/native-run.ts', import.meta.url).href)});
    const { runProcessOperation } = await import(${JSON.stringify(new URL('../cli-operation.ts', import.meta.url).href)});
    const { readClaimSet } = await import(${JSON.stringify(new URL('../ownership-claim.ts', import.meta.url).href)});
    const { workspaceDir } = await import(${JSON.stringify(new URL('../workspace/paths.ts', import.meta.url).href)});
    const { join } = await import('node:path');
    const [root, source] = process.argv.slice(1);
    const real = getExecutor();
    let closed = false;
    let declared = false;
    let attempts = 0;
    setExecutor({ runFileAsync: (file, args, options) => {
      attempts++;
      return real.runFileAsync(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
        ...options,
        onSpawn(child) {
          options.onSpawn?.(child);
          declared = readClaimSet(join(workspaceDir(root), 'native-run.lock')).live.some((claim) => claim.child?.pid === child.pid);
          child.once('close', () => { closed = true; });
          child.stdout.once('data', () => process.emit('SIGINT'));
        },
      });
    } });
    const { value, interrupted } = await runProcessOperation(root, (context) => withNativeBuildRun(context, root, { command: 'android', platform: 'android' }, async () => {
      try {
        await filesystemBuildCapability({ root, context }).store({ projectRoot: root, platform: 'android', key: 'interrupt', sourcePath: source, overwrite: true, signal: runCancellationSignal(context) });
        return { code: 'unexpected-success' };
      } catch (error) { return { code: error.code, closed, declared, attempts }; }
    }, { write: () => {} }));
    process.stdout.write(JSON.stringify(value));
    process.exitCode = interrupted ?? 0;
  `;
  const result = await new Promise<{ code: string | number; stdout: string }>((resolve) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script, root, source],
      {
        env: { ...process.env, STIM_HOME: tmpHome },
        timeout: 15_000,
      },
      (error, stdout) => resolve({ code: error?.code ?? 0, stdout }),
    );
  });
  expect(result.code).toBe(130);
  expect(result.stdout ? JSON.parse(result.stdout) : null).toEqual({
    code: 'STIM_CANCELLED',
    closed: true,
    declared: true,
    attempts: 1,
  });
  expect(readFileSync(previous, 'utf8')).toBe('binary');
  expect(readdirSync(join(root, 'android'))).toEqual(['interrupt']);
}, 20_000);

test.each([
  ['ios', { isSimulator: true }, { isSimulator: false }],
  ['ios', { isSimulator: true, arch: 'arm64' }, { isSimulator: true, arch: 'x86_64' }],
  ['android', { abi: 'arm64-v8a' }, { abi: 'x86_64' }],
] as const)('the %s cache separates incompatible device architectures: %j and %j', (platform, first, second) => {
  expect(buildCacheKey(platform, 'fingerprint', first)).not.toBe(buildCacheKey(platform, 'fingerprint', second));
});
