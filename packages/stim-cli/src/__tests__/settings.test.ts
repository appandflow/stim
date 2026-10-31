import assert from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  androidAvdConfigSetting,
  cacheProviderSettingError,
  androidAvdConfigSettingError,
  androidLayoutSettingError,
  iosProjectDirSettingError,
  iosSigningIdentitySetting,
  iosSigningIdentitySettingError,
  iosSigningIdentitySha1Setting,
  iosSigningIdentitySha1SettingError,
  iosSimSlimProfileSetting,
  metroCommandSettingError,
  parseAndroidAvdConfigIni,
  resolveCacheProviderConfig,
  resolveSettings,
  settingShapeErrors,
  settingValueAt,
  deviceReclaimIdleMinutesSetting,
  unknownSettingKeys,
} from '../workspace/settings.ts';
import { saveConfig, writeConfigSetting, type Config } from '../workspace/config.ts';
import { SETTINGS } from '@stim-cli/core/state';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('a __proto__ key in a committed .stim.json sets no effective setting', () => {
  writeFileSync(
    join(tmpHome, '.stim.json'),
    '{ "__proto__": { "ios": { "remote": "eas" } }, "ios": { "deviceType": "iPhone 17" } }',
  );
  const merged = resolveSettings({ repoRoot: tmpHome });
  expect(settingValueAt(merged, 'ios.remote')).toBeUndefined();
  expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  expect(merged.ios).toEqual({ deviceType: 'iPhone 17' });
});

