import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveAndroidRunPlan,
  type AndroidPlanInputs,
  type AndroidPlanDependencies,
} from '../commands/android/plan.ts';
import { androidAvdConfigSettingError } from '../workspace/settings.ts';
import { readProductFlavors } from '../engine/gradle.ts';
import { planAndroid, type AndroidPlanDeps, type AndroidPlanOptions } from '../commands/android/next-build.ts';
import { buildCacheKey, entryDir } from '../cache/build-cache.ts';
import { upsertProject } from '../workspace/config.ts';
import { hostSystemImageArch } from '../devices/android.ts';

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

test('a plan binds build selectors and cache policy to the selected emulator', () => {
  const result = resolveAndroidRunPlan(
    inputs({
      settings: {
        android: { variant: 'settingDebug', systemImage: 'setting-image', deviceProfile: 'setting-profile' },
      },
      variant: ' flagRelease ',
      systemImage: ' installed-image ',
      deviceProfile: ' 7.6in Foldable ',
      buildCache: false,
    }),
    inspection([]),
  );

  assert(result.ok);
  expect(result.plan.build).toMatchObject({
    variant: 'flagRelease',
    release: true,
    cache: { read: false, write: true },
  });
  expect(result.plan.target).toEqual({
    kind: 'emulator',
    systemImage: 'installed-image',
    deviceProfile: '7.6in Foldable',
  });
});

test('a physical target overrides configured remote mode and carries its parsed lease options', () => {
  const events: string[] = [];
  const result = resolveAndroidRunPlan(
    inputs({ settings: { android: { remote: 'eas' } }, device: 'phone-serial', wait: '90' }),
    inspection(events),
  );

  assert(result.ok);
  expect(result.plan.target).toEqual({
    kind: 'physical',
    serial: 'phone-serial',
    lease: { waitSeconds: 90, noWait: false },
  });
  expect(events).not.toContain('images');
  expect(events).not.toContain('profiles');
});

test('EAS selection keeps a Debug build plan while an explicit remote flag overrides settings', () => {
  const result = resolveAndroidRunPlan(
    inputs({ settings: { android: { remote: 'eas', variant: 'storeRelease' } }, easProfile: 'qa', remote: 'proxy' }),
    inspection([]),
  );

  assert(result.ok);
  expect(result.plan.build).toMatchObject({ variant: 'debug', release: false });
  expect(result.plan.target).toEqual({ kind: 'remote', backend: 'proxy', systemImage: null, deviceProfile: null });
});

const REFUSALS: Array<{
  name: string;
  inputs: Partial<AndroidPlanInputs>;
  message: RegExp;
  events: string[];
}> = [
  {
    name: 'shape validation precedes warnings and inspection',
    inputs: { settings: { unused: true, android: { variant: {} } } },
    message: /Invalid android.variant/,
    events: ['pool'],
  },
  {
    name: 'an optimization choice outside its list refuses at shape validation',
    inputs: { settings: { unused: true, optimizations: { android: { pch: 'invalid' } } } },
    message: /^Invalid optimizations\.android\.pch setting "invalid"\. Expected one of: auto, on, off\.$/,
    events: ['pool'],
  },
  {
    name: 'data-partition refusal follows compiler and provider warnings but precedes AVD inspection',
    inputs: { settings: { cache: { provider: '' }, android: { dataPartitionSizeGb: 5 } } },
    message: /Invalid android.dataPartitionSizeGb/,
    events: ['pool', 'compiler', 'warning:cache', 'provider', 'warning:cache'],
  },
  {
    name: 'AVD validation precedes product-flavor validation',
    inputs: { settings: { android: { avdConfig: { 'image.sysdir.1': '/image' } } } },
    message: /Unsupported android.avdConfig key/,
    events: ['pool', 'compiler', 'warning:cache', 'provider', 'avd'],
  },
  {
    name: 'a remote backend outside its list refuses at shape validation',
    inputs: { settings: { unused: true, android: { remote: 'invalid' } } },
    message: /^Invalid android\.remote setting "invalid"\. Expected one of: proxy, eas\.$/,
    events: ['pool'],
  },
  {
    name: 'a lease flag conflict precedes system-image inspection',
    inputs: { device: true, wait: false, waitConflict: true, systemImage: 'installed-image' },
    message: /--wait and --no-wait ask for opposite things/,
    events: ['pool', 'compiler', 'warning:cache', 'provider', 'avd', 'flavors', 'expo'],
  },
  {
    name: 'a named remote slot refuses before system-image inspection',
    inputs: { remote: 'proxy', slot: 'second', systemImage: 'installed-image' },
    message: /Named slots currently support local simulators and physical devices/,
    events: ['pool', 'compiler', 'warning:cache', 'provider', 'avd', 'flavors', 'expo'],
  },
  {
    name: 'a device profile avdmanager does not offer refuses with the offered ids',
    inputs: { settings: { android: { deviceProfile: 'pixel_fold' } }, deviceProfile: 'pixel_folded' },
    message:
      /^No Android hardware profile is named "pixel_folded"\. Profiles avdmanager offers: pixel_6, pixel_fold, 7\.6in Foldable\.$/,
    events: ['pool', 'compiler', 'warning:cache', 'provider', 'avd', 'flavors', 'expo', 'profiles'],
  },
];

test.each(REFUSALS)('$name', ({ inputs: overrides, message, events: expected }) => {
  const events: string[] = [];
  const result = resolveAndroidRunPlan(inputs(overrides), inspection(events));

  assert(!result.ok);
  expect(result.code).toBe('STIM_BAD_ARG');
  expect(result.message).toMatch(message);
  expect(events).toEqual(expected);
});

