import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildCacheKey } from '../cache/build-cache.ts';
import { androidHome } from '../devices/android.ts';
import { getExecutor } from '../exec.ts';
import { childEnvironment } from '../workspace/git-read.ts';
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

type GradleArtifactBuild = Pick<
  AndroidArtifactContext['buildPlan'],
  'variant' | 'compilerCache' | 'gradleBuildCache' | 'pch' | 'cas'
>;

export interface NativeGradleArtifactReceipt {
  source: string;
  declaration: GradleArtifactInputs;
  build: GradleArtifactBuild;
  abi: string | null;
}

export function nativeGradleWorkerScope(sourceDigest: string, inputs: GradleOffloadInputs): string {
  return JSON.stringify([sourceDigest, { complete: true, ignored: inputs.ignored, outputs: inputs.outputs }]);
}

export function nativeGradleWorkerArtifactIdentity(
  fingerprint: string,
  scope: string,
  variant: string,
  abi: string | null,
): { hash: string; key: string } {
  const hash = createHash('sha256')
    .update(JSON.stringify(['stim-native-gradle-worker-v1', fingerprint, scope]))
    .digest('hex');
  return { hash, key: buildCacheKey('android', hash, { variant, ...(abi ? { abi } : {}) }) };
}

export function gradleArtifactInputs(value: unknown): GradleArtifactInputs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(NATIVE_GRADLE_CACHE_LIMIT);
  const localFiles = 'localFiles' in value ? value.localFiles : [];
  const environment = 'environment' in value ? value.environment : [];
  if (
    Object.keys(value).some((key) => !['complete', 'ignored', 'outputs', 'localFiles', 'environment'].includes(key)) ||
    !Array.isArray(localFiles) ||
    !localFiles.every((path): path is string => typeof path === 'string' && path.length > 0 && !path.includes('\0')) ||
    !Array.isArray(environment) ||
    !environment.every((name): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  )
    throw new Error(NATIVE_GRADLE_CACHE_LIMIT);
  let inventory;
  try {
    inventory = gradleOffloadInputs({
      complete: 'complete' in value ? value.complete : undefined,
      ignored: 'ignored' in value ? value.ignored : undefined,
      outputs: 'outputs' in value ? value.outputs : undefined,
    });
  } catch (error) {
    throw new Error(String(error).replaceAll('android.offloadInputs', 'android.artifactInputs'), { cause: error });
  }
  return {
    ...inventory,
    localFiles: [...new Set(localFiles)].toSorted(),
    environment: [...new Set(environment)].toSorted(),
  };
}

