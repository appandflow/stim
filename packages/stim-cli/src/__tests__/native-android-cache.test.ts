import assert from 'node:assert/strict';
import { testContext } from './_context.ts';
import { getProject, upsertProject } from '../workspace/config.ts';
import { resolveProjectSettings } from '../workspace/settings.ts';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildAndroidOperation } from '../commands/android/build.ts';
import { androidBuildToolName } from '../devices/android.ts';
import * as gradle from '../engine/gradle.ts';
import * as locks from '../engine/build-lock.ts';
import * as cache from '../cache/build-cache.ts';
import * as providers from '@stim-cli/cache';
import { resetExecutor, setExecutor } from '../exec.ts';
import { gradleArtifactInputs, nativeGradleArtifactSnapshot } from '../integrations/native-gradle-artifact-inputs.ts';
import { nativeGradleTransfer } from '../integrations/native-gradle-inputs.ts';
import { nativeAndroidProject } from '../integrations/native-android.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { makeExecutor } from './_factories.ts';

let directory: string;
let root: string;
let repository: string;
let androidPackage: string;
let sdk: string;
let visible: string[];
let generations: number;
let duringBuild: () => void;
let duringInspection: (path: string) => void;
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
const propertyValue = (value: string) => value.replaceAll(String.fromCharCode(92), String.fromCharCode(92, 92));
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
function useProvider(provider: providers.CacheProvider) {
  const config = JSON.parse(readFileSync(join(root, '.stim.json'), 'utf8'));
  config.cache = { provider: './test-provider.mjs' };
  write(join(root, '.stim.json'), JSON.stringify(config));
  return vi.spyOn(providers, 'loadCacheProvider').mockResolvedValue({ provider, name: 'file-fixture' });
}
const build = (buildCache = true, abi: 'x86_64' | 'all' = 'x86_64') =>
  buildAndroidOperation(testContext(), root, { variant: 'freeRelease', abi, remoteBuild: 'local', buildCache });

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
  duringInspection = () => {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setExecutor(
    makeExecutor({
      runFile(file, args = []) {
        if (file === 'git' && args.includes('--show-toplevel')) return repository;
        if (file === 'git' && args.includes('ls-files')) return `${visible.join('\0')}\0`;
        if (file === 'cp') {
          const from = args.at(-2),
            to = args.at(-1);
          assert(from && to);
          cpSync(from, to);
          return '';
        }
        throw new Error(`Unexpected command ${file}`);
      },
      runFileAsync: async (file, args = []) => {
        if (file === 'git' && args.includes('--show-toplevel')) return repository;
        if (file === 'git' && args.includes('ls-files')) return `${visible.join('\0')}\0`;
        if (file === 'cp') {
          const from = args.at(-2),
            to = args.at(-1);
          assert(from && to);
          cpSync(from, to);
          return '';
        }
        const filePath = args.at(-1);
        assert(filePath);
        const apk = JSON.parse(readFileSync(filePath, 'utf8'));
        if (file.endsWith(androidBuildToolName('apksigner'))) {
          duringInspection(filePath);
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
    const modelArg = request.projectArgs?.find((arg) => arg.startsWith('-Pstim.native.model='));
    assert(modelArg);
    const model = modelArg.slice('-Pstim.native.model='.length);
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
    assert(request.locate);
    const located = await request.locate();
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
  const planner = nativeAndroidProject(root).plan;
  assert(planner);
  const plan = await planner({ variant: 'freeRelease' }, resolveProjectSettings(root), testContext());
  const allAbi = await nativeGradleArtifactSnapshot(root, declaration, selected, null, process.env);
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

test.each(['source', 'signing', 'environment', 'debug-keystore', 'jdk', 'sdk', 'gradle-init'] as const)(
  '%s changes invalidate native APK reuse',
  async (input) => {
    const first = await build();
    if (input === 'source') write(join(root, 'app/src/Main.kt'), 'edited');
    if (input === 'signing') write(join(directory, 'signing/key'), 'private-key-two');
    if (input === 'environment') vi.stubEnv('STIM_FIXTURE_SIGNING', 'changed-password');
    if (input === 'debug-keystore') write(join(directory, 'home/.android/debug.keystore'), 'new-default-key');
    if (input === 'gradle-init') write(join(directory, 'gradle/init.d/custom.gradle'), 'changed initialization');
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

test('generated outputs do not change the key, and private inputs never authorize source transfers', async () => {
  const before = await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env);
  write(join(root, 'app/build/new.bin'), 'generated');
  expect(await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env)).toEqual(before);
  const transfer = await nativeGradleTransfer(root, { complete: true, ignored: [], outputs: ['app/build'] });
  expect(transfer.files.some((file) => file.path.includes('signing'))).toBe(false);
  expect(JSON.stringify({ before, transfer })).not.toContain('private-password');
  expect(JSON.stringify({ before, transfer })).not.toContain('private-key-one');
  await expect(nativeGradleTransfer(root, declaration)).rejects.toThrow('android.offloadInputs');
});

test.each([
  { before: Buffer.from([0xe9]), after: Buffer.from([0xf1]) },
  { before: Buffer.from('one\n'), after: Buffer.from('one\r\n') },
])(
  'private local properties and absent declared files affect only the local artifact identity (case=%j)',
  async ({ before: initial, after: changed }) => {
    visible.push('local.properties');
    const prefix = Buffer.from(`sdk.dir=${propertyValue(sdk)}\nprivate.key=`);
    writeFileSync(join(root, 'local.properties'), Buffer.concat([prefix, initial]));
    const value = { ...declaration, localFiles: [...declaration.localFiles, '../optional-key'] };
    const before = await nativeGradleArtifactSnapshot(root, value, selected, 'x86_64', process.env);
    writeFileSync(join(root, 'local.properties'), Buffer.concat([prefix, changed]));
    const edited = await nativeGradleArtifactSnapshot(root, value, selected, 'x86_64', process.env);
    expect(edited.hash).not.toBe(before.hash);
    write(join(directory, 'optional-key'), 'created');
    expect((await nativeGradleArtifactSnapshot(root, value, selected, 'x86_64', process.env)).hash).not.toBe(
      edited.hash,
    );
    await expect(nativeGradleTransfer(root, { complete: true, ignored: [], outputs: ['app/build'] })).rejects.toThrow(
      'unsupported machine-local properties',
    );
  },
);

test('local.properties stays local when the project is reached through a linked path', async () => {
  visible.push('local.properties');
  writeFileSync(join(root, 'local.properties'), `sdk.dir=${propertyValue(sdk)}\nprivate.key=one\n`);
  const linked = join(directory, 'linked');
  symlinkSync(root, linked, 'junction');
  const direct = await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env);
  expect(await nativeGradleArtifactSnapshot(linked, declaration, selected, 'x86_64', process.env)).toEqual(direct);
});

test('inputs changed during compilation never publish a cache entry', async () => {
  const files = providers.createFilesystemFileCache(join(directory, 'shared-files'));
  const upload = vi.spyOn(files, 'store');
  useProvider({ files });
  duringBuild = () => write(join(directory, 'signing/key'), `changed-${generations}`);
  const first = await build();
  const second = await build();
  expect(first).toMatchObject({ cacheHit: false, cacheKey: null });
  expect(second).toMatchObject({ cacheHit: false, cacheKey: null });
  expect(existsSync(join(directory, 'cache'))).toBe(false);
  expect(upload).not.toHaveBeenCalled();
  expect(generations).toBe(2);
});

test('cache-off runs compile twice without artifact lookup, publication or shared-build waiting', async () => {
  const files = providers.createFilesystemFileCache(join(directory, 'shared-files'));
  const load = useProvider({ files });
  const config = JSON.parse(readFileSync(join(root, '.stim.json'), 'utf8'));
  config.optimizations.buildCache = false;
  write(join(root, '.stim.json'), JSON.stringify(config));
  const lookup = vi.spyOn(cache, 'resolveBuild');
  const wait = vi.spyOn(locks, 'waitForSharedBuild');
  for (const result of [await build(), await build()])
    expect(result).toMatchObject({ cacheHit: false, cacheSkipped: true });
  expect(lookup).not.toHaveBeenCalled();
  expect(wait).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(existsSync(join(directory, 'cache'))).toBe(false);
  expect(generations).toBe(2);
});

test('the build-cache bypass flag refreshes the native APK without reading or waiting for the old entry', async () => {
  const files = providers.createFilesystemFileCache(join(directory, 'shared-files'));
  useProvider({ files });
  const first = await build();
  const download = vi.spyOn(files, 'resolve');
  const upload = vi.spyOn(files, 'store');
  const lookup = vi.spyOn(cache, 'resolveBuild');
  const wait = vi.spyOn(locks, 'waitForSharedBuild');
  const refreshed = await build(false);
  expect(refreshed).toMatchObject({ cacheHit: false, cacheSkipped: true, cacheKey: first.cacheKey });
  expect(download).not.toHaveBeenCalled();
  expect(upload).toHaveBeenCalledOnce();
  expect(lookup).not.toHaveBeenCalled();
  expect(wait).not.toHaveBeenCalled();
  assert(first.cacheKey);
  const stored = cache.artifactIn(cache.entryDir('android', first.cacheKey));
  assert(stored);
  expect(JSON.parse(readFileSync(stored, 'utf8'))).toHaveProperty('generation', 2);
  expect(await build()).toMatchObject({ cacheHit: 'local', cacheKey: first.cacheKey });
  expect(generations).toBe(2);
});

test('native APK sharing skips providers without opaque files instead of using their bare build capability', async () => {
  const resolve = vi.fn<providers.BuildCacheCapability['resolve']>(async () => null);
  const store = vi.fn<providers.BuildCacheCapability['store']>(async () => {});
  useProvider({ builds: { resolve, store } });
  expect((await build()).cacheHit).toBe(false);
  expect((await build()).cacheHit).toBe('local');
  expect(resolve).not.toHaveBeenCalled();
  expect(store).not.toHaveBeenCalled();
});

test('a file provider restores a verified native APK into a cold local cache without Gradle', async () => {
  const files = providers.createFilesystemFileCache(join(directory, 'shared-files'));
  useProvider({ files });
  const first = await build();
  expect(first.cacheHit).toBe(false);
  vi.stubEnv('STIM_BUILD_CACHE', join(directory, 'cold-cache'));
  const restored = await build();
  expect(restored).toMatchObject({ cacheHit: 'remote', cacheKey: first.cacheKey, androidPackage: 'org.example.free' });
  expect(generations).toBe(1);
  const local = await build();
  expect(local).toMatchObject({ cacheHit: 'local', cacheKey: first.cacheKey, androidPackage: 'org.example.free' });
  expect(readFileSync(local.apkPath)).toEqual(readFileSync(first.apkPath));
  expect(generations).toBe(1);
});

test.each(['header', 'truncated', 'payload'] as const)(
  'a corrupt shared APK %s is discarded before local publication',
  async (invalid) => {
    const files = providers.createFilesystemFileCache(join(directory, 'shared-files'));
    useProvider({ files });
    const first = await build();
    const resolve = files.resolve.bind(files);
    vi.spyOn(files, 'resolve').mockImplementation(async (input) => {
      const path = await resolve(input);
      assert(path);
      const bytes = readFileSync(path);
      if (invalid === 'header') bytes[0] = 0;
      else if (invalid === 'payload') bytes[bytes.length - 1] = bytes.at(-1) === 0 ? 1 : 0;
      writeFileSync(path, invalid === 'truncated' ? bytes.subarray(0, 5) : bytes);
      return path;
    });
    vi.stubEnv('STIM_BUILD_CACHE', join(directory, 'cold-cache'));
    expect(await build()).toMatchObject({ cacheHit: false, cacheKey: first.cacheKey });
    expect(generations).toBe(2);
    expect(readdirSync(cache.providerDownloadPath(workspaceDir(root)))).toEqual([]);
  },
);

test('a valid shared entry for another input key cannot backfill the requested key', async () => {
  const files = providers.createFilesystemFileCache(join(directory, 'shared-files'));
  const upload = vi.spyOn(files, 'store');
  useProvider({ files });
  const first = await build();
  write(join(root, 'app/src/Main.kt'), 'other-source');
  await build();
  const alternate = upload.mock.calls.at(-1)?.[0].key;
  assert(alternate);
  write(join(root, 'app/src/Main.kt'), 'source');
  const resolve = files.resolve.bind(files);
  vi.spyOn(files, 'resolve').mockImplementation((input) => resolve({ ...input, key: alternate }));
  vi.stubEnv('STIM_BUILD_CACHE', join(directory, 'cold-cache'));
  const result = await build();
  expect(result).toMatchObject({ cacheHit: false, cacheKey: first.cacheKey });
  expect(JSON.parse(readFileSync(result.apkPath, 'utf8')).generation).toBe(3);
  expect(readdirSync(cache.providerDownloadPath(workspaceDir(root)))).toEqual([]);
});

test('a provider path outside its download directory is refused without deleting that file', async () => {
  const files = providers.createFilesystemFileCache(join(directory, 'shared-files'));
  useProvider({ files });
  const first = await build();
  vi.spyOn(files, 'resolve').mockResolvedValue(first.apkPath);
  vi.stubEnv('STIM_BUILD_CACHE', join(directory, 'cold-cache'));
  expect((await build()).cacheHit).toBe(false);
  expect(generations).toBe(2);
  expect(JSON.parse(readFileSync(first.apkPath, 'utf8')).generation).toBe(1);
  expect(readdirSync(cache.providerDownloadPath(workspaceDir(root)))).toEqual([]);
});

test('cancelling a shared download removes its staging and does not start Gradle', async () => {
  const files = providers.createFilesystemFileCache(join(directory, 'shared-files'));
  useProvider({ files });
  await build();
  const controller = new AbortController();
  const resolve = files.resolve.bind(files);
  vi.spyOn(files, 'resolve').mockImplementation(async (input) => {
    const path = await resolve(input);
    controller.abort();
    return path;
  });
  vi.stubEnv('STIM_BUILD_CACHE', join(directory, 'cold-cache'));
  await expect(
    buildAndroidOperation(testContext({ signal: controller.signal }), root, {
      variant: 'freeRelease',
      abi: 'x86_64',
      remoteBuild: 'local',
    }),
  ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  expect(generations).toBe(1);
  expect(readdirSync(cache.providerDownloadPath(workspaceDir(root)))).toEqual([]);
});

test('cancelling a shared upload removes its complete-file staging and preserves the local APK', async () => {
  const files = providers.createFilesystemFileCache(join(directory, 'shared-files'));
  const controller = new AbortController();
  let uploaded: string | undefined;
  vi.spyOn(files, 'store').mockImplementation(async ({ sourcePath, signal }) => {
    uploaded = sourcePath;
    expect(existsSync(sourcePath)).toBe(true);
    controller.abort();
    signal.throwIfAborted();
  });
  useProvider({ files });
  await expect(
    buildAndroidOperation(testContext({ signal: controller.signal }), root, {
      variant: 'freeRelease',
      abi: 'x86_64',
      remoteBuild: 'local',
    }),
  ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  assert(uploaded);
  expect(existsSync(dirname(uploaded))).toBe(false);
  expect((await build()).cacheHit).toBe('local');
  expect(generations).toBe(1);
});

test.each(['bytes', 'package', 'abi', 'signature'] as const)(
  'a cached APK with invalid %s is rebuilt',
  async (invalid) => {
    const first = await build();
    assert(first.cacheKey);
    const stored = cache.artifactIn(cache.entryDir('android', first.cacheKey));
    assert(stored);
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

test('a local directory cannot be declared as one exact private file', async () => {
  await expect(
    nativeGradleArtifactSnapshot(root, { ...declaration, localFiles: ['../signing'] }, selected, 'x86_64', process.env),
  ).rejects.toThrow('exact regular files');
  expect(() => gradleArtifactInputs({ ...declaration, ignored: ['../outside'] })).toThrow('android.artifactInputs');
});

test('identical declared contents keep their key across checkout and toolchain locations', async () => {
  visible.push('local.properties');
  write(join(root, 'local.properties'), `sdk.dir=${propertyValue(sdk)}`);
  const first = await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env);
  const peer = join(directory, 'peer');
  for (const name of ['project', 'sdk', 'jdk', 'signing'])
    cpSync(join(directory, name), join(peer, name), { recursive: true });
  repository = join(peer, 'project');
  write(join(repository, 'local.properties'), `sdk.dir=${propertyValue(join(peer, 'sdk'))}`);
  const env = {
    ...process.env,
    HOME: join(peer, 'home'),
    USERPROFILE: join(peer, 'home'),
    JAVA_HOME: join(peer, 'jdk'),
    ANDROID_HOME: join(peer, 'sdk'),
    ANDROID_USER_HOME: join(peer, 'home', '.android'),
    GRADLE_USER_HOME: join(peer, 'gradle'),
  };
  const second = await nativeGradleArtifactSnapshot(repository, declaration, selected, 'x86_64', env);
  expect(second.hash).toBe(first.hash);
  expect(second.key).toBe(first.key);
  expect(second.sdkDirectory).not.toBe(first.sdkDirectory);
});

test('cancelled input reads are not accepted as an uncached build identity', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

test.each(['plain', 'uppercase-unicode', 'non-property-whitespace'])(
  'a local SDK override cannot reuse the ANDROID_HOME artifact identity (%s)',
  async (syntax) => {
    write(join(root, 'local.properties'), `sdk.dir=${propertyValue(sdk)}`);
    const first = await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env);
    const other = join(directory, syntax === 'uppercase-unicode' ? 'U0073dk' : 'other-sdk');
    mkdirSync(dirname(other), { recursive: true });
    cpSync(sdk, other, { recursive: true });
    const value =
      syntax === 'uppercase-unicode'
        ? propertyValue(other).replace('U0073dk', `${String.fromCharCode(92)}U0073dk`)
        : syntax === 'non-property-whitespace'
          ? `\v${propertyValue(sdk)}`
          : propertyValue(other);
    write(join(root, 'local.properties'), `sdk.dir=${value}`);
    await expect(nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env)).rejects.toThrow(
      /SDK|ENOENT/,
    );
    expect(first.key).toEqual(expect.any(String));
  },
);

test('an APK changed during signature inspection is rebuilt instead of reused', async () => {
  await build();
  duringInspection = (path) => {
    duringInspection = () => {};
    const apk = JSON.parse(readFileSync(path, 'utf8'));
    write(path, JSON.stringify({ ...apk, generation: 999 }));
  };
  const next = await build();
  expect(next.cacheHit).toBe(false);
  expect(generations).toBe(2);
});

test.each(['sdk with space', 'escaped-sdk' + String.fromCharCode(92) + 'user'])(
  'SDK values with Java property escapes retain the same toolchain identity (%s)',
  async (name) => {
    visible.push('local.properties');
    write(join(root, 'local.properties'), `sdk.dir=${propertyValue(sdk)}`);
    const first = await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env);
    const other = join(directory, name);
    mkdirSync(dirname(other), { recursive: true });
    cpSync(sdk, other, { recursive: true });
    const escape = String.fromCharCode(92);
    for (const value of [
      propertyValue(other).replace('/', `${escape}u002f`),
      propertyValue(other).replaceAll(' ', `${escape} `),
    ]) {
      write(join(root, 'local.properties'), `sdk.dir=${value}`);
      const next = await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', {
        ...process.env,
        ANDROID_HOME: other,
      });
      expect(next.key).toBe(first.key);
    }
  },
);

test.each(['sdk\\.dir=ignored', 'sdk.dir=one\\\ntwo'])(
  'ambiguous SDK property syntax disables cache eligibility: %s',
  async (line) => {
    write(join(root, 'local.properties'), line);
    await expect(nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env)).rejects.toThrow(
      'local.properties',
    );
  },
);

test('local buildSrc sources affect identity without authorizing their offload', async () => {
  write(join(root, 'buildSrc/build.gradle.kts'), 'plugins { `java-library` }');
  visible.push('buildSrc/build.gradle.kts');
  const first = await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env);
  write(join(root, 'buildSrc/build.gradle.kts'), 'plugins { `java-library` }; version = "2"');
  const next = await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env);
  expect(next.key).not.toBe(first.key);
  await expect(nativeGradleTransfer(root, { complete: true, ignored: [], outputs: ['app/build'] })).rejects.toThrow(
    'buildSrc',
  );
});

test('ordinary files beside installed SDK versions do not disable native artifact caching', async () => {
  const before = await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env);
  write(join(sdk, 'ndk', '.DS_Store'), 'finder metadata');
  write(join(sdk, 'build-tools', '.DS_Store'), 'finder metadata');
  expect(await nativeGradleArtifactSnapshot(root, declaration, selected, 'x86_64', process.env)).toEqual(before);
});