describe('iOS SimSlim profile settings', () => {
  test('rejects invalid paths, missing profiles, and symlink escapes', () => {
    const outside = mkdtempSync(join(tmpdir(), 'stim-simslim-outside-'));
    try {
      writeFileSync(join(outside, 'profile.json'), '{}\n');
      symlinkSync(join(outside, 'profile.json'), join(tmpHome, 'linked.json'));
      for (const path of ['', '../profile.json', join(outside, 'profile.json'), 'missing.json', 'linked.json']) {
        expect(() => iosSimSlimProfileSetting({ ios: { simslimProfile: path } }, tmpHome)).toThrow(
          /ios\.simslimProfile/,
        );
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('Android AVD config settings', () => {
  test('reads a repository-contained INI fragment and applies inline overrides on top', () => {
    writeFileSync(join(tmpHome, 'android-avd.ini'), 'hw.ramSize=3072\nhw.keyboard=no\n');
    expect(
      androidAvdConfigSetting(
        {
          android: {
            avdConfigFile: 'android-avd.ini',
            avdConfig: { 'hw.keyboard': true, 'vm.heapSize': 512 },
          },
        },
        tmpHome,
      ),
    ).toEqual({ 'hw.ramSize': '3072', 'hw.keyboard': 'yes', 'vm.heapSize': '512' });
  });

  test('parses comments and values containing equals, and rejects malformed or duplicate lines', () => {
    expect(parseAndroidAvdConfigIni('# device\n; local\nhw.keyboard=true\nruntime.network.speed=5g\n')).toEqual({
      'hw.keyboard': 'yes',
      'runtime.network.speed': '5g',
    });
    expect(() => parseAndroidAvdConfigIni('[hardware]\n')).toThrow(/line 1.*key=value/);
    expect(() => parseAndroidAvdConfigIni('hw.keyboard=yes\nhw.keyboard=no\n')).toThrow(/duplicate key/);
  });

  test.each([
    ['hw.ramSize', 1024],
    ['hw.cpu.ncore', 0],
    ['hw.keyboard', 'on'],
    ['hw.gpu.mode', 'swiftshader_indirect'],
    ['runtime.network.speed', 'unlimited'],
  ])('rejects invalid value %p for %s', (key, value) => {
    expect(androidAvdConfigSettingError({ android: { avdConfig: { [key]: value } } }, tmpHome)).toMatch(
      /Invalid android\.avdConfig value/,
    );
  });

  test('rejects non-scalar and line-injecting inline values', () => {
    expect(androidAvdConfigSettingError({ android: { avdConfig: { 'hw.keyboard': ['yes'] } } }, tmpHome)).toMatch(
      /Invalid android\.avdConfig value/,
    );
    expect(
      androidAvdConfigSettingError(
        { android: { avdConfig: { 'hw.keyboard': 'yes\ndisk.dataPartition.path=/tmp/outside' } } },
        tmpHome,
      ),
    ).toMatch(/expected one line/);
  });

  test('rejects absolute paths, traversal, symlink escapes, and oversized fragments', () => {
    const outside = mkdtempSync(join(tmpdir(), 'stim-outside-'));
    try {
      writeFileSync(join(outside, 'outside.ini'), 'hw.keyboard=yes\n');
      symlinkSync(join(outside, 'outside.ini'), join(tmpHome, 'linked.ini'));
      writeFileSync(join(tmpHome, 'large.ini'), `#${'x'.repeat(64 * 1024)}\n`);
      for (const path of [join(outside, 'outside.ini'), '../outside.ini', 'linked.ini', 'large.ini']) {
        expect(androidAvdConfigSettingError({ android: { avdConfigFile: path } }, tmpHome)).toBeTruthy();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('a committed android.deviceProfile must be an avdmanager id, so cmd.exe metacharacters never reach avdmanager.bat', () => {
  for (const deviceProfile of [
    '',
    'pixel_6',
    'Nexus 5X',
    'tv_1080p',
    '3.2in HVGA slider (ADP1)',
    '10.1in WXGA (Tablet)',
  ])
    expect(settingShapeErrors({ android: { deviceProfile } })).toEqual([]);
  for (const deviceProfile of ['pixel_6"&calc&"', 'pixel_6&calc', '%PATH%', 'pixel_6\ncalc'])
    expect(settingShapeErrors({ android: { deviceProfile } })).toEqual([
      `Invalid android.deviceProfile setting ${JSON.stringify(deviceProfile)}. Expected an avdmanager device id such as pixel_6 or Nexus 5X (\`avdmanager list device -c\`).`,
    ]);
});

function nestedSetting(path: string, value: unknown): Record<string, unknown> {
  return path
    .split('.')
    .toReversed()
    .reduce<Record<string, unknown>>((inner, key) => ({ [key]: inner }), value as Record<string, unknown>);
}

const SHAPE_CASES: Record<string, { valid: unknown; invalid: unknown; expected: string }> = {
  'macos.product': { valid: 'MyApp', invalid: {}, expected: 'a string' },
  'macos.artifactInputs': { valid: { complete: true }, invalid: [], expected: 'an object' },
  'macos.infoPlist': { valid: 'Support/Info-Development.plist', invalid: {}, expected: 'a string path' },
  'macos.assetCatalog': { valid: 'Support/Assets.xcassets', invalid: {}, expected: 'a string path' },
  'macos.resources': { valid: { 'AppIcon.icns': 'Support/AppIcon-Dev.icns' }, invalid: [], expected: 'an object' },
  'macos.arguments': { valid: ['--playground'], invalid: ['--playground', 7], expected: 'an array of strings' },
  'ios.deviceType': { valid: 'iPhone 17 Pro', invalid: {}, expected: 'a string' },
  'ios.runtime': { valid: '26.2', invalid: 26.2, expected: 'a string' },
  'ios.configuration': { valid: 'Release', invalid: { name: 'Release' }, expected: 'a string' },
  'ios.scheme': { valid: 'RNTester', invalid: ['RNTester'], expected: 'a string' },
  'ios.remote': { valid: 'mini', invalid: true, expected: 'a string' },
  'macos.remote': {
    valid: 'remote-only',
    invalid: 'bad name',
    expected: 'local, auto, remote, remote-only, or a tailnet machine name (macOS has no eas or proxy backend)',
  },
  'ios.projectPath': { valid: '.', invalid: {}, expected: 'a string path' },
  'ios.simslim': { valid: 'on', invalid: true, expected: 'one of: on, off' },
  'ios.simslimProfile': { valid: '.simslim/dev.json', invalid: {}, expected: 'a string path' },
  'ios.signingIdentity': { valid: 'Apple Development: Jane', invalid: [], expected: 'a string' },
  'ios.signingIdentitySha1': { valid: 'A'.repeat(40), invalid: 42, expected: 'a string' },
  'ios.lanHost': { valid: '192.168.1.42', invalid: {}, expected: 'a string' },
  'android.systemImage': { valid: 'system-images;android-36;google_apis;arm64-v8a', invalid: {}, expected: 'a string' },
  'android.deviceProfile': { valid: 'pixel_fold', invalid: 7, expected: 'a string' },
  'android.installImages': { valid: 'never', invalid: 'always', expected: 'one of: auto, never' },
  'android.dataPartitionSizeGb': { valid: 8, invalid: '8', expected: 'a number' },
  'android.avdConfigFile': { valid: 'avd/config.ini', invalid: {}, expected: 'a string path' },
  'android.avdConfig': { valid: { 'hw.ramSize': 4096 }, invalid: 'hw.ramSize=4096', expected: 'an object' },
  'android.gradleRoot': { valid: '../..', invalid: {}, expected: 'a string path' },
  'android.module': {
    valid: ':packages:rn-tester:android:app',
    invalid: {},
    expected: 'a string',
  },
  'android.variant': { valid: 'productionDebug', invalid: {}, expected: 'a string' },
  'android.artifactInputs': {
    valid: {
      complete: true,
      ignored: [],
      outputs: ['app/build'],
      localFiles: ['../signing/key'],
      environment: ['SIGNING_PASSWORD'],
    },
    invalid: [],
    expected: 'an object',
  },
  'android.offloadInputs': {
    valid: { complete: true, ignored: [], outputs: ['app/build'] },
    invalid: [],
    expected: 'an object',
  },
  'android.keystore': { valid: 'android/app/release.keystore', invalid: {}, expected: 'a string path' },
  'android.keystorePassword': { valid: 'env:MY_KS_PASS', invalid: 1234, expected: 'a string' },
  'android.remote': {
    valid: 'mini:7443',
    invalid: 'bad name',
    expected: 'eas, proxy, local, auto, remote, remote-only, or a tailnet machine name',
  },
  'metro.tunnel': {
    valid: 'tailscale',
    invalid: 'bogus',
    expected: 'one of: auto, off, expo, cloudflared, ngrok, tailscale',
  },
  'maintenance.keep': { valid: true, invalid: 'yes', expected: 'true or false' },
  'maintenance.idleStopHours': { valid: 0.5, invalid: -1, expected: 'a number, 0 or more' },
  'metro.idleStopMinutes': { valid: 30, invalid: '30', expected: 'a whole number, 0 or more' },
  'devices.reclaimIdleMinutes': { valid: 10, invalid: 1.5, expected: 'a whole number, 0 or more' },
  'devices.idleShutdownMinutes': { valid: 30, invalid: 1.5, expected: 'a whole number, 0 or more' },
  'metro.command': {
    valid: ['npx', 'react-native', 'start', '--port', '{port}'],
    invalid: ['npx', 7],
    expected: 'an array of strings',
  },
  'metro.ngrokUrl': { valid: 'https://a.ngrok.app', invalid: {}, expected: 'a string' },
  'metro.publicUrl': { valid: 'https://metro.example', invalid: false, expected: 'a string' },
  'metro.port': { valid: 25062, invalid: '25062', expected: 'a whole number from 1024 through 65535' },
  'web.url': { valid: 'http://localhost:{port:web}/', invalid: 8080, expected: 'a string' },
  'web.ignoreCertificateErrors': { valid: true, invalid: 'yes', expected: 'true or false' },
  'web.viewport': { valid: 'phone', invalid: 'tablet', expected: 'one of: desktop, phone' },
  'metro.warmupUrl': { valid: {}, invalid: '/index.bundle', expected: 'an object' },
  'metro.warmupUrl.ios': {
    valid: '/custom.bundle?platform=ios&dev=true',
    invalid: false,
    expected: 'an HTTP(S) URL or /path ending in .bundle with a matching platform query and no fragment',
  },
  'metro.warmupUrl.android': {
    valid: 'https://metro.example/custom.bundle?platform=android&dev=true',
    invalid: false,
    expected: 'an HTTP(S) URL or /path ending in .bundle with a matching platform query and no fragment',
  },
  'archive.enabled': { valid: false, invalid: 'false', expected: 'true or false' },
  'remote.easFallback': { valid: true, invalid: 'yes', expected: 'true or false' },
  'worktree.exclude': { valid: ['node_modules'], invalid: ['ok', 7], expected: 'an array of strings' },
  'worktree.defaultBranch': { valid: 'main', invalid: ['main'], expected: 'a string' },
  'cache.provider': { valid: './cache.cjs', invalid: {}, expected: 'a string' },
  'cache.options': { valid: { bucket: 'a' }, invalid: 'nope', expected: 'an object' },
};

test('every known setting has a shape, and a wrong-typed value is one refusal naming the key and the shape', () => {
  const known = [
    ...SETTINGS.filter(
      (setting) => setting.scopes.includes('committed') && !setting.key.startsWith('optimizations.'),
    ).map((setting) => setting.key),
    'metro.warmupUrl',
  ];
  expect(Object.keys(SHAPE_CASES).toSorted()).toEqual(known.toSorted());

  for (const key of known) {
    const shapeCase = SHAPE_CASES[key];
    assert(shapeCase);
    expect(settingShapeErrors(nestedSetting(key, shapeCase.invalid))).toEqual([
      `Invalid ${key} setting ${JSON.stringify(shapeCase.invalid)}. Expected ${shapeCase.expected}.`,
    ]);
    expect(settingShapeErrors(nestedSetting(key, shapeCase.valid))).toEqual([]);
    expect(unknownSettingKeys(nestedSetting(key, shapeCase.invalid))).toEqual([]);
    expect(unknownSettingKeys(nestedSetting(key, shapeCase.valid))).toEqual([]);
  }
});

test('unknownSettingKeys tolerates empty and malformed input', () => {
  expect(unknownSettingKeys({})).toEqual([]);
  expect(unknownSettingKeys(null)).toEqual([]);
  expect(unknownSettingKeys('nope')).toEqual([]);
});

describe('metroCommandSettingError', () => {
  test('refuses a command that cannot listen on the reserved port', () => {
    expect(metroCommandSettingError({ metro: { command: ['npx', 'react-native', 'start'] } })).toMatch(
      /must pass \{port\}/,
    );
  });

  test('refuses an empty argv or a blank program', () => {
    expect(metroCommandSettingError({ metro: { command: [] } })).toMatch(/non-empty array/);
    expect(metroCommandSettingError({ metro: { command: [' ', '{port}'] } })).toMatch(/non-empty array/);
  });
});

describe('iosProjectDirSetting', () => {
  let app: string;
  beforeEach(() => {
    app = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ios-path-')));
  });
  afterEach(() => {
    rmSync(app, { recursive: true, force: true });
  });

  test('refuses a path outside the app, an absolute path, and a directory with no Xcode project', () => {
    mkdirSync(join(app, 'apple'));
    expect(iosProjectDirSettingError({ ios: { projectPath: '..' } }, app)).toMatch(/escapes the app directory/);
    expect(iosProjectDirSettingError({ ios: { projectPath: app } }, app)).toMatch(/relative to the app directory/);
    expect(iosProjectDirSettingError({ ios: { projectPath: 'apple' } }, app)).toMatch(
      /no \.xcworkspace or \.xcodeproj/,
    );
  });
});

describe('androidLayoutSetting', () => {
  let repo: string;
  let app: string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'stim-android-layout-')));
    app = join(repo, 'packages', 'tester');
    mkdirSync(join(app, 'android', 'app'), { recursive: true });
    writeFileSync(join(repo, 'settings.gradle.kts'), '');
    writeFileSync(join(app, 'android', 'app', 'build.gradle.kts'), '');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  const tester = { android: { gradleRoot: '../..', module: ':packages:tester:android:app' } };

  test('refuses a root outside the repository, a root without settings, a module without a build script, and a malformed module', () => {
    expect(androidLayoutSettingError(tester, app, app)).toMatch(/resolves outside/);
    rmSync(join(repo, 'settings.gradle.kts'));
    expect(androidLayoutSettingError(tester, app, repo)).toMatch(/no settings\.gradle/);
    writeFileSync(join(repo, 'settings.gradle'), '');
    expect(androidLayoutSettingError({ android: { gradleRoot: '../..', module: ':missing' } }, app, repo)).toMatch(
      /has no build\.gradle/,
    );
    expect(androidLayoutSettingError({ android: { module: 'app' } }, app, repo)).toMatch(/Gradle project path/);
    expect(
      androidLayoutSettingError({ android: { gradleRoot: '../..', module: ':..:..:outside' } }, app, repo),
    ).toMatch(/Gradle project path/);
  });
});

test('the same provider reference resolved from another directory does not inherit its options', () => {
  writeFileSync(
    join(tmpHome, '.stim.json'),
    JSON.stringify({ cache: { provider: './cache.cjs', options: { bucket: 'team' } } }),
  );
  writeConfigSetting({ scope: 'repo', gitCommonDir: '/repo/.git' }, 'cache', {
    provider: './cache.cjs',
    options: { token: 'machine' },
  });

  expect(resolveCacheProviderConfig({ projectPath: tmpHome, gitCommonDir: '/repo/.git', repoRoot: '/repo' })).toEqual({
    provider: './cache.cjs',
    options: { token: 'machine' },
    baseDir: '/repo',
  });
});

test('cacheProviderSettingError accepts valid shapes and names invalid ones', () => {
  expect(cacheProviderSettingError({})).toBeNull();
  expect(cacheProviderSettingError({ cache: { provider: './cache.cjs', options: { bucket: 'a' } } })).toBeNull();
  expect(cacheProviderSettingError({ cache: { provider: '  ' } })).toMatch(/Invalid cache\.provider setting/);
  expect(cacheProviderSettingError({ cache: { provider: './cache.cjs', options: 'nope' } })).toMatch(
    /Invalid cache\.options setting/,
  );
  expect(cacheProviderSettingError({ cache: 'nope' })).toMatch(/Invalid cache setting/);
});

test('ios.signingIdentity reads a trimmed identity name and refuses a shape codesign cannot take', () => {
  expect(iosSigningIdentitySetting({ ios: { signingIdentity: '  Apple Development: Jane (TEAMID5678)  ' } })).toBe(
    'Apple Development: Jane (TEAMID5678)',
  );
  expect(iosSigningIdentitySetting({})).toBe(null);
  expect(iosSigningIdentitySetting({ ios: [] })).toBe(null);

  expect(iosSigningIdentitySettingError({})).toBe(null);
  expect(iosSigningIdentitySettingError({ ios: { signingIdentity: 'Apple Development: Jane' } })).toBe(null);
  expect(iosSigningIdentitySettingError({ ios: { signingIdentity: '  ' } })).toMatch(/Invalid ios\.signingIdentity/);
  expect(iosSigningIdentitySettingError({ ios: { signingIdentity: 42 } })).toMatch(/Invalid ios\.signingIdentity/);
  expect(iosSigningIdentitySettingError({ ios: { signingIdentity: 'two\nlines' } })).toMatch(
    /Invalid ios\.signingIdentity/,
  );
});

test('ios.signingIdentitySha1 takes exactly the 40-hex hash find-identity prints, upper-cased', () => {
  const sha1 = '3fe19e227ec5bc2ede3ac52ab02ff46920445c6a';
  expect(iosSigningIdentitySha1Setting({ ios: { signingIdentitySha1: ` ${sha1} ` } })).toBe(sha1.toUpperCase());
  expect(iosSigningIdentitySha1Setting({})).toBe(null);

  expect(iosSigningIdentitySha1SettingError({})).toBe(null);
  expect(iosSigningIdentitySha1SettingError({ ios: { signingIdentitySha1: sha1 } })).toBe(null);
  expect(iosSigningIdentitySha1SettingError({ ios: { signingIdentitySha1: 'ABCDEF' } })).toMatch(
    /Invalid ios\.signingIdentitySha1/,
  );
  expect(iosSigningIdentitySha1SettingError({ ios: { signingIdentitySha1: `${sha1}00` } })).toMatch(
    /Invalid ios\.signingIdentitySha1/,
  );
});

test('devices.reclaimIdleMinutes defaults to 10, an explicit 0 keeps it off, and a project layer overrides the machine', () => {
  expect(deviceReclaimIdleMinutesSetting(resolveSettings({}))).toBe(10);
  saveConfig({ version: 2, projects: {}, repos: {}, devices: { reclaimIdleMinutes: 0 } } as Config);
  expect(deviceReclaimIdleMinutesSetting(resolveSettings({}))).toBe(0);
  saveConfig({ version: 2, projects: {}, repos: {}, devices: { reclaimIdleMinutes: 45 } } as Config);
  expect(deviceReclaimIdleMinutesSetting(resolveSettings({}))).toBe(45);
  writeFileSync(join(tmpHome, '.stim.json'), JSON.stringify({ devices: { reclaimIdleMinutes: 0 } }));
  expect(deviceReclaimIdleMinutesSetting(resolveSettings({ repoRoot: tmpHome }))).toBe(0);
});
