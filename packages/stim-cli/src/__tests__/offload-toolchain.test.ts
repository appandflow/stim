import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { podEnvForRubyAsync, readRubyVersion } from '../engine/deps.ts';
import {
  androidToolchainAsync,
  jdkCandidates,
  jdkHomes,
  useJdkMajor,
  iosToolchainAsync,
  macosToolchainAsync,
  workerToolchain,
} from '../offload/toolchain.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';

let root: string;

function executable(bin: string, name: string, body: string): void {
  mkdirSync(bin, { recursive: true });
  const file = join(bin, name);
  writeFileSync(file, '#!' + process.execPath + '\n' + body + '\n');
  chmodSync(file, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-pod-toolchain-'));
  const bin = join(root, 'bin');
  executable(bin, 'xcodebuild', "console.log(process.env.GEM_HOME ? 'Wrong Ruby environment' : 'Xcode 27.0');");
  executable(bin, 'xcrun', "console.log('27.0');");
  const pod = (version: string) =>
    "if (!process.env.LANG?.endsWith('UTF-8') || !process.env.LC_ALL?.endsWith('UTF-8')) process.exit(1); console.log(" +
    JSON.stringify(version) +
    ');';
  executable(
    bin,
    'pod',
    "if (!process.env.LANG?.endsWith('UTF-8')) process.exit(1); console.log(process.env.GEM_HOME === " +
      JSON.stringify(join(root, 'login-gems')) +
      " ? '1.17.0' : '1.16.2');",
  );
  executable(
    root,
    'login-shell',
    "require('node:fs').writeFileSync(process.argv[5], 'banner\\n@@ruby-env-begin@@\\nPATH=' + process.env.PATH + '\\nGEM_HOME=' + " +
      JSON.stringify(join(root, 'login-gems')) +
      " + '\\nGEM_PATH=' + " +
      JSON.stringify(join(root, 'login-gems')) +
      " + '\\n@@ruby-env-end@@');",
  );
  vi.stubEnv('SHELL', join(root, 'login-shell'));
  executable(join(root, '.rvm', 'rubies', 'ruby-3.3.4', 'bin'), 'pod', pod('1.16.2'));
  mkdirSync(join(root, '.rvm', 'gems', 'ruby-3.3.4'), { recursive: true });
  vi.stubEnv('HOME', root);
  vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
  vi.stubEnv('GEM_HOME', undefined);
  vi.stubEnv('GEM_PATH', undefined);
  vi.stubEnv('LANG', undefined);
  vi.stubEnv('LC_ALL', undefined);
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== 'darwin')(
  'the CocoaPods comparison follows the project Ruby while Xcode keeps the machine environment',
  async () => {
    writeFileSync(join(root, '.ruby-version'), 'ruby-3.3.4\n');
    expect(await iosToolchainAsync(root, root)).toMatchObject({
      cocoapods: '1.16.2',
      xcode: 'Xcode 27.0',
      simulatorSdk: '27.0',
    });
  },
);

test.skipIf(process.platform !== 'darwin')(
  'without a project Ruby the probe and pod install both use the login shell gems',
  async () => {
    expect((await iosToolchainAsync(root, root)).cocoapods).toBe('1.17.0');
    writeFileSync(join(root, '.ruby-version'), '3.2.0\n');
    const probed = (await iosToolchainAsync(root, root)).cocoapods;
    const built = execFileSync(join(root, 'bin', 'pod'), ['--version'], {
      env: await podEnvForRubyAsync(readRubyVersion(root)),
      encoding: 'utf-8',
    }).trim();
    expect(probed).toBe('1.17.0');
    expect(built).toBe(probed);
  },
);

test.skipIf(process.platform !== 'darwin')('an unreadable login shell keeps the caller environment', async () => {
  vi.stubEnv('SHELL', join(root, 'missing-shell'));
  expect((await iosToolchainAsync(root, root)).cocoapods).toBe('1.16.2');
});

test.skipIf(process.platform !== 'darwin')(
  'the CocoaPods comparison reads the version pod install runs in the iOS directory',
  async () => {
    const ios = join(root, 'ios');
    mkdirSync(ios);
    executable(
      join(root, 'bin'),
      'pod',
      `console.log(process.cwd() === require('node:fs').realpathSync(${JSON.stringify(ios)}) ? '1.16.2' : '1.17.0');`,
    );
    expect((await iosToolchainAsync(root, ios)).cocoapods).toBe('1.16.2');

    writeFileSync(join(ios, 'Gemfile'), "gem 'cocoapods', '1.15.2'\n");
    writeFileSync(join(ios, 'Gemfile.lock'), 'GEM\n  specs:\n    cocoapods (1.15.2)\n');
    expect((await iosToolchainAsync(root, ios)).cocoapods).toBe('1.15.2');
  },
);

test('native Xcode discovery preserves required facts without invoking unrelated platform or Ruby tools', async () => {
  const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
  const sdk = join(root, 'android-sdk');
  for (const folder of ['platforms/android-37', 'ndk/28', 'build-tools/37'])
    mkdirSync(join(sdk, folder), { recursive: true });
  const jdk = join(root, 'jdk');
  mkdirSync(jdk);
  writeFileSync(join(jdk, 'release'), 'JAVA_VERSION="17.0.20"\n');
  vi.stubEnv('JAVA_HOME', jdk);
  vi.stubEnv('ANDROID_HOME', sdk);
  let native = true;
  const probe = (file: string, args: string[] = []) => {
    if (file === 'xcodebuild') return 'Xcode 27.0';
    if (file === 'xcrun' && args[0] === 'simctl')
      return JSON.stringify({
        devices: {
          [runtime]: [
            {
              name: 'stim-worker (iPhone 17)',
              isAvailable: true,
              deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
            },
          ],
        },
      });
    if (file === 'xcrun' && args[1] === 'iphonesimulator') return '27.0';
    if (native) throw new Error(`Native Xcode discovery invoked unrelated ${file} ${args.join(' ')}`);
    if (file === 'xcrun' && args[1] === 'macosx') return '26.6';
    if (file === 'pod') return '1.16.2';
    if (file === 'bundle') return 'Bundler version 2.6.0';
    throw new Error(`Unexpected probe ${file} ${args.join(' ')}`);
  };
  setExecutor(makeExecutor({ runFileQuiet: probe, runFileAsync: async (file, args) => probe(file, args) }));
  expect(await iosToolchainAsync(root, null)).toMatchObject({
    xcode: 'Xcode 27.0',
    simulatorSdk: '27.0',
    cocoapods: null,
  });
  expect(workerToolchain(null, 'xcode')).toMatchObject({
    xcode: 'Xcode 27.0',
    simulatorSdk: '27.0',
    runtimes: [runtime],
    cocoapods: null,
    bundler: null,
    macosSdk: null,
    jdk: null,
    androidSdk: null,
  });
  native = false;
  expect(workerToolchain()).toMatchObject({
    xcode: 'Xcode 27.0',
    simulatorSdk: '27.0',
    runtimes: [runtime],
    cocoapods: '1.16.2',
    bundler: 'Bundler version 2.6.0',
    macosSdk: '26.6',
    jdk: '17',
    androidSdk: { ndk: ['28'], buildTools: ['37'], platforms: ['android-37'] },
  });
});

test.skipIf(process.platform !== 'darwin')('async native Xcode comparison skips Ruby and CocoaPods', async () => {
  const marker = join(root, 'ruby-invoked');
  const body = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked'); process.exit(1);`;
  executable(join(root, 'bin'), 'pod', body);
  executable(root, 'login-shell', body);
  await expect(iosToolchainAsync(root, null)).resolves.toMatchObject({
    cocoapods: null,
    xcode: 'Xcode 27.0',
    simulatorSdk: '27.0',
  });
  expect(existsSync(marker)).toBe(false);
});

test.skipIf(process.platform !== 'darwin')('a pending macOS version process leaves timers responsive', async () => {
  executable(join(root, 'bin'), 'xcodebuild', "setTimeout(() => console.log('Xcode 27.0'), 150);");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    await expect(macosToolchainAsync()).resolves.toMatchObject({ xcode: 'Xcode 27.0', macosSdk: '27.0' });
    expect(ticks).toBeGreaterThan(1);
  } finally {
    clearInterval(timer);
  }
  executable(join(root, 'bin'), 'xcodebuild', 'process.exit(1);');
  executable(join(root, 'bin'), 'xcrun', 'process.exit(1);');
  await expect(macosToolchainAsync()).resolves.toMatchObject({ xcode: null, macosSdk: null });
});