test.each([
  { bootPending: true, variant: 'debug' },
  { bootPending: false, variant: 'debug' },
  { bootPending: false, variant: 'freeRelease' },
])('planning honors explicit emulator image replacement (case=%j)', async ({ bootPending, variant }) => {
  const devices = await import('../devices/android.ts');
  const arm = { api: 35, tag: 'google_apis', arch: 'arm64-v8a', pkg: 'system-images;android-35;google_apis;arm64-v8a' };
  const x86 = { ...arm, arch: 'x86_64', pkg: 'system-images;android-35;google_apis;x86_64' };
  vi.spyOn(devices, 'listInstalledSystemImages').mockReturnValue([arm, x86]);
  vi.spyOn(devices, 'ownedAvdDirectory').mockReturnValue(join(directory, 'avd'));
  vi.spyOn(devices, 'ownedAvdSystemImage').mockReturnValue(arm.pkg);
  vi.spyOn(devices, 'ownedAvdDeviceProfile').mockReturnValue('pixel_7');
  vi.spyOn(devices, 'listAvdDeviceProfiles').mockReturnValue(['pixel_7', 'pixel_9']);
  upsertProject(root, { platforms: { android: { owned: true, avdName: 'stim-fixture', bootPending } } });
  const before = getProject(root);
  const planner = nativeAndroidProject(root).plan;
  assert(planner);
  const result = await planner(
    { variant, systemImage: x86.pkg, deviceProfile: 'pixel_9' },
    resolveProjectSettings(root),
    testContext(),
  );
  const expected = bootPending
    ? {
        platform: 'android',
        cacheKey: (
          await nativeGradleArtifactSnapshot(root, declaration, { ...selected, variant }, 'x86_64', process.env)
        ).key,
      }
    : { refusal: { code: 'STIM_BAD_ARG' } };
  expect(result).toMatchObject(expected);
  expect(getProject(root)).toEqual(before);
});

