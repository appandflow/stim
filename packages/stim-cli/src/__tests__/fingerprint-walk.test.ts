import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { isUncertain, type Input, type NativeMode } from '../fingerprint/key.ts';
import { staticInputs, type StaticContext, type StaticTarget } from '../fingerprint/inputs.ts';
import { compileIgnore, nativeSubset, walk, within, type WalkOptions } from '../fingerprint/walk.ts';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-walk-')));
  temps.push(root);
  write(root, files);
  return root;
}

const project = (files: Record<string, string>) => tree({ 'package-lock.json': '{}', ...files });

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function walked(root: string, options: Omit<Partial<WalkOptions>, 'ignore'> & { ignore?: string } = {}): Input[] {
  const result = walk({
    roots: { project: root, install: root },
    trees: [root],
    tracked: null,
    ...options,
    ignore: compileIgnore(options.ignore ?? ''),
  });
  if (isUncertain(result)) throw new Error(result.uncertain);
  return result.inputs;
}

const names = (inputs: Input[]) => inputs.map((input) => input.name).toSorted();
const hashOf = (inputs: Input[], name: string) => inputs.find((input) => input.name === name)?.hash;

function inputsOf(root: string, context: Partial<StaticContext>, target: StaticTarget) {
  const result = staticInputs({ root, tracked: null, expoResolves: false, ...context }, target);
  if (isUncertain(result)) throw new Error(result.uncertain);
  return result;
}

describe('.fingerprintignore matcher', () => {
  const files = {
    'a.log': '',
    'keep.log': '',
    'sub/b.log': '',
    'top.txt': '',
    'sub/top.txt': '',
    'deep/top.txt': '',
    'other/sub/d.txt': '',
    'd.txt': '',
    ayb: '',
    'a/b': '',
    '1.txt': '',
    'sub/c.txt': '',
    'deep/x/gen/out.c': '',
    'out/file': '',
    'nested/out': '',
    'dir/keep.txt': '',
    '#hash': '',
  };
  test.each([
    ['comments and blank lines match nothing; an escaped # is a name', '# a.log\n\n\\#hash', ['#hash']],
    ['a pattern without a slash matches at any depth, and ! re-includes', '*.log\n!keep.log', ['a.log', 'sub/b.log']],
    [
      'a leading or inner slash anchors to the app root',
      '/top.txt\nsub/*.txt',
      ['sub/c.txt', 'sub/top.txt', 'top.txt'],
    ],
    [
      'an escaped letter is that letter, and an invalid pattern matches nothing',
      '[z-a].txt\n\\d.txt',
      ['d.txt', 'other/sub/d.txt'],
    ],
    ['a negated class never matches a slash', 'a[!x]b', ['ayb']],
    ['** crosses directories', '**/gen/**', ['deep/x/gen/out.c']],
    ['a trailing slash matches directories only', 'out/', ['out/file']],
    ['! cannot re-include a file under an excluded directory', 'dir/\n!dir/keep.txt', ['dir/keep.txt']],
  ])('%s', (_case, ignore, excluded) => {
    const root = tree(files);
    const all = names(walked(root));
    expect(all.filter((name) => !names(walked(root, { ignore })).includes(name))).toEqual(excluded);
  });

  test('the project can re-include what a built-in exclude drops', () => {
    const root = tree({ 'android/local.properties': 'sdk.dir=/x', 'android/build.gradle': '' });
    expect(names(walked(root))).toEqual(['android/build.gradle']);
    expect(names(walked(root, { ignore: '!local.properties' }))).toContain('android/local.properties');
  });
});

