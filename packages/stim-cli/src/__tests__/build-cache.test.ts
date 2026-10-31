import { execFile } from 'node:child_process';
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
import * as expoFingerprint from '@expo/fingerprint';
import type { FingerprintSource } from '@expo/fingerprint';
import { runCacheProviderContract } from '@stim-cli/cache';
import { androidBuildToolName } from '../devices/android.ts';
import { getExecutor, setExecutor, resetExecutor } from '../exec.ts';
import {
  androidProjectFingerprintOptions,
  buildCacheKey,
  filesystemBuildCapability,
  changedOnlyInside,
  compareSourceLists,
  entryDir,
  evictBuild,
  fingerprintProject,
  gitignoredFingerprintInputs,
  ignoredFingerprintPaths,
  trackedFingerprintPaths,
  resolveBuild,
  storeBuild,
  storedAssetManifest,
  storedSources,
  untrackedNativeFiles,
} from '../cache/build-cache.ts';
import { writeSignedApk } from './_signed-apk.ts';
import { recordedSignedTail } from '../engine/apk-signed-tail.ts';
import { ASSET_MANIFEST_VERSION, type AssetManifest } from '../engine/asset-manifest.ts';
import { buildCacheKey as providerKey } from '../../../expo-build-cache/index.js';

// @expo/fingerprint 0.21 runs `npx react-native config` in a project without expo-modules-autolinking, which downloads
// react-native from the npm registry on a cold runner; this option reads the autolinking sources from Expo instead.
const offlineFingerprint: typeof expoFingerprint.createFingerprintAsync = (dir, options) =>
  expoFingerprint.createFingerprintAsync(dir, { ...options, useRNCoreAutolinkingFromExpo: true });
const fingerprintOffline = (dir: string, target: NonNullable<Parameters<typeof fingerprintProject>[1]>) =>
  fingerprintProject(dir, { ...target, createFingerprint: offlineFingerprint });

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

test('the CLI and the Expo provider compute the same key', () => {
  for (const [platform, options] of [
    ['ios', {}],
    ['ios', { configuration: 'Release' }],
    ['ios', { buildProfile: 'opt-test' }],
    ['android', { buildProfile: 'opt-test', compiler: 'apple-cas-test' }],
    ['ios', { device: 'generic' }],
    ['ios', { device: 'Janic iPhone' }],
    ['ios', { device: true }],
    ['ios', { arch: 'x86_64', scheme: 'App' }],
    ['android', { variant: 'release', device: 'emulator-5554', abi: 'arm64-v8a' }],
    ['android', { variant: 'release', compiler: 'apple-cas-012345' }],
  ] as [string, Record<string, unknown>][]) {
    expect(buildCacheKey(platform, 'hash', options)).toBe(providerKey(platform, 'hash', options));
  }
});

test('a module under android/ other than app keeps its build outputs out of the fingerprint', () => {
  const app = realpathSync(root);
  const layout = {
    gradleRoot: join(app, 'android'),
    gradleRootRelative: 'android',
    module: ':mobile',
    moduleDir: join(app, 'android', 'mobile'),
    custom: true,
  };
  expect(androidProjectFingerprintOptions(app, layout, () => false)).toEqual({
    extraSources: [],
    ignorePaths: ['android/mobile/build/**/*', 'android/mobile/.cxx/**/*', 'android/mobile/.gradle/**/*'],
  });
});