test.each([
  { source: 'flag', variant: 'debug' },
  { source: 'setting', variant: 'freeRelease' },
])('planning refuses an existing emulator profile mismatch (case=%j)', async ({ source, variant }) => {
  const devices = await import('../devices/android.ts');
  vi.spyOn(devices, 'ownedAvdDirectory').mockReturnValue(join(directory, 'avd'));
  vi.spyOn(devices, 'ownedAvdSystemImage').mockReturnValue('system-images;android-35;google_apis;arm64-v8a');
  vi.spyOn(devices, 'ownedAvdDeviceProfile').mockReturnValue('pixel_7');
  vi.spyOn(devices, 'listAvdDeviceProfiles').mockReturnValue(['pixel_7', 'pixel_9']);
  upsertProject(root, { platforms: { android: { owned: true, avdName: 'stim-fixture' } } });
  if (source === 'setting') {
    const config = JSON.parse(readFileSync(join(root, '.stim.json'), 'utf8'));
    config.android.deviceProfile = 'pixel_9';
    write(join(root, '.stim.json'), JSON.stringify(config));
  }
  const before = getProject(root);
  const planner = nativeAndroidProject(root).plan;
  assert(planner);
  const result = await planner(
    { variant, ...(source === 'flag' ? { deviceProfile: 'pixel_9' } : {}) },
    resolveProjectSettings(root),
    testContext(),
  );
  expect(result).toMatchObject({
    refusal: { code: 'STIM_BAD_ARG', message: expect.stringContaining('device profile') },
  });
  expect(getProject(root)).toEqual(before);
});

test.each(['different-ABI', 'unknown-ABI'])(
  'planning refuses an unresolved legacy emulator assignment (%s)',
  async (kind) => {
    const devices = await import('../devices/android.ts');
    const images = ['arm64-v8a', 'x86_64'].map((arch) => ({
      api: 35,
      tag: 'google_apis',
      arch,
      pkg: `system-images;android-35;google_apis;${arch}`,
    }));
    vi.spyOn(devices, 'listInstalledSystemImages').mockReturnValue(images);
    const otherAbi = devices.hostSystemImageArch() === 'arm64-v8a' ? 'x86_64' : 'arm64-v8a';
    upsertProject(root, {
      platforms: {
        android: {
          avdName: 'legacy-fixture',
          owned: false,
          ...(kind === 'different-ABI' ? { systemImage: `system-images;android-35;google_apis;${otherAbi}` } : {}),
        },
      },
    });
    const before = getProject(root);
    const planner = nativeAndroidProject(root).plan;
    assert(planner);
    const result = await planner({ variant: 'debug' }, resolveProjectSettings(root), testContext());
    expect(result).toMatchObject({ refusal: { code: 'STIM_BAD_ARG', message: expect.stringContaining('legacy') } });
    expect(getProject(root)).toEqual(before);
  },
);
