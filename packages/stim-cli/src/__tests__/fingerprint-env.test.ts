import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { entryPoints, findPackage, packageRows } from '../fingerprint/closure.ts';
import { buildEnvRows, buildScripts, jobEnv, templateScripts } from '../fingerprint/env.ts';

const MOBILE = fileURLToPath(new URL('../../../../apps/mobile', import.meta.url));
const SCRIPT = /(?:\.podspec|\.rb|\.gradle|\.gradle\.kts|^Podfile|^CMakeLists\.txt)$/;
const MENTIONS_ENV = /\bENV\s*[[.]|\$ENV\{|getenv\s*\(|environmentVariable\s*\(/;
const DYNAMIC = /ENV(?:\[|\.\w+\??\()\s*[A-Za-z_]|(?:getenv|environmentVariable)\(\s*[A-Za-z_]/;
/** Names stim leaves out on purpose: machine locations and names that cannot change the build. */
const LEFT_OUT = new Set([
  'PATH',
  'HOME',
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_NDK_HOME',
  'NODE_BINARY',
  'DEVELOPER_DIR',
  'USE_CCACHE',
  'APP_PATH',
  'RCT_SKIP_CACHES',
]);
const quotedNames = (text: string) =>
  [...text.matchAll(/['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]|\$ENV\{(\w+)\}/g)].map((m) => m[1] ?? m[2] ?? '');
const keyed = (texts: string[]) =>
  new Set(buildEnvRows(texts, {}, 'ios', (path) => path).rows.map((row) => row.name.slice('env:'.length)));

function listScripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listScripts(path);
    return SCRIPT.test(entry.name) ? [path] : [];
  });
}

/** The native packages apps/mobile installs, plus the React Native and Expo packages whose scripts every build runs. */
function nativePackages(): string[] {
  const modules = join(MOBILE, 'node_modules');
  const names = readdirSync(modules).flatMap((name) =>
    name.startsWith('@') ? readdirSync(join(modules, name)).map((scoped) => `${name}/${scoped}`) : [name],
  );
  const dirs = names
    .map((name) => realpathSync(join(modules, name)))
    .filter((dir) => ['ios', 'android'].some((sub) => existsSync(join(dir, sub))));
  const reactNative = findPackage(MOBILE, 'react-native') ?? '';
  const expo = findPackage(MOBILE, 'expo') ?? '';
  return [
    ...dirs,
    reactNative,
    findPackage(expo, 'expo-modules-autolinking') ?? '',
    findPackage(reactNative, '@react-native/gradle-plugin') ?? '',
  ];
}

describe.skipIf(!existsSync(join(MOBILE, 'node_modules')))('build env scan over the installed SDK', () => {
  const packages = nativePackages();

  test('scans every Podfile, podspec, Ruby, Gradle and CMake file of the native packages', () => {
    expect(packages.length).toBeGreaterThan(20);
    for (const dir of packages) expect(buildScripts(dir).toSorted()).toEqual(listScripts(dir).toSorted());
  });

  test('parses every line that reads the env, or keys every name its file could pass to a dynamic read', () => {
    const unparsed: string[] = [];
    for (const file of packages.flatMap(listScripts)) {
      const text = readFileSync(file, 'utf8');
      const constants = text
        .split('\n')
        .filter((line) => /^\s*[A-Z][A-Z0-9_]*\s*=\s*['"]/.test(line))
        .join('\n');
      const fileKeyed = keyed([text]);
      for (const line of text.split('\n').filter((candidate) => MENTIONS_ENV.test(candidate))) {
        const lineNames = quotedNames(line);
        if (
          keyed([`${constants}\n${line}`]).size > 0 ||
          (lineNames.length > 0 && lineNames.every((n) => LEFT_OUT.has(n)))
        )
          continue;
        const dynamicCovered =
          DYNAMIC.test(line) && quotedNames(text).every((name) => LEFT_OUT.has(name) || fileKeyed.has(name));
        if (!dynamicCovered) unparsed.push(`${file}: ${line.trim()}`);
      }
    }
    expect(unparsed).toEqual([]);
  });

  test('reads the Podfile and settings.gradle of the template prebuild generates from', () => {
    const expo = findPackage(MOBILE, 'expo') ?? '';
    const names = keyed(templateScripts(join(expo, 'template.tgz')));
    expect(names).toContain('EXPO_USE_COMMUNITY_AUTOLINKING');
    expect(names).toContain('USE_FRAMEWORKS');
  });

  test('keys the prebuild and codegen entry points with their direct dependencies', () => {
    const { dirs } = entryPoints(MOBILE, findPackage(MOBILE, 'expo'));
    const names = packageRows(dirs).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'package:@expo/cli',
        'package:@expo/config-plugins',
        'package:xcode',
        'package:@react-native/codegen',
      ]),
    );
  });
});

test('a build env path is keyed in its path form, and Gradle project properties only on Android', () => {
  const env = { HERMES_ENGINE_TARBALL_PATH: '/abs/hermes.tar.gz', ORG_GRADLE_PROJECT_newArchEnabled: 'false' };
  const texts = ["tarball = ENV['HERMES_ENGINE_TARBALL_PATH']"];
  const form = (path: string) => `form:${path}`;
  const ios = buildEnvRows(texts, env, 'ios', form);
  const android = buildEnvRows(texts, env, 'android', form);
  expect(ios.paths).toEqual(['/abs/hermes.tar.gz']);
  expect(ios.rows.map((row) => row.name)).toEqual(['env:HERMES_ENGINE_TARBALL_PATH']);
  expect(android.rows.map((row) => row.name)).toEqual([
    'env:HERMES_ENGINE_TARBALL_PATH',
    'env:ORG_GRADLE_PROJECT_newArchEnabled',
  ]);
  const moved = buildEnvRows(texts, { HERMES_ENGINE_TARBALL_PATH: '/other/hermes.tar.gz' }, 'ios', () => 'form:same');
  expect(moved.rows[0]?.hash).toBe(buildEnvRows(texts, env, 'ios', () => 'form:same').rows[0]?.hash);
});

test("a worker's job env takes the client's value of every keyed name and drops the ones the client lacked", () => {
  const env = jobEnv(
    { PATH: '/worker/bin', APP_VARIANT: 'production', USE_FRAMEWORKS: 'dynamic', DEBUG: 'x', HOME: '/worker' },
    { set: { APP_VARIANT: 'staging' }, absent: ['USE_FRAMEWORKS'] },
  );
  expect(env).toEqual({ PATH: '/worker/bin', APP_VARIANT: 'staging', HOME: '/worker' });
});
