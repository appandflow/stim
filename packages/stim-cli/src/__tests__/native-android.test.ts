import { testContext } from './_context.ts';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { readBuildHistory } from '@stim-cli/core/state';
import { dirname, join } from 'node:path';
import * as selection from '../offload/selection.ts';
import * as offload from '../offload/client.ts';
import * as gradleEngine from '../engine/gradle.ts';
import { buildAndroidOperation } from '../commands/android/build.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { nativeAndroidDoctor, nativeAndroidProject, selectNativeApk } from '../integrations/native-android.ts';
import * as artifactInputs from '../integrations/native-gradle-artifact-inputs.ts';
import { writeNativeXcodeProject } from './_native-xcode-project.ts';
import { makeExecutor } from './_factories.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

let root: string;
function write(path: string, value = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
function gradle(dir: string) {
  write(join(dir, 'settings.gradle.kts'), 'include(":mobile")');
  write(join(dir, 'gradlew'));
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-android-')));
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

test('native discovery requires a wrapper and settings, accepts tooling packages and preserves RN ownership', () => {
  write(join(root, 'settings.gradle.kts'));
  expect(projectRegistry.findProjectRoot(root)).toBeNull();
  gradle(root);
  write(join(root, 'package.json'), JSON.stringify({ name: 'tooling' }));
  expect(projectRegistry.projectProblem(root, 'android')).toBeNull();
  expect(
    projectRegistry.detectPlatforms(root, {
      context: { projectPath: root, gitCommonDir: null, repoRoot: null },
      settings: {},
    }),
  ).toEqual(['android']);
  expect(projectRegistry.selectAndroid(root)).toHaveProperty('load');
  expect(projectRegistry.projectProblem(root, 'ios')).not.toBeNull();
  expect(projectRegistry.projectProblem(root, 'dev-server')).not.toBeNull();
  const rn = join(root, 'rn');
  write(join(rn, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
  gradle(join(rn, 'android'));
  expect(projectRegistry.findProjectRoot(join(rn, 'android'))).toBe(rn);
  expect(projectRegistry.projectProblem(join(rn, 'android'), 'android')?.message).toContain(
    `belongs to the project at ${rn}`,
  );
  gradle(rn);
  expect(projectRegistry.projectProblem(rn, 'android')).toBeNull();
  const independent = join(rn, 'apps', 'native');
  gradle(independent);
  expect(projectRegistry.findProjectRoot(independent)).toBe(independent);
  symlinkSync(independent, join(root, 'alias'), 'junction');
  expect(projectRegistry.findProjectRoot(join(root, 'alias'))).toBe(independent);
});

test('an unreadable relevant package manifest remains a refusal', () => {
  gradle(root);
  write(join(root, 'package.json'), '{');
  expect(projectRegistry.projectProblem(root, 'android')?.kind).toBe('unreadable');
});

function model(elements: unknown[]) {
  return {
    schema: 1,
    module: ':mobile',
    variant: 'freeDebug',
    applicationId: 'org.example.free',
    sdkDirectory: root,
    elements,
  };
}
function apk(name: string, filters: { type: string; value: string }[] = []) {
  return { path: join(root, name), filters };
}
const abi = (value: string) => [{ type: 'ABI', value }];

test('APK selection uses exact model variant and unique universal or target ABI output', () => {
  const outputs = [apk('arm.apk', abi('arm64-v8a')), apk('x86.apk', abi('x86_64'))];
  expect(selectNativeApk(model(outputs), 'freeDebug', 'x86_64')).toEqual({
    apkPath: join(root, 'x86.apk'),
    androidPackage: 'org.example.free',
  });
  expect(selectNativeApk(model([...outputs, apk('universal.apk')]), 'freeDebug', null)).toEqual({
    apkPath: join(root, 'universal.apk'),
    androidPackage: 'org.example.free',
  });
  expect(selectNativeApk(model(outputs), 'freeDebug', null)).toHaveProperty('code', 'STIM_BUILD_FAILED');
  expect(selectNativeApk(model(outputs), 'paidDebug', 'x86_64')).toHaveProperty('code', 'STIM_BUILD_FAILED');
});

test('APK selection refuses missing, ambiguous or unsupported outputs', () => {
  for (const elements of [
    [],
    [apk('one.apk'), apk('two.apk')],
    [apk('density.apk', [{ type: 'DENSITY', value: 'xxxhdpi' }])],
    [apk('arm.apk', abi('arm64-v8a'))],
    [{ path: '../outside.apk', filters: [] }],
  ])
    expect(selectNativeApk(model(elements), 'freeDebug', 'x86_64')).toHaveProperty('code', 'STIM_BUILD_FAILED');
});

test('native plan and doctor never execute Gradle or probe a dev server', async () => {
  const external = vi.fn<() => never>(() => {
    throw new Error('read-only native inspection executed a tool');
  });
  setExecutor(
    makeExecutor({
      run: external,
      runFile: external,
      runFileAsync: external,
      spawn: external,
      runQuiet: external,
      runFileQuiet: (file) => (file === 'git' ? null : external()),
      findExecutable: external,
    }),
  );
  const project = nativeAndroidProject(root);
  const result = await project.plan!(
    { variant: 'freeDebug' },
    { context: { projectPath: root, gitCommonDir: null, repoRoot: null }, settings: {} },
    testContext(),
  );
  expect(result).toMatchObject({ refusal: { code: 'STIM_BAD_ARG' } });
  const findings = await nativeAndroidDoctor(root).inspect({
    root,
    options: {},
    settings: {},
    repoRoot: null,
    optimizations: null,
    platforms: ['android'],
  });
  expect(findings.some((finding) => finding.detail.includes('one application module'))).toBe(true);
  expect(findings.some((finding) => /node_modules|Metro is not|Podfile/.test(finding.detail))).toBe(false);
  expect(external).not.toHaveBeenCalled();
});

test('the registered native Android provider retains build-only APKs without claiming artifact reuse or changing a runtime', async () => {
  gradle(root);
  writeNativeXcodeProject(root);
  vi.stubEnv('STIM_HOME', join(root, 'state'));
  vi.stubEnv('STIM_BUILD_CACHE', join(root, 'cache'));
  write(
    join(root, '.stim.json'),
    JSON.stringify({ optimizations: { releaseBundleSwap: false, android: { compilerCache: 'none' } } }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setExecutor(makeExecutor());
  const compiled = join(root, 'output.apk');
  let generation = 0;
  vi.spyOn(gradleEngine, 'buildGradle').mockImplementation(async ({ variant }) => {
    generation++;
    write(compiled, `${variant}:${generation}`);
    return {
      ok: true,
      apkPath: compiled,
      androidPackage: 'org.example.native',
      apkNote: null,
      durationMs: 1,
      lastLines: [],
    };
  });
  const existing = { serial: 'existing-device', devicePlacement: { machine: 'paired-host' } };
  writeWorkspaceState(root, { android: existing });
  const options = { variant: 'release', abi: 'x86_64', remoteBuild: 'local' } as const;
  const first = await buildAndroidOperation(testContext(), root, options);
  rmSync(compiled);
  expect(readFileSync(first.apkPath, 'utf8')).toBe('release:1');
  const second = await buildAndroidOperation(testContext(), root, options);
  for (const result of [first, second])
    expect(result).toMatchObject({ cacheHit: false, cacheSkipped: true, cacheKey: null });
  expect(generation).toBe(2);
  rmSync(compiled);
  expect(existsSync(first.apkPath)).toBe(false);
  expect(readFileSync(second.apkPath, 'utf8')).toBe('release:2');
  expect(readWorkspaceState(root)?.android).toEqual(existing);
  expect(readWorkspaceState(root)).not.toHaveProperty('supervisor');
});

function uncachedOffloadProject(selected: string) {
  gradle(root);
  vi.stubEnv('STIM_HOME', join(root, 'state'));
  vi.stubEnv('STIM_BUILD_CACHE', join(root, 'cache'));
  write(
    join(root, '.stim.json'),
    JSON.stringify({
      android: { offloadInputs: { complete: true, ignored: [], outputs: ['build'] } },
      optimizations: { android: { compilerCache: 'none' } },
    }),
  );
  setExecutor(
    makeExecutor({
      runFile: (program, args = []) => {
        if (program === 'git' && args.includes('--show-toplevel')) return root;
        if (program === 'git' && args.includes('ls-files')) return '.stim.json\0settings.gradle.kts\0gradlew\0';
        return '';
      },
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(selection, 'resolveBuildPlacement').mockReturnValue({ selected });
  vi.spyOn(offload, 'buildPlacementCandidates').mockReturnValue({
    localEnabled: true,
    machines: [{ machine: 'worker' }],
  } as ReturnType<typeof offload.buildPlacementCandidates>);
  vi.spyOn(offload, 'chooseBuildMachine').mockResolvedValue({
    machine: 'worker',
    offer: { capacity: { loadPerCore: 0.1 } },
  } as Awaited<ReturnType<typeof offload.chooseBuildMachine>>);
  vi.spyOn(offload, 'closeOffload').mockImplementation(() => {});
}

test.each([false, true])('a named native target refusal preserves cancellation=%s', async (cancelled) => {
  uncachedOffloadProject('worker');
  write(join(root, 'buildSrc', 'build.gradle.kts'), 'source');
  const controller = new AbortController();
  vi.spyOn(offload, 'offloadCheck').mockImplementation((_root, targets) => async () => {
    if (cancelled) controller.abort('SIGINT');
    await targets();
    return { capacity: null, problems: [] };
  });
  const local = vi.spyOn(gradleEngine, 'buildGradle');
  await expect(
    buildAndroidOperation(testContext({ signal: controller.signal }), root, {
      variant: 'freeRelease',
      abi: 'x86_64',
      remoteBuild: 'worker',
    }),
  ).rejects.toMatchObject({
    code: cancelled ? 'STIM_CANCELLED' : 'STIM_OFFLOAD_REFUSED',
    message: expect.stringContaining(cancelled ? 'cancelled' : 'buildSrc'),
  });
  expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
});

test.each([
  { cancelled: false, eligible: false, cached: false },
  { cancelled: true, eligible: false, cached: false },
  { cancelled: false, eligible: true, cached: false },
  { cancelled: false, eligible: false, cached: true },
])('an offloaded APK never uses the caller key and is released (case=%j)', async ({ cancelled, eligible, cached }) => {
  uncachedOffloadProject(cached ? 'auto' : 'worker');
  if (cached)
    vi.spyOn(offload, 'offloadPlacement').mockReturnValue({
      offload: false,
      code: 'this-mac-free',
      reason: 'this machine has a free slot',
    });
  if (eligible)
    vi.spyOn(artifactInputs, 'nativeGradleArtifactSnapshot').mockResolvedValue({
      hash: 'caller-fingerprint',
      key: 'caller-key',
      sdkDirectory: root,
      receipt: {
        source: 'a'.repeat(64),
        declaration: { complete: true, ignored: [], outputs: [], localFiles: [], environment: [] },
        build: { variant: 'debug', compilerCache: 'none', gradleBuildCache: true, pch: 'auto', cas: null },
        abi: null,
      },
    });
  const local = vi.spyOn(gradleEngine, 'buildGradle');
  let staging = '';
  const remote = vi
    .spyOn(offload, 'offloadBuild')
    .mockImplementation(async ({ stagingDir, expectedFingerprint, request }) => {
      expect(expectedFingerprint).toBeNull();
      expect(request.platform).toBe('android');
      staging = stagingDir;
      const artifactPath = join(stagingDir, 'native.apk');
      write(artifactPath, 'verified worker artifact');
      if (cancelled) throw Object.assign(new Error('cancelled worker transfer'), { code: 'STIM_CANCELLED' });
      return {
        ok: true,
        ...(cached ? { cacheHit: true } : {}),
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
  let failure: unknown;
  const result = await buildAndroidOperation(testContext(), root, {
    variant: 'freeRelease',
    abi: 'x86_64',
    remoteBuild: 'worker',
  }).catch((error) => {
    failure = error;
    return null;
  });
  const cancellation = expect.objectContaining({ code: 'STIM_CANCELLED' });
  expect(failure).toEqual(cancelled ? cancellation : undefined);
  expect(existsSync(staging)).toBe(false);
  expect(remote).toHaveBeenCalledOnce();
  expect(local).not.toHaveBeenCalled();
  expect(vi.mocked(offload.chooseBuildMachine).mock.calls[0]?.[0]).toMatchObject({
    cacheOnly: cached,
    gradleArtifact: {
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      inputs: { complete: true, ignored: [], outputs: ['build'] },
      android: { variant: 'freeRelease', abi: 'x86_64' },
    },
  });
  if (!result) return;
  expect(result).toMatchObject({
    androidPackage: 'org.example.worker',
    cacheKey: null,
    cacheSkipped: !cached,
    cacheHit: cached ? 'remote' : false,
    builtOn: 'worker',
  });
  expect(readFileSync(result.apkPath, 'utf8')).toBe('verified worker artifact');
  expect(readBuildHistory(readWorkspaceState(root)).android?.[0]).toMatchObject({
    status: 'ok',
    cacheKey: null,
    cacheSkipped: !cached,
    cacheHit: cached ? 'remote' : false,
    builtOn: 'worker',
  });
});

test.each(['offer-miss', 'fetch-miss'] as const)(
  'a cache-only Gradle %s compiles locally without an offload failure',
  async (scenario) => {
    uncachedOffloadProject('auto');
    vi.spyOn(offload, 'offloadPlacement').mockReturnValue({
      offload: false,
      code: 'this-mac-free',
      reason: 'local has room',
    });
    if (scenario === 'offer-miss')
      vi.mocked(offload.chooseBuildMachine).mockResolvedValue('worker: no matching completed artifact');
    const remote = vi
      .spyOn(offload, 'offloadBuild')
      .mockResolvedValue({ ok: false, machine: 'worker', reason: 'artifact disappeared' });
    const compiled = join(root, 'output.apk');
    vi.spyOn(gradleEngine, 'buildGradle').mockImplementation(async () => {
      write(compiled, 'local build');
      return {
        ok: true,
        apkPath: compiled,
        androidPackage: 'org.example.native',
        apkNote: null,
        durationMs: 1,
        lastLines: [],
      };
    });
    const result = await buildAndroidOperation(testContext(), root, {
      variant: 'freeRelease',
      abi: 'x86_64',
      remoteBuild: 'auto',
    });
    expect(result).toMatchObject({ builtOn: 'here', cacheHit: false });
    expect(remote).toHaveBeenCalledTimes(scenario === 'fetch-miss' ? 1 : 0);
    expect(readBuildHistory(readWorkspaceState(root)).android?.[0]?.offloadFallback).toBeFalsy();
  },
);

test('a local fallback after a failed uncached offload leaves the staging path to later offloads', async () => {
  uncachedOffloadProject('auto');
  let staging = '';
  const remote = vi.spyOn(offload, 'offloadBuild').mockImplementation(async ({ stagingDir }) => {
    staging = stagingDir;
    write(join(stagingDir, 'native.apk'), 'unverified worker artifact');
    return { ok: false, machine: 'worker', reason: 'the worker lost the build' };
  });
  const compiled = join(root, 'output.apk');
  vi.spyOn(gradleEngine, 'buildGradle').mockImplementation(async () => {
    write(join(staging, 'later-offload.apk'), 'another offload');
    write(compiled, 'local build');
    return {
      ok: true,
      apkPath: compiled,
      androidPackage: 'org.example.native',
      apkNote: null,
      durationMs: 1,
      lastLines: [],
    };
  });
  const result = await buildAndroidOperation(testContext(), root, {
    variant: 'freeRelease',
    abi: 'x86_64',
    remoteBuild: 'auto',
  });
  expect(remote).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ builtOn: 'here' });
  expect(readFileSync(join(staging, 'later-offload.apk'), 'utf8')).toBe('another offload');
});
