import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCacheKey, filesystemBuildCapability } from '../cache/build-cache.ts';
import { skippedMissReason } from '../cache/miss-reason.ts';
import { androidProcessRuntime } from '../commands/android/launch.ts';
import { assembleTaskFor, buildGradle } from '../engine/gradle.ts';
import type { ProjectIntegration } from '../integrations/project-registry.ts';

export const nativeAndroidFixture: ProjectIntegration = {
  id: 'test-native-android',
  inspect(root) {
    if (!existsSync(join(root, 'build.gradle.kts'))) return null;
    return {
      root: 'candidate',
      application: true,
      platforms: () => ['android'],
      validate: (operation) => (operation === 'android' ? null : undefined),
      android: async () => ({
        isExpo: false,
        targets: ['emulator'],
        eas: false,
        packageRemedy: 'Check the selected native APK applicationId.',
        appIds: () => ({ bundleId: null, androidPackage: 'org.example.native' }),
        variantProblem: () => null,
        runtimeKind: () => 'process',
        runtime: () => androidProcessRuntime(async () => ({ ok: true, prepared: { metroPort: null } })),
        artifact: ({ writer, buildPlan, target }) => {
          let hash = '';
          const sourceHash = () => {
            const digest = createHash('sha256').update('test-native-android-v1');
            for (const path of ['build.gradle.kts', 'gradlew', 'mobile/src/Main.kt'])
              digest.update(path).update(readFileSync(join(root, path)));
            return digest.digest('hex');
          };
          const identity = () => ({
            hash,
            key: buildCacheKey('android', hash, {
              variant: buildPlan.variant ?? 'debug',
              ...(target.abi ? { abi: target.abi } : {}),
            }),
          });
          return {
            identity: async () => {
              hash = sourceHash();
              return identity();
            },
            cache: () => filesystemBuildCapability(),
            prepare: async () => {},
            reconcile: async () => ({ identity: identity(), rekeyedBy: [], cacheRefusal: null }),
            validate: async () => (sourceHash() === hash ? identity() : null),
            materialize: async (_key, apkPath) => ({ apkPath, directory: null }),
            compile: () =>
              buildGradle(
                {
                  root,
                  logWriter: writer,
                  variant: buildPlan.variant,
                  project: {
                    directory: root,
                    gradlew: join(root, 'gradlew'),
                    module: ':mobile',
                    outputsDir: join(root, 'products', 'apk'),
                  },
                  task: `:mobile:${assembleTaskFor(buildPlan.variant)}`,
                },
                { buildCache: buildPlan.gradleBuildCache, compilerCacheDisabled: true },
              ),
            explain: () => ({ reason: skippedMissReason('the native fixture source has no cached APK'), diff: null }),
            untrackedLine: () => null,
            legacyCache: null,
            offload: null,
          };
        },
      }),
    };
  },
};
