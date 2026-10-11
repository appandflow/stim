import chalk from 'chalk';
import type { FingerprintSource } from '@expo/fingerprint';
import {
  buildCacheKey,
  changedDuringBuildLine,
  configInputsChanged,
  filesystemBuildCapability,
  fingerprintDiffRecord,
  fingerprintProject,
  inputsChangedDuringBuild,
  refingerprintAfterMutation,
  resolveBuild,
  storeBuild,
  storedAssetManifest,
  untrackedMissLine,
  untrackedNativeFiles,
} from '../cache/build-cache.ts';
import { explainBuildMiss, fingerprintErrorMissReason } from '../cache/miss-reason.ts';
import { formatDuration, shortHash } from '../command-output.ts';
import { androidMetroRuntime, androidProcessRuntime } from '../commands/android/launch.ts';
import { relative } from 'node:path';
import { androidGradleProject, androidJobLayout, displayPath, NO_FINGERPRINT } from '../commands/android/support.ts';
import { resolveKeystore, swapApkBundle } from '../engine/apk-swap.ts';
import { captureAssetManifest } from '../engine/asset-manifest.ts';
import { resolveCcache } from '../engine/ccache.ts';
import { planPrebuild, recordPrebuild, runPrebuild, staleNativeDirRefusal } from '../engine/prebuild.ts';
import { loadProjectProvider } from '../engine/remote-cache.ts';
import { androidRequirements, androidToolchain } from '../offload/toolchain.ts';
import { detectAndroidPackage, detectAppIds } from '../workspace/app-id.ts';
import { detectIsExpo } from '../workspace/project-files.ts';
import {
  resolveAndroidLayout,
  settingOriginScope,
  settingsLayers,
  type AndroidLayout,
  type ResolvedProjectSettings,
} from '../workspace/settings.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { buildAndroid, productFlavorRefusal, readProductFlavors } from './react-native-build.ts';
import {
  AndroidRecipeRefusal,
  type AndroidArtifactContext,
  type AndroidArtifactRecipe,
  type AndroidProject,
} from './android-project.ts';

import { planReactNativeAndroid, type AndroidPlanDeps } from './react-native-android-plan.ts';

export interface ReactNativeAndroidDependencies {
  plan?: Partial<AndroidPlanDeps>;
  fingerprint?: typeof fingerprintProject;
  untracked?: typeof untrackedNativeFiles;
  resolveCached?: typeof resolveBuild;
  storeCached?: typeof storeBuild;
  storedAssets?: typeof storedAssetManifest;
  captureAssets?: typeof captureAssetManifest;
  loadProvider?: typeof loadProjectProvider;
  planPrebuildFor?: typeof planPrebuild;
  prebuild?: typeof runPrebuild;
  build?: typeof buildAndroid;
  ccacheFor?: typeof resolveCcache;
  swapApk?: typeof swapApkBundle;
  readState?: typeof readWorkspaceState;
}

const runtimeKind: AndroidProject['runtimeKind'] = ({ release }) => (release ? 'embedded-js' : 'metro');

export function reactNativeAndroidProject(
  root: string,
  { context, settings }: ResolvedProjectSettings,
  dependencies: ReactNativeAndroidDependencies = {},
): AndroidProject {
  const isExpo = detectIsExpo(root);
  const layout = resolveAndroidLayout(settings, root, context.repoRoot ?? root);
  const variantProblem: AndroidProject['variantProblem'] = (variant) =>
    productFlavorRefusal({ flavors: readProductFlavors(layout), variant });
  return {
    plan: (options, resolved) =>
      planReactNativeAndroid(root, options, runtimeKind, resolved, layout, variantProblem, dependencies.plan),
    isExpo,
    appIds: () => detectAppIds(root, undefined, layout.moduleDir),
    packageRemedy: `Set \`expo.android.package\` in app.json / app.config.js, or \`namespace\` in ${relative(root, layout.moduleDir) || '.'}/build.gradle.`,
    variantProblem,
    targets: ['emulator', 'physical', 'hosted', 'remote'],
    eas: true,
    runtimeKind,
    runtime: ({ build, prepareMetro, phase }) =>
      runtimeKind(build) === 'embedded-js'
        ? androidProcessRuntime(async () => {
            phase('metro', `skipped (${build.variant}: the JS bundle is embedded, no dev server is used)`);
            return { ok: true, prepared: { metroPort: null } };
          }, 'embedded-js')
        : androidMetroRuntime(prepareMetro),
    artifact: (artifactContext) => reactNativeAndroidArtifact(artifactContext, isExpo, layout, context, dependencies),
  };
}

