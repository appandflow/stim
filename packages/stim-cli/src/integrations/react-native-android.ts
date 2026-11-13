import chalk from 'chalk';
import { processContext } from '../cli-operation.ts';
import {
  buildCacheKey,
  changedDuringBuildLine,
  filesystemBuildCapability,
  fingerprintDiffRecord,
  storedInputs,
  resolveBuild,
  storeBuild,
  type BuildStore,
  storedAssetManifest,
  untrackedMissLine,
  untrackedNativeFiles,
} from '../cache/build-cache.ts';
import { configInputsChanged, inputsChangedDuringBuild } from '../fingerprint/changes.ts';
import { fingerprint, type Fingerprint } from '../fingerprint/evaluate.ts';
import {
  fingerprintForBuild,
  fingerprintInstallWarning,
  fingerprintOffloadInputs,
  type FingerprintCheck,
} from '../fingerprint/operation.ts';
import { explainBuildMiss } from '../fingerprint/miss.ts';
import { isUncertain } from '../fingerprint/key.ts';
import type { StaticTarget } from '../fingerprint/inputs.ts';
import { runCancellationSignal } from '../engine/native-run.ts';
import { formatDuration, shortHash } from '../command-output.ts';
import { androidMetroRuntime, androidProcessRuntime } from '../commands/android/launch.ts';
import { existsSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { androidHome } from '../devices/android.ts';
import { androidSdkRefusal } from '../engine/gradle.ts';
import {
  androidGradleProject,
  androidJobLayout,
  apkPackage,
  displayPath,
  dumpApkManifest,
} from '../commands/android/support.ts';
import { resolveKeystore, swapApkBundle, zipalignAndSignApk } from '../engine/apk-swap.ts';
import { captureAssetManifest } from '../engine/asset-manifest.ts';
import { resolveCcache } from '../engine/ccache.ts';
import {
  planPrebuild,
  runPrebuild,
  prebuildPlanRefusal,
  planUnfingerprintedPrebuild,
  recordPrebuildAsync,
} from '../engine/prebuild.ts';
import { loadProjectProvider } from '../engine/remote-cache.ts';
import { androidRequirements, androidToolchainAsync } from '../engine/toolchain.ts';
import { detectAndroidPackage, detectAppIds } from '../workspace/app-id.ts';
import { detectIsExpo } from '../workspace/project-files.ts';
import {
  fingerprintInputsSetting,
  resolveAndroidLayout,
  settingOriginScope,
  settingsLayers,
  type AndroidLayout,
  type ResolvedProjectSettings,
} from '../workspace/settings.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { androidPathRoomRefusal } from '../engine/android-path-limit.ts';
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
  fingerprint?: typeof fingerprint;
  fingerprintForBuild?: typeof fingerprintForBuild;
  untracked?: typeof untrackedNativeFiles;
  resolveCached?: typeof resolveBuild;
  storeCached?: BuildStore;
  storedAssets?: typeof storedAssetManifest;
  captureAssets?: typeof captureAssetManifest;
  loadProvider?: typeof loadProjectProvider;
  planPrebuildFor?: typeof planPrebuild;
  prebuild?: typeof runPrebuild;
  build?: typeof buildAndroid;
  ccacheFor?: typeof resolveCcache;
  swapApk?: typeof swapApkBundle;
  signApk?: typeof zipalignAndSignApk;
  readState?: typeof readWorkspaceState;
  platform?: NodeJS.Platform;
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
    plan: (options, resolved, operation) =>
      planReactNativeAndroid(
        root,
        options,
        runtimeKind,
        resolved,
        layout,
        variantProblem,
        dependencies.plan,
        operation,
      ),
    isExpo,
    appIds: () => detectAppIds(root, undefined, layout.moduleDir),
    packageRemedy: `Set \`expo.android.package\` in app.json / app.config.js, or \`namespace\` in ${relative(root, layout.moduleDir) || '.'}/build.gradle.`,
    variantProblem,
    targets: ['emulator', 'physical', 'hosted', 'remote'],
    preflight: (target) => {
      const sdkPath = androidHome();
      return (
        androidPathRoomRefusal(root, { ...target, platform: dependencies.platform }) ??
        androidSdkRefusal({
          sdkPath,
          sdkExists: existsSync(sdkPath),
          hasLocalProperties: existsSync(join(layout.gradleRoot, 'local.properties')),
          localPropertiesPath: relative(root, join(layout.gradleRoot, 'local.properties')).split(sep).join('/'),
        })
      );
    },
    eas: true,
    runtimeKind,
    runtime: ({ build, prepareMetro, phase }) =>
      runtimeKind(build) === 'embedded-js'
        ? androidProcessRuntime(async () => {
            phase('metro', `skipped (${build.variant}: the JS bundle is embedded, no dev server is used)`);
            return { ok: true, prepared: { metroPort: null } };
          }, 'embedded-js')
        : androidMetroRuntime(prepareMetro),
    artifact: (artifactContext) =>
      reactNativeAndroidArtifact(
        artifactContext,
        isExpo,
        layout,
        context,
        fingerprintInputsSetting(settings),
        dependencies,
      ),
  };
}

