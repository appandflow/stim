import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidHome, findBuildTool } from '../devices/android.ts';
import { getExecutor } from '../exec.ts';
import { skippedMissReason } from '../cache/miss-reason.ts';
import { androidProcessRuntime } from '../commands/android/launch.ts';
import { buildGradle, androidSdkRefusal, type GradlePreflightFailure, type LocateApkResult } from '../engine/gradle.ts';
import { resolveCcache } from '../engine/ccache.ts';
import { workspaceDir } from '../workspace/paths.ts';
import type { AndroidProject } from './android-project.ts';
import type { ProjectDoctor } from './project-doctor.ts';

const CACHE_LIMIT =
  'Native Gradle inputs can include arbitrary external files and plugins; Stim artifact caching and build offload are unavailable. Gradle still owns incremental and task-cache reuse.';
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
    targets: ['emulator', 'physical'],
    eas: false,
    runtimeKind: () => 'process',
    plan: async () => ({
      refusal: {
        code: 'STIM_BAD_ARG',
        message: `${MODEL_LIMIT} --plan does not execute Gradle. ${CACHE_LIMIT}`,
        remedy: 'Run `stim android` with an exact --variant to resolve and build the native app.',
      },
    }),
    runtime: ({ phase }) =>
      androidProcessRuntime(async () => {
        phase('metro', 'skipped (native process)');
        return { ok: true, prepared: { metroPort: null } };
      }),
    artifact: ({ writer, buildPlan, target, out, estimates }) => {
      const variant = buildPlan.variant ?? 'debug';
      const modelFile = join(workspaceDir(root), 'gradle-build', `native-apk-${encodeURIComponent(variant)}.json`);
      return {
        identity: async () => ({ cacheIneligible: CACHE_LIMIT }),
        cache: () => {
          throw new Error(CACHE_LIMIT);
        },
        prepare: async () => {},
        reconcile: async () => ({ identity: null, rekeyedBy: [], cacheRefusal: null }),
        validate: async () => null,
        materialize: async () => null,
        explain: () => ({ reason: skippedMissReason(CACHE_LIMIT), diff: null }),
        untrackedLine: () => null,
        legacyCache: null,
        offload: null,
        compile: async () => {
          const script = ['../shim/native-android.gradle', '../../shim/native-android.gradle']
            .map((path) => fileURLToPath(new URL(path, import.meta.url)))
            .find(existsSync);
          if (!script) throw new Error('Stim installation is missing shim/native-android.gradle.');
          return buildGradle(
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
              locate: () => locateNativeApk(modelFile, variant, target.abi),
            },
            {
              estimateMs: estimates().coldBuildMs,
              ccache: buildPlan.compilerCache === 'ccache' ? resolveCcache({ root, onNote: out }) : null,
              cas: buildPlan.cas,
              buildCache: buildPlan.gradleBuildCache,
              pch: buildPlan.pch,
              compilerCacheDisabled: buildPlan.compilerCache === 'none',
            },
          );
        },
      };
    },
  };
}

export function nativeAndroidDoctor(root: string): ProjectDoctor {
  return {
    inspect: () => {
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
          detail: `${MODEL_LIMIT} ${CACHE_LIMIT} Metro, EAS and remote targets are unsupported.`,
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
