import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildCacheKey } from '../cache/build-cache.ts';
import { androidHome } from '../devices/android.ts';
import { getExecutor } from '../exec.ts';
import { fingerprintNativeInputs } from './native-inputs.ts';
import {
  gradleOffloadInputs,
  nativeGradleLocalSourceDigest,
  type GradleOffloadInputs,
} from './native-gradle-inputs.ts';
import type { AndroidArtifactContext } from './android-project.ts';

export const NATIVE_GRADLE_CACHE_LIMIT =
  'Native APK caching requires android.artifactInputs with complete: true and a complete declaration of repeatable pinned inputs. Gradle incremental and task-cache reuse remain available without it.';

interface GradleArtifactInputs extends GradleOffloadInputs {
  localFiles: string[];
  environment: string[];
}

export function gradleArtifactInputs(value: unknown): GradleArtifactInputs {
  const input = value as Record<string, unknown> | null;
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some((key) => !['complete', 'ignored', 'outputs', 'localFiles', 'environment'].includes(key)) ||
    (input.localFiles !== undefined &&
      (!Array.isArray(input.localFiles) ||
        !input.localFiles.every((path) => typeof path === 'string' && path.length > 0 && !path.includes('\0')))) ||
    (input.environment !== undefined &&
      (!Array.isArray(input.environment) ||
        !input.environment.every((name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))))
  )
    throw new Error(NATIVE_GRADLE_CACHE_LIMIT);
  let inventory;
  try {
    inventory = gradleOffloadInputs({ complete: input.complete, ignored: input.ignored, outputs: input.outputs });
  } catch (error) {
    throw new Error(
      (error as Error).message
        .replaceAll('android.offloadInputs', 'android.artifactInputs')
        .replace('Native Gradle offload', 'Native Gradle artifact caching'),
      { cause: error },
    );
  }
  return {
    ...inventory,
    localFiles: [...new Set((input.localFiles ?? []) as string[])].toSorted(),
    environment: [...new Set((input.environment ?? []) as string[])].toSorted(),
  };
}

function javaRelease(): string {
  let home = process.env.JAVA_HOME;
  if (!home) {
    const java = getExecutor().findExecutable('java');
    if (java) {
      const selected = dirname(dirname(realpathSync(java)));
      if (existsSync(join(selected, 'release'))) home = selected;
    }
  }
  if (!home && process.platform === 'darwin')
    home = getExecutor().runFile('/usr/libexec/java_home', [], { timeoutMs: 10_000 }).trim();
  if (!home || !readFileSync(join(home, 'release'), 'utf8').includes('JAVA_VERSION='))
    throw new Error('The Gradle wrapper JDK release identity is unavailable.');
  return join(home, 'release');
}

export function nativeGradleArtifactSnapshot(
  root: string,
  value: unknown,
  build: Pick<AndroidArtifactContext['buildPlan'], 'variant' | 'compilerCache' | 'gradleBuildCache' | 'pch' | 'cas'>,
  abi: string | null,
): { hash: string; key: string; sdkDirectory: string } {
  const declaration = gradleArtifactInputs(value);
  const localFiles = declaration.localFiles.map((file) => {
    const path = resolve(root, file);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error('android.artifactInputs.localFiles must name exact regular files.');
    return stat ? realpathSync(path) : path;
  });
  const { complete, ignored, outputs } = declaration;
  const source = nativeGradleLocalSourceDigest(root, { complete, ignored, outputs }, [
    join(root, 'local.properties'),
    ...declaration.localFiles.map((file) => resolve(root, file)),
  ]);
  const sdkDirectory = realpathSync(androidHome());
  const inputs = [
    { name: 'jdk-release', path: javaRelease(), optional: false },
    { name: 'local-properties', path: join(root, 'local.properties'), optional: true },
    {
      name: 'gradle-user-properties',
      path: join(process.env.GRADLE_USER_HOME ?? join(homedir(), '.gradle'), 'gradle.properties'),
      optional: true,
    },
  ];
  for (const group of ['build-tools', 'platforms', 'ndk', 'cmake']) {
    const directory = join(sdkDirectory, group);
    if (!existsSync(directory)) continue;
    for (const version of readdirSync(directory).toSorted()) {
      const path = join(directory, version, 'source.properties');
      if (existsSync(path)) inputs.push({ name: `sdk/${group}/${version}`, path, optional: false });
    }
  }
  if (!inputs.some((input) => input.name.startsWith('sdk/build-tools/')))
    throw new Error('Android SDK build-tools version metadata is unavailable.');
  const preferences = [
    join(homedir(), '.android'),
    ...(process.env.ANDROID_USER_HOME ? [process.env.ANDROID_USER_HOME] : []),
    ...['ANDROID_PREFS_ROOT', 'ANDROID_SDK_HOME', 'TEST_TMPDIR'].flatMap((name) =>
      process.env[name] ? [join(process.env[name]!, '.android')] : [],
    ),
  ];
  for (const [index, directory] of [...new Set(preferences)].entries())
    inputs.push({ name: `debug-keystore/${index}`, path: join(directory, 'debug.keystore'), optional: true });
  for (const [index, path] of localFiles.entries()) inputs.push({ name: `local/${index}`, path, optional: true });
  const environment = Object.fromEntries(
    [
      ...new Set([
        ...declaration.environment,
        'JAVA_HOME',
        'JAVA_OPTS',
        'JAVA_TOOL_OPTIONS',
        '_JAVA_OPTIONS',
        'GRADLE_OPTS',
        'GRADLE_USER_HOME',
        'ANDROID_HOME',
        'ANDROID_SDK_ROOT',
        'ANDROID_USER_HOME',
        'ANDROID_PREFS_ROOT',
        'ANDROID_SDK_HOME',
        'TEST_TMPDIR',
      ]),
    ]
      .toSorted()
      .map((name) => [name, process.env[name] ?? null]),
  );
  const local = fingerprintNativeInputs(inputs, { parameters: { declaration, localFiles, environment, sdkDirectory } });
  const hash = createHash('sha256')
    .update('stim-native-gradle-artifact-v1\0')
    .update(
      JSON.stringify({
        source,
        local: local.hash,
        platform: process.platform,
        arch: process.arch,
        variant: build.variant ?? 'debug',
        compilerCache: build.compilerCache,
        gradleBuildCache: build.gradleBuildCache,
        pch: build.pch,
        cas: build.cas,
        abi,
      }),
    )
    .digest('hex');
  return { hash, key: buildCacheKey('android', hash), sdkDirectory };
}
