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
  };
}

test('a plan binds build selectors and cache policy to the selected emulator', () => {
  const result = resolveAndroidRunPlan(
    inputs({
      settings: { android: { variant: 'settingDebug', systemImage: 'setting-image' } },
      variant: ' flagRelease ',
      systemImage: ' installed-image ',
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
  expect(result.plan.target).toEqual({ kind: 'emulator', systemImage: 'installed-image' });
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
});

test('EAS selection keeps a Debug build plan while an explicit remote flag overrides settings', () => {
  const result = resolveAndroidRunPlan(
    inputs({ settings: { android: { remote: 'eas', variant: 'storeRelease' } }, easProfile: 'qa', remote: 'proxy' }),
    inspection([]),
  );

  assert(result.ok);
  expect(result.plan.build).toMatchObject({ variant: 'debug', release: false });
  expect(result.plan.target).toEqual({ kind: 'remote', backend: 'proxy', systemImage: null });
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