test('async Android comparison honors JAVA_HOME even when it cannot read that JDK', async () => {
  const jdk = join(root, 'jdk');
  mkdirSync(jdk);
  writeFileSync(join(jdk, 'release'), 'JAVA_VERSION="17.0.20"\n');
  await expect(androidToolchainAsync({ JAVA_HOME: jdk })).resolves.toMatchObject({ jdk: '17' });
  await expect(androidToolchainAsync({ JAVA_HOME: join(root, 'missing') })).resolves.toMatchObject({ jdk: null });
});

test.skipIf(process.platform !== 'darwin')('async Android comparison uses the JDK selected on PATH', async () => {
  const jdk = join(root, 'path-jdk');
  executable(join(jdk, 'bin'), 'java', 'process.exit(1);');
  writeFileSync(join(jdk, 'release'), 'JAVA_VERSION="21.0.8"\n');
  vi.stubEnv('JAVA_HOME', undefined);
  vi.stubEnv('PATH', join(jdk, 'bin') + delimiter + process.env.PATH);
  await expect(androidToolchainAsync()).resolves.toMatchObject({ jdk: '21' });
});

test('native Gradle discovery reads JDK and SDK facts without Apple or Ruby probes', () => {
  const sdk = join(root, 'android-sdk');
  mkdirSync(join(sdk, 'platforms', 'android-35'), { recursive: true });
  const jdk = join(root, 'jdk');
  mkdirSync(jdk);
  writeFileSync(join(jdk, 'release'), 'JAVA_VERSION="17.0.20"\n');
  vi.stubEnv('JAVA_HOME', jdk);
  vi.stubEnv('ANDROID_HOME', sdk);
  setExecutor(
    makeExecutor({
      runFileQuiet: () => {
        throw new Error('Unrelated native discovery probe');
      },
    }),
  );
  expect(workerToolchain(null, 'gradle')).toMatchObject({
    jdk: '17',
    androidSdk: { platforms: ['android-35'] },
    xcode: null,
    simulatorSdk: null,
    cocoapods: null,
    runtimes: [],
  });
});