describe('fingerprint walk', () => {
  test('drops build output next to its build script, never a source directory of the same name', () => {
    const root = tree({
      'android/app/build.gradle': '',
      'android/app/build/outputs/app.apk': '',
      'android/app/src/main/java/com/x/build/Config.kt': '',
      'android/.gradle/cache': '',
      'ios/Podfile': '',
      'ios/Pods/Manifest.lock': '',
      'ios/build/App.app': '',
      'ios/App/xcuserdata/me.xcuserdatad/x': '',
      'android/app/release.keystore': '',
      'android/app/debug.keystore': '',
    });
    expect(names(walked(root))).toEqual([
      'android/app/build.gradle',
      'android/app/debug.keystore',
      'android/app/src/main/java/com/x/build/Config.kt',
      'ios/Podfile',
    ]);
    expect(names(walked(root, { keepSigningFiles: true }))).toContain('android/app/release.keystore');
  });

  test('a workspace, the bundle output and other tracked-only paths count only while git tracks them', () => {
    const root = tree({
      'ios/App.xcworkspace/contents.xcworkspacedata': '',
      'ios/main.jsbundle': '',
      'ios/Podfile': '',
    });
    const only = { trackedOnly: [join(root, 'ios/main.jsbundle')] };
    expect(names(walked(root, { ...only, tracked: new Set([join(root, 'ios/Podfile')]) }))).toEqual(['ios/Podfile']);
    const tracked = new Set(
      ['ios/App.xcworkspace/contents.xcworkspacedata', 'ios/main.jsbundle'].map((p) => join(root, p)),
    );
    const inputs = walked(root, { ...only, tracked });
    expect(names(inputs)).toEqual(['ios/App.xcworkspace/contents.xcworkspacedata', 'ios/Podfile', 'ios/main.jsbundle']);
    expect(inputs.filter((input) => input.git === 'tracked').map((input) => input.name)).toEqual([
      'ios/App.xcworkspace/contents.xcworkspacedata',
      'ios/main.jsbundle',
    ]);
  });

  test('stops with no key past the file limit', () => {
    const root = tree({ a: '', b: '', c: '' });
    const result = walk({
      roots: { project: root, install: root },
      trees: [root],
      tracked: null,
      limits: { files: 2, bytes: 1e9 },
    });
    expect(isUncertain(result)).toBe(true);
  });

  test('names files in installed packages the same under hoisted and pnpm layouts', () => {
    const hoisted = tree({ 'node_modules/@scope/lib/ios/A.swift': 'a' });
    const pnpm = tree({ 'node_modules/.pnpm/@scope+lib@1.0.0/node_modules/@scope/lib/ios/A.swift': 'a' });
    expect(walked(hoisted, { trees: [join(hoisted, 'node_modules/@scope/lib')] })).toEqual(
      walked(pnpm, { trees: [join(pnpm, 'node_modules/.pnpm/@scope+lib@1.0.0/node_modules/@scope/lib')] }),
    );
  });
});

describe.skipIf(process.platform === 'win32')('fingerprint walk through symlinks', () => {
  test('a file link counts its target bytes and a directory link walks its target once, cycles included', () => {
    const root = tree({ 'shared/Common.swift': 'v1', 'secrets/Info.plist': 'p1', 'ios/Podfile': '' });
    symlinkSync('../shared', join(root, 'ios/Shared'));
    symlinkSync('../secrets/Info.plist', join(root, 'ios/Info.plist'));
    symlinkSync('.', join(root, 'shared/loop'));
    symlinkSync('missing', join(root, 'ios/Dangling'));
    const trees = [join(root, 'ios')];
    const before = walked(root, { trees });
    expect(names(before)).toEqual([
      'ios/Dangling',
      'ios/Info.plist',
      'ios/Podfile',
      'ios/Shared',
      'shared/Common.swift',
      'shared/loop',
    ]);
    write(root, { 'shared/Common.swift': 'v2', 'secrets/Info.plist': 'p2' });
    const after = walked(root, { trees });
    expect(hashOf(after, 'shared/Common.swift')).not.toBe(hashOf(before, 'shared/Common.swift'));
    expect(hashOf(after, 'ios/Info.plist')).not.toBe(hashOf(before, 'ios/Info.plist'));
    symlinkSync('..', join(root, 'shared/up'));
    expect(isUncertain(walk({ roots: { project: root, install: root }, trees, tracked: null }))).toBe(true);
  });

  test('a target outside the project and install root is hashed into an outside row and makes the key non-portable', () => {
    const outside = tree({ 'Common/A.swift': 'v1' });
    const root = tree({ 'ios/Podfile': '' });
    symlinkSync(join(outside, 'Common'), join(root, 'ios/Common'));
    const run = () => walk({ roots: { project: root, install: root }, trees: [root], tracked: null });
    const before = run();
    if (isUncertain(before)) throw new Error(before.uncertain);
    expect(before.portable).toBe(false);
    const row = before.inputs.find((input) => input.name.startsWith('outside:'));
    expect(row).toBeDefined();
    write(outside, { 'Common/A.swift': 'v2' });
    const after = run();
    expect(isUncertain(after) ? null : hashOf(after.inputs, row?.name ?? '')).not.toBe(row?.hash);
  });
});

