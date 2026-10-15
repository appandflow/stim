import { runCancellationSignal } from '../engine/native-run.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidHome, findBuildTool } from '../devices/android.ts';
import { getExecutor } from '../exec.ts';
import { explainBuildMiss, skippedMissReason } from '../cache/miss-reason.ts';
import { androidProcessRuntime } from '../commands/android/launch.ts';
import { buildGradle, androidSdkRefusal, type GradlePreflightFailure, type LocateApkResult } from '../engine/gradle.ts';
import { resolveCcache } from '../engine/ccache.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { androidToolchainAsync } from '../offload/toolchain.ts';
import { settingValueAt } from '../workspace/settings.ts';
import { gradleOffloadInputs, nativeGradleTransfer, type GradleTransfer } from './native-gradle-inputs.ts';
import {
  gradleArtifactInputs,
  nativeGradleArtifactSnapshot,
  NATIVE_GRADLE_CACHE_LIMIT,
} from './native-gradle-artifact-inputs.ts';
import { materializeNativeApk, nativeAndroidCache } from './native-android-cache.ts';
import { planNativeAndroid } from './native-android-plan.ts';
import type { AndroidProject } from './android-project.ts';
import type { ProjectDoctor } from './project-doctor.ts';

const CACHE_LIMIT = `${NATIVE_GRADLE_CACHE_LIMIT} Offload requires a separate complete android.offloadInputs declaration and remains uncached.`;
const MODEL_LIMIT =
  'Native Android requires AGP with androidComponents, one application module and configuration-on-demand disabled. Gradle resolves the exact variant and APK outputs during the build.';

interface NativeApkModel {
  schema: 1;
  module: string;
  variant: string;
  applicationId: string;
  sdkDirectory: string;
  elements: { path: string; filters: { type: string; value: string }[] }[];
}

function refusal(reason: string): GradlePreflightFailure {
  return {
    code: 'STIM_BUILD_FAILED',
    reason,
    remedy:
      'Select one signed standalone APK for the requested variant and target ABI in the Android application module, then retry. Stim does not sign APKs or install split APK sets.',
  };
}

export function selectNativeApk(
  value: unknown,
  variant: string,
  abi: string | null,
): LocateApkResult | GradlePreflightFailure {
  const model = value as NativeApkModel | null;
  if (
    !model ||
    model.schema !== 1 ||
    typeof model.module !== 'string' ||
    !model.module.startsWith(':') ||
    model.variant !== variant ||
    typeof model.applicationId !== 'string' ||
    !/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(model.applicationId) ||
    typeof model.sdkDirectory !== 'string' ||
    !isAbsolute(model.sdkDirectory) ||
    !Array.isArray(model.elements) ||
    !model.elements.every(
      (element) =>
        element &&
        typeof element.path === 'string' &&
        isAbsolute(element.path) &&
        element.path.endsWith('.apk') &&
        Array.isArray(element.filters) &&
        element.filters.every(
          (filter) => filter && typeof filter.type === 'string' && typeof filter.value === 'string',
        ),
    )
  )
    return refusal('Gradle did not export a valid model for the requested native Android variant.');
  const universal = model.elements.filter((element) => element.filters.length === 0);
  const candidates = universal.length
    ? universal
    : model.elements.filter(
        (element) =>
          abi !== null &&
          element.filters.length === 1 &&
          element.filters[0]!.type === 'ABI' &&
          element.filters[0]!.value === abi,
      );
  if (candidates.length !== 1)
    return refusal(
      `Native variant "${variant}" has ${candidates.length} installable APK candidates for ${abi ?? 'an unspecified ABI'}. Density splits and ambiguous output sets are unsupported.`,
    );
  return { apkPath: candidates[0]!.path, androidPackage: model.applicationId };
}