function reactNativeAndroidArtifact(
  {
    operation,
    root,
    buildLog,
    writer,
    settings,
    buildPlan,
    target,
    phase,
    out,
    step,
    estimates,
  }: AndroidArtifactContext,
  isExpo: boolean,
  layout: AndroidLayout,
  context: ResolvedProjectSettings['context'],
  fingerprintInputs: string[] | undefined,
  {
    fingerprint: computeFingerprint = fingerprint,
    fingerprintForBuild: computeForBuild = fingerprintForBuild,
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
    signApk = zipalignAndSignApk,
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
  const fpTarget: StaticTarget = {
    platform: 'android',
    androidLayout: layout,
    ...(fingerprintInputs === undefined ? {} : { fingerprintInputs }),
  };
  const embedMode = release ? 'production' : 'development';
  let lookupFingerprint: Fingerprint | null = null;
  let storeFingerprint: Fingerprint | null = null;
  let prebuildRan = false;
  let editedConfig: string[] = [];
  let fingerprintCheck: FingerprintCheck | null = null;
  const identity = () => ({ hash, key: buildCacheKey('android', hash, runOptions) });

  const computeFresh = async (): Promise<Fingerprint | null> => {
    const runSignal = operation ? runCancellationSignal(operation) : undefined;
    const signal = operation && runSignal ? AbortSignal.any([operation.signal, runSignal]) : operation?.signal;
    try {
      const result = await computeFingerprint(root, fpTarget, {
        env: operation?.env ?? processContext(root).env,
        embedMode,
        signal,
        operation,
        index: 'skip',
      });
      signal?.throwIfAborted();
      return isUncertain(result) ? null : result;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'reportCleanup' in error) throw error;
      signal?.throwIfAborted();
      return null;
    }
  };

  const releaseKeystore = () => {
    const committed = settingOriginScope(settingsLayers(context), 'android.keystore') === 'committed';
    return resolveKeystore(root, settings, layout, committed ? (context.repoRoot ?? root) : null);
  };

  const materialize: AndroidArtifactRecipe['materialize'] = async (key, cachedPath) => {
    if (!release) return { apkPath: cachedPath, directory: null };
    const assets = storedAssets('android', key);
    if (!assets) {
      phase(
        'swap',
        chalk.yellow(
          `no asset list beside this cached ${variant} APK, because another machine built it or it predates asset tracking, so its JS cannot be replaced -- building fresh instead`,
        ),
      );
      return null;
    }
    phase('swap', `regenerating this workspace's JS for the cached ${variant} APK`);
    let keystore;
    try {
      keystore = releaseKeystore();
    } catch (error) {
      phase('swap', chalk.yellow(`${(error as Error).message} -- building fresh instead`));
      return null;
    }
    const swap = await swapApk({
      context: operation,
      onHeartbeat: out,
      root,
      isExpo,
      cachedApkPath: cachedPath,
      keystore,
      layout,
      logWriter: writer,
      storedAssets: assets,
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
    embedsJs: release,
    fingerprintCheck: () => fingerprintCheck,
    async identity() {
      try {
        const computed = await computeForBuild(root, fpTarget, {
          operation,
          embedMode,
          consult: buildPlan.cache.read,
          onDisagreement: (line) => phase('fingerprint', chalk.yellow(line)),
        });
        if ('uncertain' in computed) return { cacheIneligible: computed.uncertain };
        lookupFingerprint = storeFingerprint = computed.fingerprint;
        fingerprintCheck = computed.check;
        hash = computed.fingerprint.hash;
        if (computed.fingerprint.from === 'index')
          phase('fingerprint', chalk.dim('matches a recorded fingerprint; confirming it in the background'));
        return identity();
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'reportCleanup' in error) throw error;
        operation?.signal.throwIfAborted();
        if (operation) runCancellationSignal(operation)?.throwIfAborted();
        return { cacheIneligible: `Could not fingerprint the native inputs: ${String(error)}` };
      }
    },
    cache: (compiled = false) =>
      filesystemBuildCapability({
        context: operation,
        resolve: resolveCached,
        store: storeCached,
        inputs: storeFingerprint
          ? { schema: storeFingerprint.schema, hash: storeFingerprint.hash, inputs: storeFingerprint.inputs }
          : null,
        readAppId: async (path) => apkPackage(await dumpApkManifest(path, { context: operation })),
        ...(compiled ? { assetManifest: release ? captureAssets(root, { variant, layout }) : null } : {}),
      }),
    async prepare(beforePrepare) {
      const plan = storeFingerprint
        ? planPrebuildFor(root, 'android', { isExpo, fingerprint: hash, native: storeFingerprint.native })
        : await planUnfingerprintedPrebuild(root, 'android', isExpo, operation?.signal);
      prebuildRan = plan === 'generate' || plan === 'regenerate';
      if (plan === 'refuse') {
        if (!storeFingerprint)
          throw new AndroidRecipeRefusal({
            code: 'STIM_NO_FINGERPRINT',
            message: 'Cannot verify the existing Android native directory without a fingerprint.',
            remedy: 'Resolve the fingerprint error and retry before changing generated native files.',
            extra: { lastBuildStatus: true },
          });
        const refusal = prebuildPlanRefusal(root, 'android');
        throw new AndroidRecipeRefusal({ ...refusal, extra: { lastBuildStatus: true } });
      }
      if (!prebuildRan) return;
      beforePrepare();
      step('prebuild');
      await recordPrebuildAsync(root, 'android', null);
      const pre = await prebuild(root, 'android', writer, { isExpo });
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
        plan === 'generate' ? 'android/ generated' : 'android/ not generated from this fingerprint -> updated in place';
      phase('prebuild', `${outcome} (${formatDuration(pre.durationMs)})`);
    },
    async reconcile() {
      const rekeyedBy: string[] = [];
      if (prebuildRan && lookupFingerprint && storeFingerprint) {
        const after = await computeFresh();
        editedConfig = after ? configInputsChanged(lookupFingerprint, after, { prebuildRan }) : [];
        if (after && !editedConfig.length) await recordPrebuildAsync(root, 'android', after.hash);
        if (!after || editedConfig.length || after.native !== storeFingerprint.native) {
          hash = '';
        } else if (after.hash !== hash) {
          rekeyedBy.push('prebuild');
          phase('fingerprint', chalk.dim(`${shortHash(hash)} -> ${shortHash(after.hash)} (after prebuild)`));
          hash = after.hash;
          storeFingerprint = after;
        }
      }
      return {
        identity: hash ? identity() : null,
        rekeyedBy,
        cacheRefusal: editedConfig.length ? 'prebuild changed config inputs, so the APK cannot be cached' : null,
        ...(prebuildRan ? { androidPackage: await detectAndroidPackage(root, layout.moduleDir) } : {}),
      };
    },
    async validate() {
      if (editedConfig.length) {
        phase('fingerprint', chalk.yellow(changedDuringBuildLine(editedConfig)));
        return null;
      }
      if (!hash || !lookupFingerprint || !storeFingerprint) return null;
      const installWarning = fingerprintInstallWarning(root);
      if (installWarning) {
        phase('fingerprint', chalk.yellow(installWarning));
        return null;
      }
      const after = await computeFresh();
      const changed = after
        ? inputsChangedDuringBuild(lookupFingerprint, storeFingerprint, after, { prebuildRan })
        : [];
      if (!after || changed.length || after.native !== storeFingerprint.native) {
        phase(
          'fingerprint',
          chalk.yellow(
            changed.length
              ? changedDuringBuildLine(changed)
              : 'native inputs unavailable or changed after Gradle; the build will be installed but not cached',
          ),
        );
        return null;
      }
      if (after.hash !== hash) {
        phase('fingerprint', chalk.dim(`${shortHash(hash)} -> ${shortHash(after.hash)} (after Gradle)`));
        hash = after.hash;
        storeFingerprint = after;
      }
      return identity();
    },
    materialize,
    compile: () =>
      build(
        { root, layout, logWriter: writer, variant, abi: target.abi },
        {
          estimateMs: estimates().coldBuildMs,
          onHeartbeat: out,
          onNote: out,
          ccache:
            buildPlan.compilerCache === 'ccache' ? ccacheFor({ root, layout, onNote: out, env: operation?.env }) : null,
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
        current: { inputs: storeFingerprint?.inputs ?? [] },
        rekeyedBy,
        deps: { storedInputs, readState },
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
    expoCache:
      target.abi || cas || profile || !buildPlan.cache.remote
        ? null
        : {
            load: () => loadProvider(root, { context: operation, isExpo, config: lookupFingerprint?.config }),
            runOptions: Object.keys(runOptions).length ? runOptions : null,
          },
    offload: {
      unsupported: cas ? 'Apple Clang CAS builds build here' : !buildPlan.cache.write ? 'the build cache is off' : null,
      target: async () => ({
        platform: 'android',
        local: await androidToolchainAsync(operation?.env),
        requires: androidRequirements(root, layout.gradleRoot),
      }),
      request: {
        platform: 'android',
        cacheArtifact: !release && buildPlan.cache.write && buildPlan.cache.remote,
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
      fingerprintInputs: async () => {
        if (!storeFingerprint) return { uncertain: 'the native fingerprint is unavailable' };
        const full = await computeFresh();
        if (!full || full.hash !== storeFingerprint.hash)
          return { uncertain: 'the native inputs changed before offload' };
        return fingerprintOffloadInputs(root, fpTarget, full, operation?.env ?? processContext(root).env);
      },
      syncPlan: async (repoRoot: string, paths: readonly string[]) => {
        const keystore = resolveKeystore(root, settings, layout);
        const { androidSyncPlan } = await import('../offload/signing-files.ts');
        return androidSyncPlan(repoRoot, paths, {
          release,
          configured: [
            keystore.path,
            ...(keystore.pass.startsWith('file:') ? [resolvePath(root, keystore.pass.slice('file:'.length))] : []),
          ],
          projectScripts: [layout.gradleRoot, layout.moduleDir].flatMap((dir) => [
            join(dir, 'build.gradle'),
            join(dir, 'build.gradle.kts'),
          ]),
        });
      },
      ...(release
        ? {
            signUnsigned: async (unsignedPath: string) => {
              let keystore;
              try {
                keystore = releaseKeystore();
              } catch (error) {
                return { failure: `could not sign the unsigned ${variant} APK here: ${String(error)}` };
              }
              if (!existsSync(keystore.path))
                return {
                  failure: `could not sign the unsigned ${variant} APK here: no keystore at ${displayPath(root, keystore.path)}`,
                };
              const signedPath = unsignedPath.replace(/-unsigned\.apk$/, '.apk');
              const failed = await signApk({
                context: operation,
                input: unsignedPath,
                output: signedPath,
                keystore,
              });
              return failed
                ? { failure: `could not sign the unsigned ${variant} APK here: ${failed.reason}` }
                : { apkPath: signedPath };
            },
          }
        : {}),
      unchanged: async () => {
        if (fingerprintInstallWarning(root)) return false;
        const after = await computeFresh();
        return Boolean(after && after.hash === hash);
      },
    },
  };
}
