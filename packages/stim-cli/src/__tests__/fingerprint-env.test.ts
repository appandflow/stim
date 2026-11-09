import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { entryPoints, findPackage, packageIdentity, packageRows } from '../fingerprint/closure.ts';
import type { Input } from '../fingerprint/key.ts';
import {
  buildEnvRows,
  buildScripts,
  enumerationRow,
  fingerprintJobEnv,
  jobEnv,
  materializeFingerprintEnv,
  scriptEnvNames,
  templateScripts,
  workspaceEnv,
} from '../fingerprint/env.ts';
import { resolveReplayEnvPath } from '../fingerprint/replay.ts';

const MOBILE = fileURLToPath(new URL('../../../../apps/mobile', import.meta.url));
const SCRIPT = /(?:\.podspec|\.rb|\.gradle|\.gradle\.kts|^Podfile|^CMakeLists\.txt)$/;
const MENTIONS_ENV = /\bENV\s*[[.{]|getenv\s*\(|environmentVariable|System\.env\b/;
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
  [...text.matchAll(/['"]([A-Z][A-Z0-9_]{3,})['"]|\bENV\{(\w+)\}/g)].map((m) => m[1] ?? m[2] ?? '');
const keyed = (texts: string[]) =>
  new Set(
    buildEnvRows(texts.flatMap(scriptEnvNames), {}, 'ios', (path) => path).rows.map((row) =>
      row.name.slice('env:'.length),
    ),
  );

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

  test('scans every Podfile, podspec, Ruby, Gradle and CMake file of the native packages', async () => {
    expect(packages.length).toBeGreaterThan(20);
    for (const dir of packages) expect((await buildScripts(dir)).toSorted()).toEqual(listScripts(dir).toSorted());
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
        const dynamicCovered = quotedNames(text).every((name) => LEFT_OUT.has(name) || fileKeyed.has(name));
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
    const names = packageRows(dirs.flatMap((dir) => packageIdentity(dir) ?? [])).map((row) => row.name);
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
  const ios = buildEnvRows(texts.flatMap(scriptEnvNames), env, 'ios', form);
  const android = buildEnvRows(texts.flatMap(scriptEnvNames), env, 'android', form);
  expect(ios.paths).toEqual(['/abs/hermes.tar.gz']);
  expect(ios.rows.map((row) => row.name)).toEqual(['env:HERMES_ENGINE_TARBALL_PATH']);
  expect(android.rows.map((row) => row.name)).toEqual([
    'env:HERMES_ENGINE_TARBALL_PATH',
    'env:ORG_GRADLE_PROJECT_newArchEnabled',
  ]);
  const moved = buildEnvRows(
    texts.flatMap(scriptEnvNames),
    { HERMES_ENGINE_TARBALL_PATH: '/other/hermes.tar.gz' },
    'ios',
    () => 'form:same',
  );
  expect(moved.rows[0]?.hash).toBe(
    buildEnvRows(texts.flatMap(scriptEnvNames), env, 'ios', () => 'form:same').rows[0]?.hash,
  );
});

test.each([
  ['System.env.HERMES_TARBALL', ['HERMES_TARBALL']],
  ['if(DEFINED ENV{CMAKE_FLAG})', ['CMAKE_FLAG']],
  ['FLAGS = "RCT_A"\nENV[FLAGS]', ['RCT_A']],
  ['def flag(n) { System.getenv().get(n) }\nflag("EX_DEBUG")\nflag("HERMES")', ['EX_DEBUG', 'HERMES']],
  ["%w[A B].each { |k| puts ENV[k] }\nx = 'EXPO_FLAG'", ['EXPO_FLAG']],
  ["x = BUILD_ENV['ABC_D']\ny = ENV[name]\nz = 'SECRET_B'", ['ABC_D', 'SECRET_B']],
])('a build script read %j keys %j', (text, names) => {
  expect([...keyed([text])].toSorted()).toEqual(names.toSorted());
});

test("a worker's job env takes the client's value of every keyed name and drops the ones the client lacked", () => {
  const env = jobEnv(
    {
      PATH: '/worker/bin',
      APP_VARIANT: 'production',
      USE_FRAMEWORKS: 'dynamic',
      DEBUG: 'x',
      STIM_HOME: '/worker/.stim',
      STIM_SETUP_TICKET: 'server-secret',
      STIM_ACCESS_TICKET: 'worker-access-secret',
    },
    { set: { APP_VARIANT: 'staging' }, absent: ['USE_FRAMEWORKS'] },
  );
  expect(env).toEqual({ PATH: '/worker/bin', APP_VARIANT: 'staging', STIM_HOME: '/worker/.stim' });
  expect(JSON.stringify(env)).not.toContain('worker-access-secret');
});

test('workspace replay keeps the selected home and run identity but not private tickets', () => {
  expect(
    workspaceEnv({
      STIM_HOME: '/private/stim',
      STIM_RUN_ID: 'run',
      STIM_ACCESS_TICKET: 'access',
      STIM_SETUP_TICKET: 'setup',
    }),
  ).toEqual({ STIM_HOME: '/private/stim', STIM_RUN_ID: 'run' });
});

test('a worker removes extra keyed env when project code enumerated its environment', () => {
  expect(
    jobEnv(
      { PATH: '/worker/bin', STIM_HOME: '/worker/.stim', CI: '1', WORKER_ONLY: 'extra', APP_VARIANT: 'worker' },
      { set: { APP_VARIANT: 'client' }, absent: [] },
      true,
    ),
  ).toEqual({ PATH: '/worker/bin', STIM_HOME: '/worker/.stim', CI: '1', APP_VARIANT: 'client' });
});

test('enumerated env paths use the same relocated form as individually read env', () => {
  const first = enumerationRow({ ASSET_DIR: '/first/project/assets', FLAG: 'yes' }, (path) =>
    path.replace('/first/project', '<project>'),
  );
  const second = enumerationRow({ ASSET_DIR: '/second/project/assets', FLAG: 'yes' }, (path) =>
    path.replace('/second/project', '<project>'),
  );
  expect(first).toEqual(second);
});

test('offload sends keyed env values and absences without machine or worker-only values', () => {
  expect(
    fingerprintJobEnv(
      [
        { name: 'env:APP_VARIANT', kind: 'env', hash: 'x' },
        { name: 'env:USE_FRAMEWORKS', kind: 'env', hash: 'x' },
        { name: 'env:*', kind: 'env', hash: 'x' },
      ],
      { APP_VARIANT: 'staging', ASSET_DIR: '/client/app/assets', PATH: '/bin', STIM_HOME: '/home' },
      (path) => path.replace('/client/app', '<project>'),
    ),
  ).toEqual({ set: { APP_VARIANT: 'staging', ASSET_DIR: { path: '<project>/assets' } }, absent: ['USE_FRAMEWORKS'] });
});

test('offload refuses a keyed secret or path outside the project', () => {
  const row = (name: string): Input => ({ name: `env:${name}`, kind: 'env', hash: 'x' });
  expect(fingerprintJobEnv([row('STIM_SETUP_TICKET')], { STIM_SETUP_TICKET: 'secret' }, () => '')).toBeNull();
  expect(fingerprintJobEnv([row('ASSET_DIR')], { ASSET_DIR: '/outside' }, () => 'outside:hash')).toBeNull();
});

test('absolute env paths do not collide with relative literal values', () => {
  const form = (path: string) => path.replace('/project/', '');
  expect(buildEnvRows(['ASSET_DIR'], { ASSET_DIR: '/project/assets' }, 'ios', form).rows).not.toEqual(
    buildEnvRows(['ASSET_DIR'], { ASSET_DIR: 'assets' }, 'ios', form).rows,
  );
  expect(enumerationRow({ ASSET_DIR: '/project/assets' }, form)).not.toEqual(
    enumerationRow({ ASSET_DIR: 'assets' }, form),
  );
});

test('worker resolves only tagged paths and keeps literal prefix-like values', () => {
  const client = { set: { ASSET_DIR: { path: 'assets' }, LITERAL: 'npm:thing/file' }, absent: ['UNSET'] };
  expect(materializeFingerprintEnv(client, (path) => `/worker/project/${path}`)).toEqual({
    set: { ASSET_DIR: '/worker/project/assets', LITERAL: 'npm:thing/file' },
    absent: ['UNSET'],
  });
});

test('worker refuses Windows absolute and drive-relative path forms on every host', () => {
  const roots = { project: '/project', install: '/project' };
  for (const path of ['C:\\secret', 'C:/secret', 'C:secret', '\\\\server\\share'])
    expect(resolveReplayEnvPath(path, roots)).toBeNull();
});

test('enumerated app STIM_ variables affect the key and do not leak from the worker', () => {
  const first = enumerationRow({ STIM_APP_PUSH: 'one' }, (path) => path);
  const second = enumerationRow({ STIM_APP_PUSH: 'two' }, (path) => path);
  expect(first.hash).not.toBe(second.hash);
  expect(jobEnv({ STIM_HOME: '/worker', STIM_APP_PUSH: 'worker' }, { set: {}, absent: [] }, true)).toEqual({
    STIM_HOME: '/worker',
  });
});

test('embedded env enumeration keys and forwards values not pinned in that environment', () => {
  const form = (path: string) => path;
  expect(enumerationRow({ CI: 'one' }, form, false).hash).not.toBe(enumerationRow({ CI: 'two' }, form, false).hash);
  expect(enumerationRow({ CI: 'one' }, form).hash).toBe(enumerationRow({ CI: 'two' }, form).hash);
  const rows: Input[] = [{ name: 'env@embed:*', kind: 'env', hash: 'x' }];
  const sent = fingerprintJobEnv(rows, { CI: 'client' }, form);
  expect(sent).toEqual({ set: { CI: 'client' }, absent: [] });
  expect(
    jobEnv({ CI: 'worker', LANG: 'worker', PATH: '/bin' }, { set: { CI: 'client' }, absent: [] }, true, true),
  ).toEqual({ CI: 'client', PATH: '/bin' });
});