async function locateNativeApk(
  modelFile: string,
  variant: string,
  abi: string | null,
): Promise<LocateApkResult | GradlePreflightFailure> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(modelFile, 'utf8'));
  } catch {
    return refusal('Gradle succeeded without exporting the native Android APK model.');
  }
  const located = selectNativeApk(value, variant, abi);
  if ('code' in located) return located;
  try {
    if (!statSync(located.apkPath!).isFile()) return refusal('The APK selected by Gradle is not a file.');
  } catch {
    return refusal('The APK selected by Gradle does not exist.');
  }
  const signer = findBuildTool(['apksigner'], { home: (value as NativeApkModel).sdkDirectory });
  if (!signer) return refusal('No Android SDK apksigner is available to verify the native APK signature.');
  try {
    await getExecutor().runFileAsync(signer.path, ['verify', located.apkPath!], { timeoutMs: 30_000 });
  } catch (error) {
    return refusal(`The native APK signature could not be verified: ${(error as Error).message}`);
  }
  return located;
}

export function nativeAndroidProject(root: string): AndroidProject {
  return {
    isExpo: false,
    packageRemedy: 'Check the applicationId reported by AGP for the selected application variant.',
    appIds: () => ({ bundleId: null, androidPackage: null }),
    variantProblem: () => null,
    targets: ['emulator', 'physical', 'hosted'],
    eas: false,
    runtimeKind: () => 'process',
    plan: (options, resolved, operation) => planNativeAndroid(root, options, resolved, operation),
    runtime: ({ phase }) =>
      androidProcessRuntime(async () => {
        phase('metro', 'skipped (native process)');
        return { ok: true, prepared: { metroPort: null } };
      }),
    artifact: ({ operation, cacheArtifacts, writer, buildPlan, target, out, estimates, settings }) => {
      const variant = buildPlan.variant ?? 'debug';
      const inputs = settingValueAt(settings, 'android.offloadInputs');
      const artifactInputs = settingValueAt(settings, 'android.artifactInputs');
      let snapshot: Awaited<ReturnType<typeof nativeGradleArtifactSnapshot>> | null = null;
      let cacheRefusal: string | null = CACHE_LIMIT;
      let compiledPackage: string | null = null;
      let compiledSdk: string | null = null;
      const signal = runCancellationSignal(operation) ?? operation?.signal;
      const read = () => {
        if (!operation) throw new Error('Native APK caching requires an operation context.');
        return nativeGradleArtifactSnapshot(root, artifactInputs, buildPlan, target.abi, operation.env, signal);
      };
      let transfer: GradleTransfer | null = null;
      const modelFile = join(workspaceDir(root), 'gradle-build', `native-apk-${encodeURIComponent(variant)}.json`);
      return {
        cacheScope: 'local',
        identity: async () => {
          if (cacheArtifacts === false)
            return { cacheIneligible: 'Native Gradle worker artifacts have no reusable APK identity.' };
          try {
            snapshot = await read();
            cacheRefusal = null;
            return snapshot;
          } catch (error) {
            signal?.throwIfAborted();
            cacheRefusal = error instanceof Error ? error.message : String(error);
            return { cacheIneligible: cacheRefusal };
          }
        },
        cache: () => {
          if (!snapshot) throw new Error(CACHE_LIMIT);
          return nativeAndroidCache(snapshot.sdkDirectory, target.abi, () => compiledPackage, operation);
        },
        prepare: async () => {},
        reconcile: async () => {
          if (snapshot) {
            try {
              snapshot = await read();
            } catch {
              signal?.throwIfAborted();
              snapshot = null;
            }
          }
          return { identity: snapshot, rekeyedBy: [], cacheRefusal: null };
        },
        validate: async () => {
          if (!snapshot || compiledSdk !== snapshot.sdkDirectory) return null;
          try {
            return (await read()).hash === snapshot.hash ? snapshot : null;
          } catch {
            signal?.throwIfAborted();
            return null;
          }
        },
        materialize: async (key, path) => {
          if (!snapshot) return null;
          try {
            if ((await read()).hash !== snapshot.hash) return null;
            return await materializeNativeApk(key, path, snapshot.sdkDirectory, target.abi, operation);
          } catch {
            signal?.throwIfAborted();
            return null;
          }
        },
        explain: (rekeyedBy) => ({
          reason: snapshot
            ? explainBuildMiss({ root, platform: 'android', current: { hash: snapshot.hash, sources: [] }, rekeyedBy })
                .reason
            : skippedMissReason(cacheRefusal ?? CACHE_LIMIT),
          diff: null,
        }),
        untrackedLine: () => null,
        legacyCache: null,
        offload: {
          supportsUncachedArtifacts: true,
          uncachedArtifacts: true,
          get unsupported() {
            if (buildPlan.cas) return 'Apple Clang CAS builds build here';
            try {
              gradleOffloadInputs(inputs);
              return null;
            } catch (error) {
              return (error as Error).message;
            }
          },
          target: async () => {
            transfer = await nativeGradleTransfer(root, inputs, runCancellationSignal(operation) ?? operation?.signal);
            return {
              platform: 'android',
              native: 'gradle',
              local: await androidToolchainAsync(operation?.env),
              requires: { ndk: null, buildTools: null, compileSdk: null },
            };
          },
          get request() {
            if (!transfer) throw new Error('Native Gradle offload needs a declared source inventory.');
            return {
              platform: 'android' as const,
              isExpo: false,
              native: { provider: 'gradle' as const, transfer },
              android: {
                variant,
                abi: target.abi,
                gradleBuildCache: buildPlan.gradleBuildCache,
                pch: buildPlan.pch,
                compilerCache: buildPlan.compilerCache === 'none' ? ('none' as const) : ('ccache' as const),
              },
            };
          },
          unchanged: async () =>
            transfer !== null &&
            (await nativeGradleTransfer(root, inputs, runCancellationSignal(operation) ?? operation?.signal)).digest ===
              transfer.digest,
        },
        compile: async () => {
          const script = ['../shim/native-android.gradle', '../../shim/native-android.gradle']
            .map((path) => fileURLToPath(new URL(path, import.meta.url)))
            .find(existsSync);
          if (!script) throw new Error('Stim installation is missing shim/native-android.gradle.');
          const result = await buildGradle(
            {
              root,
              logWriter: writer,
              variant,
              project: {
                directory: root,
                gradlew: join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
                module: ':',
                outputsDir: root,
              },
              task: ':stimExportAndroidApk',
              projectArgs: [
                '--init-script',
                script,
                `-Pstim.native.variant=${variant}`,
                `-Pstim.native.model=${modelFile}`,
              ],
              locate: async () => {
                const located = await locateNativeApk(modelFile, variant, target.abi);
                if (!('code' in located)) {
                  compiledSdk = await realpath(JSON.parse(readFileSync(modelFile, 'utf8')).sdkDirectory);
                  compiledPackage = located.androidPackage ?? null;
                }
                return located;
              },
            },
            {
              estimateMs: estimates().coldBuildMs,
              onHeartbeat: out,
              onNote: out,
              ccache:
                buildPlan.compilerCache === 'ccache' ? resolveCcache({ root, onNote: out, env: operation?.env }) : null,
              cas: buildPlan.cas,
              buildCache: buildPlan.gradleBuildCache,
              pch: buildPlan.pch,
              compilerCacheDisabled: buildPlan.compilerCache === 'none',
            },
          );
          return result;
        },
      };
    },
  };
}

