import assert from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveAndroidBuildPlan,
  resolveAndroidRunPlan,
  type AndroidPlanInputs,
  type AndroidPlanDependencies,
} from '../commands/android/plan.ts';
import { androidAvdConfigSettingError } from '../workspace/settings.ts';

import { planAndroid, type AndroidPlanOptions } from '../commands/android/next-build.ts';
import type { AndroidPlanDeps } from '../integrations/react-native-android-plan.ts';
import { reactNativeAndroidProject } from '../integrations/react-native-android.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { buildCacheKey } from '../cache/build-cache.ts';
import { getProject, upsertProject } from '../workspace/config.ts';
import { hostSystemImageArch } from '../devices/android.ts';
import { readProductFlavors } from '../integrations/react-native-build.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-android-plan-'));
  process.env.STIM_HOME = join(root, 'state');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function inputs(overrides: Partial<AndroidPlanInputs> = {}): AndroidPlanInputs {
  return {
    settings: {},
    settingsContext: { projectPath: root, gitCommonDir: null, repoRoot: null },
    slot: 'default',
    variant: null,
    systemImage: null,
    device: null,
    wait: undefined,
    waitConflict: false,
    remote: null,
    buildCache: true,
    ...overrides,
  };
}

function inspection(events: string[]): AndroidPlanDependencies {
  return {
    runtimeKind: ({ release }) => (release ? 'embedded-js' : 'metro'),
    warn: (label) => events.push(`warning:${label}`),
    parkedLimit: () => {
      events.push('pool');
      return { max: 0, error: null };
    },
    resolveCompilerCache: ({ optimizations }) => {
      events.push('compiler');
      return { cas: null, optimizations, warning: 'compiler warning' };
    },
    resolveCacheProvider: () => {
      events.push('provider');
      return null;
    },
    validateAvdConfig: (settings, projectPath) => {
      events.push('avd');
      return androidAvdConfigSettingError(settings, projectPath);
    },
    readFlavors: (projectPath) => {
      events.push('flavors');
      return readProductFlavors(projectPath);
    },
    detectExpo: () => {
      events.push('expo');
      return false;
    },
    listSystemImages: () => {
      events.push('images');
      return [{ api: 36, tag: 'google_apis', arch: 'arm64-v8a', pkg: 'installed-image' }];
    },
    listDeviceProfiles: () => {
      events.push('profiles');
      return ['pixel_6', 'pixel_fold', '7.6in Foldable'];
    },
  };
}

test('build planning refuses a custom Gradle layout on an Expo app and passes it to the compiler cache', () => {
  mkdirSync(join(root, 'native', 'app'), { recursive: true });
  writeFileSync(join(root, 'native', 'settings.gradle'), '');
  writeFileSync(join(root, 'native', 'app', 'build.gradle'), '');
  const settings = { android: { gradleRoot: 'native' } };
  const refused = resolveAndroidBuildPlan(inputs({ settings }), {
    ...inspection([]),
    variantProblem: () => null,
    detectExpo: () => true,
  });
  assert(!refused.ok);
  expect(refused).toMatchObject({
    code: 'STIM_BAD_ARG',
    message: expect.stringContaining('bare React Native apps only'),
  });

  const layouts: unknown[] = [];
  const planned = resolveAndroidBuildPlan(inputs({ settings }), {
    ...inspection([]),
    variantProblem: () => null,
    detectExpo: () => false,
    resolveCompilerCache: ({ optimizations, layout }) => {
      layouts.push(layout);
      return { cas: null, optimizations, warning: null };
    },
  });
  assert(planned.ok);
  expect(layouts).toEqual([expect.objectContaining({ gradleRoot: realpathSync(join(root, 'native')), custom: true })]);
});