test('storeBuild carries the sources AND the asset manifest in the same store', async () => {
  resetExecutor();
  const build = join(root, 'build2', 'App.apk');
  mkdirSync(join(root, 'build2'), { recursive: true });
  writeFileSync(build, 'apk');

  const sources = [fpFile('android/app/build.gradle', 'aa')];
  const assetManifest: AssetManifest = { version: ASSET_MANIFEST_VERSION, assets: [] };
  await storeBuild('android', 'ak2', build, { root, sources, assetManifest });

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

test('changedOnlyInside accepts a difference confined to the iOS project and nothing else', () => {
  const client = [
    { id: 'ios', hash: 'aa' },
    { id: 'expoConfig', hash: 'bb' },
  ];
  const changed = (ios: string, config: string) => [
    { type: 'dir', filePath: 'ios', hash: ios },
    { type: 'contents', id: 'expoConfig', hash: config },
  ];
  expect(changedOnlyInside(client, changed('a2', 'bb'), 'ios')).toBe(true);
  expect(changedOnlyInside(client, [...changed('aa', 'bb'), { filePath: 'ios/Podfile.lock', hash: 'cc' }], 'ios')).toBe(
    true,
  );
  expect(changedOnlyInside(client, changed('a2', 'b2'), 'ios')).toBe(false);
  expect(changedOnlyInside(client, changed('aa', 'bb'), 'ios')).toBe(false);
  expect(changedOnlyInside(client, [...changed('aa', 'bb'), { filePath: 'ios-extra', hash: 'cc' }], 'ios')).toBe(false);
  expect(changedOnlyInside(client, changed('a2', 'bb'), '.')).toBe(false);
  const packageOutside = [...client, { id: 'node_modules/native-lib/package.json', hash: 'dd' }];
  const packageMovedInside = [
    ...changed('aa', 'bb'),
    { filePath: 'ios/node_modules/native-lib/package.json', hash: 'ee' },
  ];
  expect(changedOnlyInside(packageOutside, packageMovedInside, 'ios')).toBe(false);
  for (const escaping of [
    { filePath: 'ios/../shared/NativeConfig.h', hash: 'ff' },
    { type: 'contents', id: 'ios/nativeConfig', hash: 'ff' },
  ])
    expect(changedOnlyInside(client, [...changed('aa', 'bb'), escaping], 'ios')).toBe(false);
});

describe('gitignored fingerprint inputs', () => {
  const write = (path: string, content = path) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  beforeEach(() => {
    resetExecutor();
    write('package.json', '{"name":"app"}');
    write(
      '.gitignore',
      'node_modules/\n.env.local\nios/Pods/\nios/assets/\n*.jsbundle\nxcuserdata\nios/GoogleService-Info.plist\ncreds/\n',
    );
    write('.env.sample');
    write('ios/Podfile');
    getExecutor().runFile('git', ['init', '--quiet', root], { timeoutMs: 10_000 });
    getExecutor().runFile('git', ['-C', root, 'add', '.'], { timeoutMs: 10_000 });
    write('.env.local');
    write('ios/GoogleService-Info.plist');
    write('ios/Pods/Manifest.lock');
    write('ios/assets/node_modules/icon.png');
    write('ios/main.jsbundle');
    write('ios/App.xcodeproj/xcuserdata/me.xcuserdatad/xcschemes/xcschememanagement.plist');
    write('node_modules/expo-camera/ios/Camera.swift');
    write('creds/google-services.json');
    write('creds/release.keystore');
  });

  test('are the ignored files a checkout lacks, without dependencies or build leftovers', async () => {
    const sources: FingerprintSource[] = [
      { type: 'dir', filePath: 'ios', reasons: ['bareNativeDir'], hash: 'a' },
      { type: 'dir', filePath: 'node_modules/expo-camera/ios', reasons: ['expoAutolinkingIos'], hash: 'b' },
      { type: 'contents', id: 'expoConfig', contents: '{}', reasons: ['expoConfig'], hash: 'c' },
      { type: 'file', filePath: 'creds/google-services.json', reasons: ['expoConfigExternalFile'], hash: 'd' },
      { type: 'dir', filePath: '../outside-the-repository', reasons: ['extraSources'], hash: 'e' },
    ];
    const real = realpathSync(root);
    expect(await gitignoredFingerprintInputs(real, sources, { platform: 'ios' }, { env: {} })).toEqual([
      join(real, '.env.local'),
      join(real, 'creds/google-services.json'),
      join(real, 'ios/GoogleService-Info.plist'),
    ]);
    expect(
      await gitignoredFingerprintInputs(real, sources, { platform: 'ios' }, { env: { EXPO_NO_DOTENV: '1' } }),
    ).toEqual([join(real, 'creds/google-services.json'), join(real, 'ios/GoogleService-Info.plist')]);
    write('.env.development');
    expect(
      await gitignoredFingerprintInputs(real, sources, { platform: 'ios' }, { env: { NODE_ENV: 'production' } }),
    ).toEqual(expect.arrayContaining([join(real, '.env.development'), join(real, '.env.local')]));
    rmSync(join(root, '.env.development'));
    expect(await gitignoredFingerprintInputs(real, sources.slice(0, 2), { platform: 'ios' }, { env: {} })).toEqual([
      join(real, 'ios/GoogleService-Info.plist'),
    ]);
  });
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

  test('a build worker counts the top-level file the client tracks although a .gitignore pattern matches it', async () => {
    for (const dir of [root, worker]) {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n*.plist\nconfig/\n');
      mkdirSync(join(dir, 'config'));
      writeFileSync(join(dir, 'config/app.json'), 'tracked');
      writeFileSync(join(dir, 'GoogleService-Info.plist'), 'tracked');
      writeFileSync(join(dir, 'Other.plist'), 'untracked');
    }
    git(root, 'add', '.gitignore');
    git(root, 'add', '-f', 'GoogleService-Info.plist', 'config/app.json');
    const target = { platform: 'ios', iosProjectPath: '.' };
    const trackedPaths = trackedFingerprintPaths(root, target);
    expect(trackedPaths).toEqual(['GoogleService-Info.plist', 'config']);
    expect(ignoredFingerprintPaths(root, target)).toEqual(['Other.plist']);
    const client = (await fingerprintOffline(root, target))?.hash;
    expect((await fingerprintOffline(worker, target))?.hash).not.toBe(client);
    expect((await fingerprintOffline(worker, { ...target, trackedPaths }))?.hash).toBe(client);
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