describe('native subsets and static inputs', () => {
  test('a local native package counts its native parts and codegen specs, not its JS', () => {
    const lib = tree({
      'package.json': '{"name":"lib","codegenConfig":{"jsSrcsDir":"specs"}}',
      'Lib.podspec': 's.source_files = "ios/**/*.swift", "Common/cpp/**/*.{h,cpp}"',
      'Common/cpp/Lib.cpp': '',
      'docs/guide.md': '',
      'ios/Lib.swift': '',
      'specs/NativeLib.ts': '',
      'src/index.ts': '',
      'README.md': '',
    });
    expect(
      nativeSubset(lib)
        .map((path) => path.slice(lib.length + 1))
        .toSorted(),
    ).toEqual(['Common', 'Lib.podspec', 'ios', 'package.json', 'specs']);
    const js = tree({ 'package.json': '{}', 'index.js': '' });
    expect(nativeSubset(js)).toEqual([js]);
  });

  test('a content package that contains the app never walks into the app', () => {
    const repo = tree({
      'package-lock.json': '{}',
      'ios/Lib.swift': '',
      'Lib.podspec': '',
      'example/package.json': '{"name":"example"}',
      'example/App.tsx': '',
    });
    const app = join(repo, 'example');
    const { inputs } = inputsOf(app, { contentPackages: [repo] }, { platform: 'ios' });
    expect(names(inputs)).toEqual(['<install>/Lib.podspec', '<install>/ios/Lib.swift', 'package.json#native']);
  });

  const modes: [string, boolean, string[], NativeMode][] = [
    ['expo with no tracked native file', true, [], 'generated'],
    ['expo with a tracked native file', true, ['ios/Podfile'], 'tracked'],
    ['bare React Native', false, [], 'tracked'],
  ];
  test.each(modes)('%s keys the native directory as %s', (_case, expoResolves, tracked, mode) => {
    const root = project({ 'package.json': '{}', 'ios/Podfile': '' });
    const result = inputsOf(
      root,
      { expoResolves, tracked: new Set(tracked.map((p) => join(root, p))) },
      { platform: 'ios' },
    );
    expect(result.native).toBe(mode);
    expect(names(result.inputs).includes('ios/Podfile')).toBe(mode === 'tracked');
  });

  test('an iOS project at the app root counts the app minus generated state, ignored paths and other platforms', () => {
    const root = project({
      'package.json': '{}',
      '.fingerprintignore': 'docs/\n',
      'App.xcodeproj/project.pbxproj': '',
      'App/AppDelegate.swift': '',
      'App.xcworkspace/contents.xcworkspacedata': '',
      '.expo/devices.json': '',
      'vendor/bundle/gem.rb': '',
      'docs/readme.md': '',
      'android/build.gradle': '',
      'modules/legacy/android/build.gradle': '',
    });
    const { inputs } = inputsOf(root, {}, { platform: 'ios', iosProjectPath: '.' });
    expect(names(inputs)).toEqual([
      '.fingerprintignore',
      'App.xcodeproj/project.pbxproj',
      'App/AppDelegate.swift',
      'modules/legacy/android/build.gradle',
      'package-lock.json',
      'package.json',
      'package.json#native',
    ]);
    write(root, { '.fingerprintignore': 'docs/\nmodules/legacy/\n' });
    expect(names(inputsOf(root, {}, { platform: 'ios', iosProjectPath: '.' }).inputs)).not.toContain(
      'modules/legacy/android/build.gradle',
    );
  });

  test('a custom Android module keeps the other Gradle modules of its root', () => {
    const root = project({
      'package.json': '{}',
      'android/settings.gradle': '',
      'android/mobile/build.gradle': '',
      'android/mobile/build/outputs/app.apk': '',
      'android/shared/build.gradle': '',
      'android/shared/src/main/java/Shared.kt': '',
    });
    const layout = {
      gradleRoot: join(root, 'android'),
      gradleRootRelative: 'android',
      module: ':mobile',
      moduleDir: join(root, 'android/mobile'),
      custom: true,
    };
    expect(names(inputsOf(root, {}, { platform: 'android', androidLayout: layout }).inputs)).toEqual([
      'android/mobile/build.gradle',
      'android/settings.gradle',
      'android/shared/build.gradle',
      'android/shared/src/main/java/Shared.kt',
      'package.json#native',
    ]);
  });

  test('with the Gradle root at the app root, files the config names still count', () => {
    const root = project({
      'package.json': '{}',
      'settings.gradle': '',
      'app/build.gradle': '',
      'google-services.json': '{}',
    });
    const layout = {
      gradleRoot: root,
      gradleRootRelative: '.',
      module: ':app',
      moduleDir: join(root, 'app'),
      custom: true,
    };
    const context = {
      expoResolves: true,
      tracked: new Set([join(root, 'settings.gradle'), join(root, 'app/build.gradle')]),
      config: { android: { googleServicesFile: './google-services.json' } },
    };
    expect(names(inputsOf(root, context, { platform: 'android', androidLayout: layout }).inputs)).toEqual([
      'app/build.gradle',
      'google-services.json',
      'package.json#native',
      'settings.gradle',
    ]);
  });

  test('two different packages that would share a row name give no key', () => {
    const root = project({
      'package.json': '{}',
      'node_modules/bar/android/B.kt': 'a',
      'node_modules/foo/node_modules/bar/android/B.kt': 'b',
    });
    const contentPackages = [join(root, 'node_modules/bar'), join(root, 'node_modules/foo/node_modules/bar')];
    expect(
      isUncertain(staticInputs({ root, tracked: null, expoResolves: false, contentPackages }, { platform: 'android' })),
    ).toBe(true);
  });

  test('outside git, an Expo app with a native directory has no key', () => {
    const root = project({ 'package.json': '{}', 'ios/Podfile': '' });
    expect(isUncertain(staticInputs({ root, tracked: null, expoResolves: true }, { platform: 'ios' }))).toBe(true);
  });

  test('patches, the patch manifest and fingerprint.config.js sources become rows', () => {
    const root = project({
      'package.json': '{"scripts":{"postinstall":"patch-package --patch-dir fixes"},"version":"1.0.0"}',
      'fixes/lib+1.0.0.patch': 'diff',
      'native-extra/x.gradle': '',
    });
    const config = {
      extraSources: [
        { type: 'dir', filePath: 'native-extra' },
        { type: 'contents', id: 'flavor', contents: 'beta' },
      ],
    };
    const { inputs } = inputsOf(root, { fingerprintConfig: config }, { platform: 'android' });
    expect(names(inputs)).toEqual([
      'extra:flavor',
      'fixes/lib+1.0.0.patch',
      'native-extra/x.gradle',
      'package.json#native',
    ]);
    const bumped = project({
      'package.json': '{"scripts":{"postinstall":"patch-package --patch-dir fixes"},"version":"2.0.0"}',
    });
    expect(hashOf(inputsOf(bumped, {}, { platform: 'android' }).inputs, 'package.json#native')).toBe(
      hashOf(inputs, 'package.json#native'),
    );
    const unreadable = { extraSources: [{ type: 'glob', pattern: '**' }] };
    expect(
      isUncertain(
        staticInputs({ root, tracked: null, expoResolves: false, fingerprintConfig: unreadable }, { platform: 'ios' }),
      ),
    ).toBe(true);
  });
});

test('within agrees with path.relative containment for normalized and unnormalized paths', () => {
  const contains = (path: string, dir: string) => {
    const rel = relative(dir, path);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const paths = [
    '/',
    '/a',
    '/a/b',
    '/ab',
    '/a/b/',
    '/a//b',
    '/a/./b',
    '/a/../b',
    '/a/..b',
    '/a/.b',
    '/a/b/..',
    '/a/...',
  ];
  const disagreements = paths.flatMap((path) =>
    paths.flatMap((dir) => (within(path, dir) === contains(path, dir) ? [] : [`${path} in ${dir}`])),
  );
  expect(disagreements).toEqual([]);
});