test('a product-flavor refusal precedes Expo inspection and target/lease conflicts', () => {
  mkdirSync(join(root, 'android', 'app'), { recursive: true });
  writeFileSync(join(root, 'android', 'app', 'build.gradle'), 'android { productFlavors { free {} paid {} } }');
  const events: string[] = [];
  const result = resolveAndroidRunPlan(inputs({ device: '', waitConflict: true }), inspection(events));

  assert(!result.ok);
  expect(result.message).toMatch(/2 product flavors/);
  expect(events).toEqual(['pool', 'compiler', 'warning:cache', 'provider', 'avd', 'flavors']);
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
          fingerprint: async () => ({ hash: HASH, sources: [] }),
          listSystemImages: () => [ARM, X86],
          avdSystemImage: () => null,
          avdDirectory: () => null,
          listAvds: () => [],
          loadProjectProvider: async () => ({ none: true }),
          planPrebuild: () => 'none',
          ...deps,
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

  test('the cache key carries the ABI of the image the emulator would be created from', async () => {
    const { payload, exitCode } = await plan({ systemImage: X86.pkg });
    expect(exitCode).toBeUndefined();
    expect(payload).toMatchObject({
      platform: 'android',
      cacheKey: buildCacheKey('android', HASH, { variant: 'debug', abi: 'x86_64' }),
      cacheHit: false,
      outcome: 'cold',
    });
    expect(existsSync(join(root, 'state'))).toBe(false);
  });

  test("a recorded AVD's own image decides the key, and a stored APK under it is a local hit", async () => {
    upsertProject(app, { platforms: { android: { avdName: 'stim-fixture', owned: true } } });
    const key = buildCacheKey('android', HASH, { variant: 'debug', abi: 'x86_64' });
    mkdirSync(entryDir('android', key), { recursive: true });
    writeFileSync(join(entryDir('android', key), 'app-debug.apk'), 'apk');

    const { payload } = await plan({}, { avdDirectory: () => join(app, 'avd'), avdSystemImage: () => X86.pkg });
    expect(payload).toMatchObject({ cacheKey: key, cacheHit: 'local', outcome: 'hit', prebuild: null });
  });

  test('a recorded AVD whose image cannot be read keys without an ABI, as the reusing run does', async () => {
    upsertProject(app, { platforms: { android: { avdName: 'stim-fixture', owned: true } } });
    const { payload } = await plan({}, { avdDirectory: () => join(app, 'avd'), avdSystemImage: () => null });
    expect(payload.cacheKey).toBe(buildCacheKey('android', HASH, { variant: 'debug' }));
  });

  test('a recorded AVD that no longer exists keys by the image a new emulator would use', async () => {
    upsertProject(app, { platforms: { android: { avdName: 'stim-fixture', owned: true } } });
    const { payload } = await plan({ systemImage: X86.pkg }, { avdSystemImage: () => ARM.pkg });
    expect(payload.cacheKey).toBe(buildCacheKey('android', HASH, { variant: 'debug', abi: 'x86_64' }));
  });

  test('no installed system image refuses, because the ABI in the key is unknown', async () => {
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
  const plan = (
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

  test('refuses pixel_fold on the default image when it lacks the feature, naming an installed one that has it', () => {
    const result = plan({ deviceProfile: 'pixel_fold' }, { images: [image(30), image(34), image(35)] });
    assert(!result.ok);
    expect(result.code).toBe('STIM_BAD_ARG');
    expect(result.message).toContain(`pixel_fold with system image ${image(35).pkg}`);
    expect(result.remedy).toContain(`--system-image "${image(34).pkg}"`);
  });

  test('refuses resizable on an explicit image without the feature, whatever its API level', () => {
    const result = plan({ deviceProfile: 'resizable', systemImage: image(33).pkg });
    assert(!result.ok);
    expect(result.remedy).toContain(image(34).pkg);
  });

  test('accepts pixel_fold on an image with the feature and a hinged generic profile on an old image', () => {
    expect(plan({ deviceProfile: 'pixel_fold', systemImage: image(34).pkg }).ok).toBe(true);
    expect(plan({ deviceProfile: '7.6in Foldable', systemImage: image(30).pkg }).ok).toBe(true);
  });

  test('without an installed image that has the feature, the remedy is an sdkmanager install', () => {
    const result = plan({ deviceProfile: 'pixel_fold' }, { images: [image(30), image(33)] });
    assert(!result.ok);
    expect(result.remedy).toContain(`sdkmanager "system-images;android-36;google_apis;${arch}"`);
  });

  test("checks the slot's existing AVD instead of the default image unless --system-image names one", () => {
    const owned = { avdName: 'stim-app-fold', systemImage: image(30).pkg, deviceProfile: 'pixel_fold' };
    const refused = plan({}, { owned });
    assert(!refused.ok);
    expect(refused.message).toContain(`emulator stim-app-fold uses device profile pixel_fold on ${image(30).pkg}`);
    expect(refused.remedy).toMatch(/replaces stim-app-fold if that emulator never finished a boot.*--slot <name>/);
    expect(plan({ systemImage: image(34).pkg }, { owned }).ok).toBe(true);
    expect(plan({ systemImage: image(30).pkg }, { owned })).toMatchObject({
      ok: false,
      message: expect.stringContaining('emulator stim-app-fold'),
    });
    expect(plan({ deviceProfile: 'pixel_6' }, { owned }).ok).toBe(true);
    expect(plan({}, { owned: { ...owned, systemImage: image(34).pkg } }).ok).toBe(true);
  });
});