test('the Gradle offer reports the SDK directory and whether its licenses are accepted', () => {
  const sdk = join(root, 'android-sdk');
  mkdirSync(join(sdk, 'platforms', 'android-35'), { recursive: true });
  vi.stubEnv('ANDROID_HOME', sdk);
  setExecutor(makeExecutor({ runFileQuiet: () => null }));
  expect(workerToolchain(null, 'gradle')).toMatchObject({ androidLicenses: false, androidHome: sdk });
  mkdirSync(join(sdk, 'licenses'));
  writeFileSync(join(sdk, 'licenses', 'android-sdk-license'), '\n');
  expect(workerToolchain(null, 'gradle').androidLicenses).toBe(false);
  writeFileSync(join(sdk, 'licenses', 'android-sdk-license'), '\n24333f8a63b6825ea9c5514f83c2829b004d1fee\n');
  expect(workerToolchain(null, 'gradle').androidLicenses).toBe(true);
  rmSync(join(sdk, 'platforms'), { recursive: true });
  expect(workerToolchain(null, 'gradle')).toMatchObject({ androidSdk: null });
  expect(workerToolchain(null, 'gradle')).not.toHaveProperty('androidLicenses');
});

function fakeJdk(parent: string, name: string, version: string, jre = false): string {
  const home = join(parent, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'release'), `JAVA_VERSION="${version}"\n`);
  if (!jre) {
    mkdirSync(join(home, 'bin'));
    writeFileSync(join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'), '');
  }
  return home;
}

test('a worker lists the JDK majors it can build on and builds with the one a job names', () => {
  const jdks = join(root, 'jvms');
  const jdk25 = fakeJdk(jdks, 'jdk-25', '25.0.1');
  const jdk17 = fakeJdk(jdks, 'zulu-17', '17.0.18');
  const jdk17Other = fakeJdk(jdks, 'temurin-17', '17.0.9');
  const jre21 = fakeJdk(jdks, 'jre-21', '21.0.3', true);
  const jdk8 = fakeJdk(jdks, 'jdk-8', '1.8.0_402');
  mkdirSync(join(jdks, 'broken'));
  expect([...jdkHomes([jdk25, join(jdks, 'broken'), jre21, jdk17, jdk17Other, jdk8])]).toEqual([
    ['25', jdk25],
    ['17', jdk17],
    ['8', jdk8],
  ]);
  mkdirSync(join(root, 'home', '.sdkman', 'candidates', 'java', '21.0.5-tem'), { recursive: true });
  expect(jdkCandidates({ JAVA_HOME: jdk25 }, 'linux', join(root, 'home'))).toEqual(
    expect.arrayContaining([jdk25, join(root, 'home', '.sdkman', 'candidates', 'java', '21.0.5-tem')]),
  );

  const env: NodeJS.ProcessEnv = { JAVA_HOME: jdk25 };
  expect(useJdkMajor('25', env, [jdk25, jdk17])).toBeNull();
  expect(env.JAVA_HOME).toBe(jdk25);
  expect(useJdkMajor('17', env, [jdk25, jdk17])).toBeNull();
  expect(env.JAVA_HOME).toBe(jdk17);
  expect(useJdkMajor('21', env, [jdk25, jdk17])).toBe('This machine has no JDK 21 to build on.');
  expect(env.JAVA_HOME).toBe(jdk17);

  vi.stubEnv('JAVA_HOME', jdk25);
  vi.stubEnv('ANDROID_HOME', join(root, 'no-sdk'));
  setExecutor(makeExecutor({ runFileQuiet: () => null }));
  expect(workerToolchain(null, 'gradle')).toMatchObject({ jdk: '25', jdks: expect.arrayContaining(['25']) });
});
