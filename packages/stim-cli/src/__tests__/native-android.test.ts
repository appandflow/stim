import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as gradleEngine from '../engine/gradle.ts';
import { buildAndroidOperation } from '../commands/android/build.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { nativeAndroidDoctor, nativeAndroidProject, selectNativeApk } from '../integrations/native-android.ts';
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
  expect(projectRegistry.detectPlatforms(root, {})).toEqual(['android']);
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
      runFileQuiet: external,
      findExecutable: external,
    }),
  );
  const project = nativeAndroidProject(root);
  const result = await project.plan!({ variant: 'freeDebug' });
  expect(result).toMatchObject({ refusal: { code: 'STIM_BAD_ARG' } });
  const findings = nativeAndroidDoctor(root).inspect({
    root,
    options: {},
    settings: {},
    optimizations: null,
    platforms: ['android'],
  });
  expect(findings.some((finding) => finding.detail.includes('one application module'))).toBe(true);
  expect(findings.some((finding) => /node_modules|Metro is not|Podfile/.test(finding.detail))).toBe(false);
  expect(project.targets).toEqual(['emulator', 'physical']);
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
  const first = await buildAndroidOperation(root, options);
  const second = await buildAndroidOperation(root, options);
  for (const result of [first, second])
    expect(result).toMatchObject({ cacheHit: false, cacheSkipped: true, cacheKey: null });
  expect(generation).toBe(2);
  rmSync(compiled);
  expect(readFileSync(first.apkPath, 'utf8')).toBe('release:1');
  expect(readFileSync(second.apkPath, 'utf8')).toBe('release:2');
  expect(readWorkspaceState(root)?.android).toEqual(existing);
  expect(readWorkspaceState(root)).not.toHaveProperty('supervisor');
});
