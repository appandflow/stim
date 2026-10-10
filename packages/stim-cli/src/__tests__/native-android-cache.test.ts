import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildAndroidOperation } from '../commands/android/build.ts';
import { androidBuildToolName } from '../devices/android.ts';
import * as gradle from '../engine/gradle.ts';
import * as locks from '../engine/build-lock.ts';
import * as cache from '../cache/build-cache.ts';
import * as providers from '@stim-cli/cache';
import * as offload from '../offload/client.ts';
import * as selection from '../offload/selection.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { gradleArtifactInputs, nativeGradleArtifactSnapshot } from '../integrations/native-gradle-artifact-inputs.ts';
import { nativeGradleTransfer } from '../integrations/native-gradle-inputs.ts';
import { nativeAndroidProject } from '../integrations/native-android.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { makeExecutor } from './_factories.ts';

let directory: string;
let root: string;
let repository: string;
let androidPackage: string;
let sdk: string;
let visible: string[];
let generations: number;
let duringBuild: () => void;
const declaration = {
  complete: true,
  ignored: [],
  outputs: ['app/build'],
  localFiles: ['../signing/key'],
  environment: ['STIM_FIXTURE_SIGNING'],
};
const selected = {
  variant: 'freeRelease',
  compilerCache: 'none',
  gradleBuildCache: true,
  pch: 'auto',
  cas: null,
} as const;
function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function settings(value: unknown = declaration) {
  write(
    join(root, '.stim.json'),
    JSON.stringify({
      android: { artifactInputs: value },
      optimizations: { releaseBundleSwap: false, android: { compilerCache: 'none' } },
    }),
  );
}
const build = (buildCache = true, abi: 'x86_64' | 'all' = 'x86_64') =>
  buildAndroidOperation(root, { variant: 'freeRelease', abi, remoteBuild: 'local', buildCache });

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-apk-cache-')));
  root = join(directory, 'project');
  repository = root;
  androidPackage = 'org.example.free';
  sdk = join(directory, 'sdk');
  for (const [key, value] of Object.entries({
    HOME: join(directory, 'home'),
    USERPROFILE: join(directory, 'home'),
    JAVA_HOME: join(directory, 'jdk'),
    ANDROID_HOME: sdk,
    ANDROID_USER_HOME: join(directory, 'home', '.android'),
    GRADLE_USER_HOME: join(directory, 'gradle'),
    STIM_HOME: join(directory, 'state'),
    STIM_BUILD_CACHE: join(directory, 'cache'),
    STIM_FIXTURE_SIGNING: 'private-password',
  }))
    vi.stubEnv(key, value);
  for (const key of ['ANDROID_PREFS_ROOT', 'ANDROID_SDK_HOME', 'TEST_TMPDIR']) vi.stubEnv(key, undefined);
  write(join(directory, 'jdk', 'release'), 'JAVA_VERSION="17.0.15"');
  write(join(directory, 'signing', 'key'), 'private-key-one');
  write(join(sdk, 'build-tools', '36.0.0', 'source.properties'), 'Pkg.Revision=36.0.0');
  for (const tool of ['aapt', 'apksigner'])
    write(join(sdk, 'build-tools', '36.0.0', androidBuildToolName(tool)), 'tool');
  visible = ['settings.gradle.kts', 'gradlew', 'gradlew.bat', 'app/src/Main.kt', '.stim.json'];
  for (const file of visible) write(join(root, file), 'source');
  settings();
  generations = 0;
  duringBuild = () => {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setExecutor(
    makeExecutor({
      runFile(file, args = []) {
        if (file === 'git' && args.includes('--show-toplevel')) return repository;
        if (file === 'git' && args.includes('ls-files')) return `${visible.join('\0')}\0`;
        if (file === 'cp') {
          cpSync(args.at(-2)!, args.at(-1)!);
          return '';
        }
        throw new Error(`Unexpected command ${file}`);
      },
      runFileAsync: async (file, args = []) => {
        const apk = JSON.parse(readFileSync(args.at(-1)!, 'utf8'));
        if (file.endsWith(androidBuildToolName('apksigner'))) {
          if (!apk.signed) throw new Error('invalid signature');
          return `Signer #1 certificate SHA-256 digest: ${'a'.repeat(64)}\n`;
        }
        if (file.endsWith(androidBuildToolName('aapt')))
          return `package: name='${apk.package}' versionCode='1'\nnative-code: '${apk.abi}'\n`;
        throw new Error(`Unexpected async command ${file}`);
      },
    }),
  );
  vi.spyOn(gradle, 'buildGradle').mockImplementation(async (request) => {
    generations++;
    const apkPath = join(root, 'app/build/app.apk');
    write(apkPath, JSON.stringify({ package: androidPackage, abi: 'x86_64', signed: true, generation: generations }));
    const model = request
      .projectArgs!.find((arg) => arg.startsWith('-Pstim.native.model='))!
      .slice('-Pstim.native.model='.length);
    write(
      model,
      JSON.stringify({
        schema: 1,
        module: ':app',
        variant: 'freeRelease',
        applicationId: androidPackage,
        sdkDirectory: sdk,
        elements: [{ path: apkPath, filters: [] }],
      }),
    );
    const located = await request.locate!();
    if ('code' in located) throw new Error(located.reason);
    duringBuild();
    return { ok: true, apkPath, androidPackage: located.androidPackage, apkNote: null, durationMs: 1, lastLines: [] };
  });
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test('signed native Release reuse returns the package on a cold process and planning uses the same key without building', async () => {
  const first = await build(true, 'all');
  const warm = await build(true, 'all');
  expect(first.cacheHit).toBe(false);
  expect(warm).toMatchObject({
    cacheHit: 'local',
    cacheSkipped: false,
    cacheKey: first.cacheKey,
    androidPackage: 'org.example.free',
  });
  expect(generations).toBe(1);
  const state = readWorkspaceState(root);
  const plan = await nativeAndroidProject(root).plan!({ variant: 'freeRelease' });
  const allAbi = nativeGradleArtifactSnapshot(root, declaration, selected, null);
  expect(plan).toMatchObject({
    platform: 'android',
    fingerprint: allAbi.hash,
    cacheKey: first.cacheKey,
    cacheHit: 'local',
  });
  expect(plan).toHaveProperty('cacheKey', allAbi.key);
  expect(readWorkspaceState(root)).toEqual(state);
  expect(state).not.toHaveProperty('supervisor');
  expect(generations).toBe(1);
});

test.each(['source', 'signing', 'environment', 'debug-keystore', 'jdk', 'sdk'] as const)(
  '%s changes invalidate native APK reuse',
  async (input) => {
    const first = await build();
    if (input === 'source') write(join(root, 'app/src/Main.kt'), 'edited');
    if (input === 'signing') write(join(directory, 'signing/key'), 'private-key-two');
    if (input === 'environment') vi.stubEnv('STIM_FIXTURE_SIGNING', 'changed-password');
    if (input === 'debug-keystore') write(join(directory, 'home/.android/debug.keystore'), 'new-default-key');
    if (input === 'jdk') write(join(directory, 'jdk/release'), 'JAVA_VERSION="17.0.16"');
    if (input === 'sdk') write(join(sdk, 'build-tools/36.0.0/source.properties'), 'Pkg.Revision=36.0.1');
    const second = await build();
    expect(second.cacheKey).not.toBe(first.cacheKey);
    expect(second.cacheHit).toBe(false);
    expect(generations).toBe(2);
  },
);

test('selected native projects cache their own package and retain reuse across repository relocation', async () => {
  const files = [...visible];
  const inputs = { complete: true, ignored: [], outputs: ['one/app/build', 'two/app/build'] };
  for (const name of ['one', 'two']) {
    root = join(repository, name);
    for (const file of files) write(join(root, file), 'source');
    settings(inputs);
  }
  visible = ['one', 'two'].flatMap((name) => files.map((file) => `${name}/${file}`));
  root = join(repository, 'one');
  const one = await build();
  root = join(repository, 'two');
  androidPackage = 'org.example.second';
  const two = await build();
  expect(one.cacheKey).toEqual(expect.any(String));
  expect(two.cacheKey).toEqual(expect.any(String));
  expect(two.cacheKey).not.toBe(one.cacheKey);
  expect(two).toMatchObject({ cacheHit: false, androidPackage: 'org.example.second' });
  expect(await build()).toMatchObject({ cacheHit: 'local', androidPackage: 'org.example.second' });
  root = join(repository, 'one');
  expect(await build()).toMatchObject({ cacheHit: 'local', androidPackage: 'org.example.free' });
  const relocated = join(directory, 'relocated');
  cpSync(repository, relocated, { recursive: true });
  repository = relocated;
  root = join(repository, 'one');
  expect(await build()).toMatchObject({
    cacheHit: 'local',
    cacheKey: one.cacheKey,
    androidPackage: 'org.example.free',
  });
  expect(generations).toBe(2);
});

test('generated outputs do not change the key, and private inputs never authorize source transfers', () => {
  const before = nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64');
  write(join(root, 'app/build/new.bin'), 'generated');
  expect(nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64')).toEqual(before);
  const transfer = nativeGradleTransfer(root, { complete: true, ignored: [], outputs: ['app/build'] });
  expect(transfer.files.some((file) => file.path.includes('signing'))).toBe(false);
  expect(JSON.stringify({ before, transfer })).not.toContain('private-password');
  expect(JSON.stringify({ before, transfer })).not.toContain('private-key-one');
  expect(() => nativeGradleTransfer(root, declaration)).toThrow('android.offloadInputs');
});

test('private local properties and absent declared files affect only the local artifact identity', () => {
  visible.push('local.properties');
  write(join(root, 'local.properties'), 'sdk.dir=/private/sdk\nprivate.key=one');
  const value = { ...declaration, localFiles: [...declaration.localFiles, '../optional-key'] };
  const before = nativeGradleArtifactSnapshot(root, value, selected, 'x86_64');
  write(join(root, 'local.properties'), 'sdk.dir=/private/sdk\nprivate.key=two');
  const edited = nativeGradleArtifactSnapshot(root, value, selected, 'x86_64');
  expect(edited.hash).not.toBe(before.hash);
  write(join(directory, 'optional-key'), 'created');
  expect(nativeGradleArtifactSnapshot(root, value, selected, 'x86_64').hash).not.toBe(edited.hash);
  expect(() => nativeGradleTransfer(root, { complete: true, ignored: [], outputs: ['app/build'] })).toThrow(
    'unsupported machine-local properties',
  );
});

test('inputs changed during compilation never publish a cache entry', async () => {
  duringBuild = () => write(join(directory, 'signing/key'), `changed-${generations}`);
  const first = await build();
  const second = await build();
  expect(first).toMatchObject({ cacheHit: false, cacheKey: null });
  expect(second).toMatchObject({ cacheHit: false, cacheKey: null });
  expect(existsSync(join(directory, 'cache'))).toBe(false);
  expect(generations).toBe(2);
});

test('cache-off runs compile twice without artifact lookup, publication or shared-build waiting', async () => {
  const config = JSON.parse(readFileSync(join(root, '.stim.json'), 'utf8'));
  config.optimizations.buildCache = false;
  write(join(root, '.stim.json'), JSON.stringify(config));
  const lookup = vi.spyOn(cache, 'resolveBuild');
  const wait = vi.spyOn(locks, 'waitForSharedBuild');
  for (const result of [await build(), await build()])
    expect(result).toMatchObject({ cacheHit: false, cacheSkipped: true });
  expect(lookup).not.toHaveBeenCalled();
  expect(wait).not.toHaveBeenCalled();
  expect(existsSync(join(directory, 'cache'))).toBe(false);
  expect(generations).toBe(2);
});

test('the build-cache bypass flag refreshes the native APK without reading or waiting for the old entry', async () => {
  const first = await build();
  const lookup = vi.spyOn(cache, 'resolveBuild');
  const wait = vi.spyOn(locks, 'waitForSharedBuild');
  const refreshed = await build(false);
  expect(refreshed).toMatchObject({ cacheHit: false, cacheSkipped: true, cacheKey: first.cacheKey });
  expect(lookup).not.toHaveBeenCalled();
  expect(wait).not.toHaveBeenCalled();
  const stored = cache.artifactIn(cache.entryDir('android', first.cacheKey!))!;
  expect(JSON.parse(readFileSync(stored, 'utf8'))).toHaveProperty('generation', 2);
  expect(await build()).toMatchObject({ cacheHit: 'local', cacheKey: first.cacheKey });
  expect(generations).toBe(2);
});

test('a local artifact declaration neither identifies a worker APK nor transfers private inputs', async () => {
  const config = JSON.parse(readFileSync(join(root, '.stim.json'), 'utf8'));
  config.android.offloadInputs = { complete: true, ignored: [], outputs: ['app/build'] };
  write(join(root, '.stim.json'), JSON.stringify(config));
  vi.spyOn(selection, 'resolveBuildPlacement').mockReturnValue({ selected: 'worker' });
  vi.spyOn(offload, 'buildPlacementCandidates').mockReturnValue({
    mode: 'auto',
    localEnabled: true,
    machines: [{ machine: 'worker' }],
  } as ReturnType<typeof offload.buildPlacementCandidates>);
  vi.spyOn(offload, 'chooseBuildMachine').mockResolvedValue({
    machine: 'worker',
    offer: { capacity: { loadPerCore: 0.1 } },
  } as Awaited<ReturnType<typeof offload.chooseBuildMachine>>);
  vi.spyOn(offload, 'closeOffload').mockImplementation(() => {});
  let staging = '';
  vi.spyOn(offload, 'offloadBuild').mockImplementation(async ({ stagingDir, request, expectedFingerprint }) => {
    expect(expectedFingerprint).toBeNull();
    expect(JSON.stringify(request)).not.toContain('private-password');
    expect(JSON.stringify(request)).not.toContain('private-key-one');
    expect(
      request.platform === 'android' && request.native?.transfer.files.some((file) => file.path.includes('signing')),
    ).toBe(false);
    staging = stagingDir;
    const artifactPath = join(stagingDir, 'worker.apk');
    write(artifactPath, 'verified worker APK');
    return {
      ok: true,
      machine: 'worker',
      artifactPath,
      androidPackage: 'org.example.worker',
      compilationCache: { status: 'unavailable', hits: null, cacheableTasks: null, hitRatePercent: null },
      ccache: { status: 'unavailable', hits: null, misses: null, hitRatePercent: null },
      timings: {
        offerMs: 1,
        syncMs: 1,
        workerMs: 1,
        fetchMs: 1,
        totalMs: 4,
        worker: {},
        uploadedBytes: 1,
        artifactBytes: 1,
      },
    };
  });
  const result = await buildAndroidOperation(root, { variant: 'freeRelease', abi: 'x86_64', remoteBuild: 'worker' });
  expect(result).toMatchObject({
    cacheHit: false,
    cacheSkipped: true,
    cacheKey: null,
    androidPackage: 'org.example.worker',
    builtOn: 'worker',
  });
  expect(generations).toBe(0);
  expect(existsSync(join(directory, 'cache'))).toBe(false);
  expect(existsSync(staging)).toBe(false);
});

test('local native identities do not load cache providers', async () => {
  const config = JSON.parse(readFileSync(join(root, '.stim.json'), 'utf8'));
  config.cache = { provider: './private-provider.mjs' };
  write(join(root, '.stim.json'), JSON.stringify(config));
  const load = vi.spyOn(providers, 'loadCacheProvider');
  const first = await build();
  const second = await build();
  expect(first.cacheHit).toBe(false);
  expect(second.cacheHit).toBe('local');
  expect(load).not.toHaveBeenCalled();
});

test.each(['bytes', 'package', 'abi', 'signature'] as const)(
  'a cached APK with invalid %s is rebuilt',
  async (invalid) => {
    const first = await build();
    const stored = cache.artifactIn(cache.entryDir('android', first.cacheKey!))!;
    const receiptPath = join(dirname(stored), 'native-android.json');
    if (invalid === 'bytes') write(stored, 'corrupt');
    else if (invalid === 'package') {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      write(receiptPath, JSON.stringify({ ...receipt, androidPackage: 'org.other' }));
    } else {
      const apk = JSON.parse(readFileSync(stored, 'utf8'));
      write(stored, JSON.stringify({ ...apk, ...(invalid === 'abi' ? { abi: 'arm64-v8a' } : { signed: false }) }));
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      write(
        receiptPath,
        JSON.stringify({ ...receipt, sha256: createHash('sha256').update(readFileSync(stored)).digest('hex') }),
      );
    }
    const second = await build();
    expect(second.cacheHit).toBe(false);
    expect(generations).toBe(2);
  },
);

test.each([
  undefined,
  { ...declaration, complete: false },
  { ...declaration, environment: ['BAD=VALUE'] },
  { ...declaration, extra: true },
])('missing or invalid declarations do not enable artifact caching: %j', async (value) => {
  if (value === undefined) {
    const config = JSON.parse(readFileSync(join(root, '.stim.json'), 'utf8'));
    delete config.android.artifactInputs;
    write(join(root, '.stim.json'), JSON.stringify(config));
  } else settings(value);
  for (const result of [await build(), await build()])
    expect(result).toMatchObject({ cacheHit: false, cacheSkipped: true, cacheKey: null });
  expect(generations).toBe(2);
});

test('a local directory cannot be declared as one exact private file', () => {
  expect(() =>
    nativeGradleArtifactSnapshot(root, { ...declaration, localFiles: ['../signing'] }, selected, 'x86_64'),
  ).toThrow('exact regular files');
  expect(() => gradleArtifactInputs({ ...declaration, ignored: ['../outside'] })).toThrow('android.artifactInputs');
});