function reactNativeAndroidArtifact(
  { root, buildLog, writer, settings, buildPlan, target, phase, out, step, estimates }: AndroidArtifactContext,
  isExpo: boolean,
  layout: AndroidLayout,
  context: ResolvedProjectSettings['context'],
  {
    fingerprint = fingerprintProject,
    untracked = untrackedNativeFiles,
    resolveCached = resolveBuild,
    storeCached = storeBuild,
    storedAssets = storedAssetManifest,
    captureAssets = captureAssetManifest,
    loadProvider = loadProjectProvider,
    planPrebuildFor = planPrebuild,
    prebuild = runPrebuild,
    build = buildAndroid,
    ccacheFor = resolveCcache,
    swapApk = swapApkBundle,
    readState = readWorkspaceState,
  }: ReactNativeAndroidDependencies,
): AndroidArtifactRecipe {
  const { variant, release, profile, cas } = buildPlan;
  const runOptions = {
    ...(variant ? { variant } : {}),
    ...(target.abi ? { abi: target.abi } : {}),
    ...(cas?.id ? { compiler: cas.id } : {}),
    ...(profile ? { buildProfile: profile } : {}),
    ...(androidGradleProject(layout) ? { gradleProject: androidGradleProject(layout)! } : {}),
  };
  let hash = '';
  let sources: FingerprintSource[] = [];
  let initialSources: FingerprintSource[] = [];
  let prebuildRan = false;
  let editedConfig: string[] = [];
  const identity = () => ({ hash, key: buildCacheKey('android', hash, runOptions) });

  const materialize: AndroidArtifactRecipe['materialize'] = async (key, cachedPath) => {
    if (!release) return { apkPath: cachedPath, directory: null };
    phase('swap', `regenerating this workspace's JS for the cached ${variant} APK`);
    let keystore;
    try {
      const committed = settingOriginScope(settingsLayers(context), 'android.keystore') === 'committed';
      keystore = resolveKeystore(root, settings, layout, committed ? (context.repoRoot ?? root) : null);
    } catch (error) {
      phase('swap', chalk.yellow(`${(error as Error).message} -- building fresh instead`));
      return null;
    }
    const swap = await swapApk({
      root,
      isExpo,
      cachedApkPath: cachedPath,
      keystore,
      layout,
      logWriter: writer,
      storedAssets: storedAssets('android', key),
    });
    if (swap?.ok && swap.apkPath) {
      if (swap.note) phase('swap', chalk.yellow(swap.note));
      phase(
        'swap',
        `${swap.hermes ? 'hermes bytecode' : 'plain JS'} repacked (store), zipaligned and re-signed (${formatDuration(swap.durationMs)})`,
      );
      return { apkPath: swap.apkPath, directory: swap.tmpDir ?? null };
    }
    if (swap?.assetMismatch) {
      phase(
        'swap',
        chalk.yellow(
          `${swap.reason} -- building fresh instead` +
            (swap.assetDiff ? ' (an APK cannot be made to carry an asset AAPT did not package)' : ''),
        ),
      );
    } else {
      phase(
        'swap',
        chalk.yellow(
          `failed at ${swap?.step || 'unknown step'}: ${swap?.reason || 'unknown reason'} -- ` +
            `building fresh instead (a cached ${variant} APK carries its builder's JS; it is never installed after a failed swap)`,
        ),
      );
    }
    for (const line of swap?.lastLines ?? []) phase('', chalk.dim(line));
    return null;
  };

  return {
    async identity() {
      let computed;
      try {
        computed = await fingerprint(root, { platform: 'android', androidLayout: layout });
      } catch (error) {
        const message = String((error as Error)?.message || error);
        throw new AndroidRecipeRefusal(
          {
            code: NO_FINGERPRINT,
            message: `@expo/fingerprint could not fingerprint ${root}: ${message}`,
            remedy: 'Fix the @expo/fingerprint error above, then retry.',
            extra: { lastBuildStatus: true },
          },
          fingerprintErrorMissReason(message),
        );
      }
      if (!computed?.hash)
        throw new AndroidRecipeRefusal(
          {
            code: NO_FINGERPRINT,
            message: `@expo/fingerprint returned no hash for ${root}, so the build cache cannot be addressed.`,
            remedy: 'Check the project native inputs and the @expo/fingerprint error above, then retry.',
            extra: { lastBuildStatus: true },
          },
          fingerprintErrorMissReason('no hash'),
        );
      hash = computed.hash;
      sources = initialSources = computed.sources ?? [];
      return identity();
    },
    cache: (compiled = false) =>
      filesystemBuildCapability({
        resolve: resolveCached,
        store: storeCached,
        sources,
        ...(compiled ? { assetManifest: release ? captureAssets(root, { variant, layout }) : null } : {}),
      }),
    async prepare(beforePrepare) {
      const plan = planPrebuildFor(root, 'android', { isExpo, fingerprint: hash, sources });
      prebuildRan = plan === 'generate' || plan === 'regenerate';
      if (plan === 'refuse') {
        const refusal = staleNativeDirRefusal('android');
        throw new AndroidRecipeRefusal({ ...refusal, extra: { lastBuildStatus: true } });
      }
      if (!prebuildRan) return;
      beforePrepare();
      step('prebuild');
      recordPrebuild(root, 'android', null);
      const pre = await prebuild(root, 'android', writer, { isExpo, clean: plan === 'regenerate' });
      if (pre.failed)
        throw new AndroidRecipeRefusal({
          code: pre.code,
          message: pre.reason,
          remedy: pre.remedy,
          extra: {
            lastBuildStatus: true,
            lines: (pre.lastLines ?? []).slice(-5),
            logPath: displayPath(root, buildLog),
          },
        });
      const outcome =
        plan === 'generate'
          ? 'android/ generated'
          : 'android/ not generated from this fingerprint -> regenerated with --clean';
      phase('prebuild', `${outcome} (${formatDuration(pre.durationMs)})`);
    },
    async reconcile() {
      const rekeyedBy: string[] = [];
      if (prebuildRan) {
        const after = await refingerprintAfterMutation({
          projectRoot: root,
          platform: 'android',
          androidLayout: layout,
          previousHash: hash,
          fingerprint,
        });
        editedConfig = after ? configInputsChanged(initialSources, after.sources, { prebuildRan }) : [];
        if (after && !editedConfig.length) recordPrebuild(root, 'android', after.hash);
        if (after?.moved && !editedConfig.length) {
          rekeyedBy.push('prebuild');
          phase('fingerprint', chalk.dim(`${shortHash(hash)} -> ${shortHash(after.hash)} (after prebuild)`));
          hash = after.hash;
          sources = after.sources;
        }
      }
      return {
        identity: identity(),
        rekeyedBy,
        cacheRefusal: editedConfig.length ? 'prebuild changed config inputs, so the APK cannot be cached' : null,
        ...(prebuildRan ? { androidPackage: detectAndroidPackage(root, layout.moduleDir) } : {}),
      };
    },
    async validate() {
      const after = editedConfig.length
        ? null
        : await refingerprintAfterMutation({
            projectRoot: root,
            platform: 'android',
            androidLayout: layout,
            previousHash: hash,
            fingerprint,
          });
      const changed = after
        ? inputsChangedDuringBuild({
            platform: 'android',
            lookup: initialSources,
            prebuildRan,
            compiled: sources,
            current: after.sources,
          })
        : editedConfig;
      if (!after || changed.length) {
        phase(
          'fingerprint',
          chalk.yellow(
            changed.length
              ? changedDuringBuildLine(changed)
              : 'unavailable after Gradle; the build will be installed but not cached',
          ),
        );
        return null;
      }
      if (after.moved) {
        phase('fingerprint', chalk.dim(`${shortHash(hash)} -> ${shortHash(after.hash)} (after Gradle)`));
        hash = after.hash;
        sources = after.sources;
      }
      return identity();
    },
    materialize,
    compile: () =>
      build(
        { root, layout, logWriter: writer, variant, abi: target.abi },
        {
          estimateMs: estimates().coldBuildMs,
          ccache: buildPlan.compilerCache === 'ccache' ? ccacheFor({ root, layout, onNote: out }) : null,
          cas,
          buildCache: buildPlan.gradleBuildCache,
          pch: buildPlan.pch,
          compilerCacheDisabled: buildPlan.compilerCache === 'none',
        },
      ),
    explain(rekeyedBy) {
      const explained = explainBuildMiss({
        root,
        platform: 'android',
        current: { hash, sources },
        rekeyedBy,
        baselineDeps: { readState },
      });
      return {
        reason: explained.reason,
        diff:
          explained.previousHash && explained.changedNames.length
            ? fingerprintDiffRecord({ changed: explained.changedNames, previousHash: explained.previousHash, hash })
            : null,
      };
    },
    untrackedLine: () => untrackedMissLine(untracked({ projectRoot: root })),
    // Expo's buildCacheProvider run options cannot key targeted ABIs or compiler profiles.
    legacyCache:
      target.abi || cas || profile || !buildPlan.cache.remote
        ? null
        : {
            load: () => loadProvider(root, { isExpo }),
            runOptions: Object.keys(runOptions).length ? runOptions : null,
          },
    offload: {
      unsupported: release
        ? `${variant} builds build here`
        : cas
          ? 'Apple Clang CAS builds build here'
          : !buildPlan.cache.write
            ? 'the build cache is off'
            : null,
      target: () => ({ platform: 'android', local: androidToolchain(), requires: androidRequirements(root) }),
      request: {
        platform: 'android',
        isExpo,
        android: {
          variant,
          abi: target.abi,
          gradleBuildCache: buildPlan.gradleBuildCache,
          pch: buildPlan.pch,
          compilerCache: buildPlan.compilerCache === 'none' ? 'none' : 'ccache',
          ...androidJobLayout(layout),
        },
      },
      unchanged: async () => {
        const after = await refingerprintAfterMutation({
          projectRoot: root,
          platform: 'android',
          androidLayout: layout,
          previousHash: hash,
          fingerprint,
        });
        return Boolean(after && !after.moved);
      },
    },
  };
}