describe('planAndroid', () => {
  const HASH = 'f'.repeat(40);
  const ARM = { api: 36, tag: 'google_apis', arch: 'arm64-v8a', pkg: 'system-images;android-36;google_apis;arm64-v8a' };
  const X86 = { api: 35, tag: 'google_apis', arch: 'x86_64', pkg: 'system-images;android-35;google_apis;x86_64' };
  let app: string;

  beforeEach(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'stim-android-next-')));
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '0.81.0' } }),
    );
  });

  afterEach(() => {
    rmSync(app, { recursive: true, force: true });
  });

  async function plan(opts: AndroidPlanOptions, deps: Partial<AndroidPlanDeps> = {}) {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (line) => logs.push(String(line));
    console.error = () => {};
    let exitCode: typeof process.exitCode;
    try {
      await planAndroid(
        { json: true, ...opts },
        {
          findRoot: () => app,
          projectRegistry: {
            selectAndroid(path) {
              const selected = projectRegistry.selectAndroid(path);
              return 'problem' in selected
                ? selected
                : {
                    id: selected.id,
                    load: async (resolved) =>
                      reactNativeAndroidProject(path, resolved, {
                        plan: {
                          fingerprint: async () => ({ hash: HASH, sources: [] }),
                          listSystemImages: () => [ARM, X86],
                          avdSystemImage: () => null,
                          avdDirectory: () => null,
                          listAvds: () => [],
                          loadProjectProvider: async () => ({ none: true }),
                          planPrebuild: () => 'none',
                          ...deps,
                        },
                      }),
                  };
            },
          },
        },
      );
    } finally {
      exitCode = process.exitCode;
      console.log = origLog;
      console.error = origErr;
      process.exitCode = previousExitCode;
    }
    assert.equal(logs.length, 1);
    return { payload: JSON.parse(logs[0]!), exitCode };
  }

  test('a recorded AVD that no longer exists keys by the image a new emulator would use', async () => {
    upsertProject(app, { platforms: { android: { avdName: 'stim-fixture', owned: true } } });
    const { payload } = await plan({ systemImage: X86.pkg }, { avdSystemImage: () => ARM.pkg });
    expect(payload.cacheKey).toBe(buildCacheKey('android', HASH, { variant: 'debug', abi: 'x86_64' }));
  });

  test.each([
    { variant: 'debug', remote: undefined },
    { variant: 'release', remote: undefined },
    { variant: 'debug', remote: 'auto' },
  ])('an explicit --system-image refuses to replace an AVD that finished a boot (%j)', async ({ variant, remote }) => {
    if (remote) writeFileSync(join(app, '.stim.json'), JSON.stringify({ android: { remote } }));
    upsertProject(app, { platforms: { android: { avdName: 'stim-fixture', owned: true } } });
    const before = getProject(app);
    const { payload, exitCode } = await plan(
      { systemImage: X86.pkg, variant },
      { avdDirectory: () => join(app, 'avd'), avdSystemImage: () => ARM.pkg },
    );
    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({ code: 'STIM_BAD_ARG', message: expect.stringContaining('never finished a boot') });
    expect(getProject(app)).toEqual(before);
  });

  test('with no installed system image and android.installImages never, the plan refuses with the install command', async () => {
    writeFileSync(join(app, '.stim.json'), JSON.stringify({ android: { installImages: 'never' } }));
    const { payload, exitCode } = await plan({}, { listSystemImages: () => [] });
    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({ code: 'STIM_NO_DEVICE', remedy: expect.stringContaining('sdkmanager') });
  });

  test('--device refuses because a plan does not choose a device', async () => {
    const { payload, exitCode } = await plan({ device: 'emulator-5554' });
    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({ code: 'STIM_BAD_ARG', message: expect.stringContaining('--device') });
  });
});

describe('a profile the emulator gates on foldable image support', () => {
  const arch = hostSystemImageArch();
  const image = (api: number, tag = 'google_apis') => ({
    api,
    tag,
    arch,
    pkg: `system-images;android-${api};${tag};${arch}`,
  });
  const foldable = new Set([image(34).pkg]);
  const plan = async (
    overrides: Partial<AndroidPlanInputs>,
    {
      images = [image(30), image(33), image(34)],
      owned = null as ReturnType<NonNullable<AndroidPlanDependencies['ownedAvd']>>,
    } = {},
  ) =>
    resolveAndroidRunPlan(inputs(overrides), {
      ...inspection([]),
      listSystemImages: () => images,
      listDeviceProfiles: () => ['pixel_6', 'pixel_fold', 'resizable', '7.6in Foldable'],
      supportsFold: (pkg) => foldable.has(pkg),
      ownedAvd: () => owned,
    });

  test("checks the slot's existing AVD instead of the default image unless --system-image names one", async () => {
    const owned = { avdName: 'stim-app-fold', systemImage: image(30).pkg, deviceProfile: 'pixel_fold' };
    const refused = await plan({}, { owned });
    assert(!refused.ok);
    expect(refused.message).toContain(`emulator stim-app-fold uses device profile pixel_fold on ${image(30).pkg}`);
    expect(refused.remedy).toMatch(/replaces stim-app-fold if that emulator never finished a boot.*--slot <name>/);
    expect((await plan({ systemImage: image(34).pkg }, { owned })).ok).toBe(true);
    expect(await plan({ systemImage: image(30).pkg }, { owned })).toMatchObject({
      ok: false,
      message: expect.stringContaining('emulator stim-app-fold'),
    });
    expect((await plan({ deviceProfile: 'pixel_6' }, { owned })).ok).toBe(true);
    expect((await plan({}, { owned: { ...owned, systemImage: image(34).pkg } })).ok).toBe(true);
  });
});