async function optionalText(
  path: string,
  signal?: AbortSignal,
  encoding: 'utf8' | 'latin1' = 'utf8',
): Promise<string | null> {
  try {
    return await readFile(path, { encoding, signal });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function javaRelease(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  let home = env.JAVA_HOME;
  if (!home) {
    const java = getExecutor().findExecutable('java');
    if (java) {
      const selected = dirname(dirname(await realpath(java)));
      if ((await optionalText(join(selected, 'release'), signal))?.includes('JAVA_VERSION=')) home = selected;
    }
  }
  if (!home && process.platform === 'darwin') {
    const child = childEnvironment(env);
    home = (
      await getExecutor().runFileAsync('/usr/libexec/java_home', [], { timeoutMs: 10_000, signal, ...child })
    ).trim();
  }
  if (!home || !(await optionalText(join(home, 'release'), signal))?.includes('JAVA_VERSION='))
    throw new Error('The Gradle wrapper JDK release identity is unavailable.');
  return join(home, 'release');
}

async function localPropertiesIdentity(
  properties: string,
  sdk: string,
  root: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // Java Properties uses Latin-1, ASCII whitespace and lowercase-u Unicode escapes.
  // https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/Properties.html#load(java.io.InputStream)
  const content = await optionalText(properties, signal, 'latin1');
  if (content === null) return null;
  const retained: string[] = [];
  let selected: string | null = null;
  for (const [, line = '', ending = ''] of content.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
    if (/^[ \t\f]*$/.test(line) || /^[ \t\f]*[#!]/.test(line)) {
      retained.push(line + ending);
      continue;
    }
    if ((line.match(/\\+$/)?.[0].length ?? 0) % 2 !== 0)
      throw new Error('Native APK caching requires single-line local.properties values.');
    const entry = /^[ \t\f]*([A-Za-z0-9_.-]+)(?:[ \t\f]*[:=][ \t\f]*|[ \t\f]+)(.*)$/.exec(line);
    if (!entry) {
      if (/^[ \t\f]*[A-Za-z0-9_.-]+[ \t\f]*$/.test(line) && line.trim() !== 'sdk.dir') {
        retained.push(line + ending);
        continue;
      }
      throw new Error('Native APK caching requires plain, unescaped local.properties keys.');
    }
    if (entry[1] !== 'sdk.dir') {
      retained.push(line + ending);
      continue;
    }
    const value = entry[2] ?? '';
    if (!value || [...value].some((character) => character.charCodeAt(0) > 127))
      throw new Error('Native APK caching cannot resolve the local.properties SDK.');
    selected = value.replace(
      /\\u([a-fA-F\d]{4})|\\(.)/g,
      (full, hex: string | undefined, escaped: string | undefined) => {
        if (hex) return String.fromCharCode(parseInt(hex, 16));
        if (escaped === 'u') throw new Error('Native APK caching cannot resolve the local.properties SDK.');
        if (escaped === 't') return '\t';
        if (escaped === 'r') return '\r';
        if (escaped === 'n') return '\n';
        if (escaped === 'f') return '\f';
        return escaped ?? full;
      },
    );
  }
  if (selected !== null && (await realpath(resolve(root, selected))) !== sdk)
    throw new Error('Native APK caching requires the local.properties SDK to match ANDROID_HOME.');
  return retained.join('');
}

export async function nativeGradleArtifactSnapshot(
  root: string,
  value: unknown,
  build: GradleArtifactBuild,
  abi: string | null,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ hash: string; key: string; sdkDirectory: string; receipt: NativeGradleArtifactReceipt }> {
  signal?.throwIfAborted();
  const declaration = gradleArtifactInputs(value);
  const localFiles = declaration.localFiles.map((file) => resolve(root, file));
  const properties = join(root, 'local.properties');
  const { complete, ignored, outputs } = declaration;
  const source = await nativeGradleLocalSourceDigest(
    root,
    { complete, ignored, outputs },
    [properties, ...localFiles],
    signal,
  );
  return nativeGradleArtifactSnapshotFromReceipt(
    root,
    {
      source,
      declaration,
      build: {
        variant: build.variant,
        compilerCache: build.compilerCache,
        gradleBuildCache: build.gradleBuildCache,
        pch: build.pch,
        cas: build.cas,
      },
      abi,
    },
    env,
    signal,
  );
}

/** Revalidates private inputs; the caller must bind the receipt to a verified completed source snapshot. */
export async function nativeGradleArtifactSnapshotFromReceipt(
  root: string,
  receipt: NativeGradleArtifactReceipt,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ hash: string; key: string; sdkDirectory: string; receipt: NativeGradleArtifactReceipt }> {
  signal?.throwIfAborted();
  const { build, abi } = receipt;
  if (!/^[a-f0-9]{64}$/.test(receipt.source)) throw new Error('The completed Gradle source identity is invalid.');
  const declaration = gradleArtifactInputs(receipt.declaration);
  const localFiles = declaration.localFiles.map((file) => resolve(root, file));
  for (const path of localFiles) {
    const info = await stat(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && !info.isFile()) throw new Error('android.artifactInputs.localFiles must name exact regular files.');
  }
  const properties = join(root, 'local.properties');
  const sdkDirectory = await realpath(androidHome(env));
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const gradleHome = env.GRADLE_USER_HOME ?? join(home, '.gradle');
  const inputs = [
    { name: 'jdk-release', path: await javaRelease(env, signal), optional: false },
    ...['gradle.properties', 'init.gradle', 'init.gradle.kts', 'init.d'].map((name) => ({
      name: `gradle-user/${name}`,
      path: join(gradleHome, name),
      optional: true,
    })),
  ];
  for (const group of ['build-tools', 'platforms', 'ndk', 'cmake']) {
    const directory = join(sdkDirectory, group);
    const versions = await readdir(directory).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    });
    for (const version of versions.toSorted()) {
      if (!(await stat(join(directory, version))).isDirectory()) continue;
      const path = join(directory, version, 'source.properties');
      if ((await optionalText(path, signal)) !== null)
        inputs.push({ name: `sdk/${group}/${version}`, path, optional: false });
    }
  }
  if (!inputs.some((input) => input.name.startsWith('sdk/build-tools/')))
    throw new Error('Android SDK build-tools version metadata is unavailable.');
  const preferences = [
    join(home, '.android'),
    ...(env.ANDROID_USER_HOME ? [env.ANDROID_USER_HOME] : []),
    ...['ANDROID_PREFS_ROOT', 'ANDROID_SDK_HOME', 'TEST_TMPDIR'].flatMap((name) =>
      env[name] ? [join(env[name], '.android')] : [],
    ),
  ];
  for (const [index, directory] of [...new Set(preferences)].entries())
    inputs.push({ name: `debug-keystore/${index}`, path: join(directory, 'debug.keystore'), optional: true });
  for (const [index, path] of localFiles.entries()) inputs.push({ name: `local/${index}`, path, optional: true });
  const environment = Object.fromEntries(
    [...new Set([...declaration.environment, 'JAVA_OPTS', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'GRADLE_OPTS'])]
      .toSorted()
      .map((name) => [name, env[name] ?? null]),
  );
  const localProperties = await localPropertiesIdentity(properties, sdkDirectory, root, signal);
  const local = await fingerprintNativeInputs(inputs, {
    parameters: {
      declaration,
      environment,
      localProperties: createHash('sha256').update(JSON.stringify(localProperties)).digest('hex'),
    },
    signal,
  });
  const hash = createHash('sha256')
    .update('stim-native-gradle-artifact-v1\0')
    .update(
      JSON.stringify({
        source: receipt.source,
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
  return {
    hash,
    key: buildCacheKey('android', hash, { variant: build.variant ?? 'debug', ...(abi ? { abi } : {}) }),
    sdkDirectory,
    receipt: { source: receipt.source, declaration, build, abi },
  };
}