export function nativeAndroidDoctor(root: string): ProjectDoctor {
  return {
    inspect: ({ settings }) => {
      let cache = CACHE_LIMIT;
      try {
        gradleArtifactInputs(settingValueAt(settings, 'android.artifactInputs'));
        cache =
          'Local native APK caching uses the project-declared complete inputs. Build workers remain uncached and need their separate android.offloadInputs declaration.';
      } catch {}
      const sdkPath = androidHome();
      const sdk = androidSdkRefusal({
        sdkPath,
        sdkExists: existsSync(sdkPath),
        hasLocalProperties: existsSync(join(root, 'local.properties')),
        localPropertiesPath: 'local.properties',
      });
      const wrapper = join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
      return [
        {
          level: 'note',
          title: 'Native Android Gradle project',
          detail: `${MODEL_LIMIT} ${cache} Metro and EAS are unsupported; local, physical and hosted targets use native process readiness.`,
          fix: null,
        },
        ...(sdk
          ? [
              {
                level: 'cost' as const,
                code: 'android-sdk-missing',
                title: 'No Android SDK was found',
                detail: sdk.reason,
                fix: sdk.remedy,
              },
            ]
          : []),
        ...(!existsSync(wrapper)
          ? [
              {
                level: 'cost' as const,
                code: 'android-wrapper-missing',
                title: 'The Gradle wrapper for this host is missing',
                detail: wrapper,
                fix: 'Restore the project Gradle wrapper.',
              },
            ]
          : []),
      ];
    },
  };
}
