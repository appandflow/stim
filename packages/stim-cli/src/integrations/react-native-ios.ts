import { rmSync } from 'node:fs';
import chalk from 'chalk';
import { processContext } from '../cli-operation.ts';
import {
  buildCacheKey,
  changedDuringBuildLine,
  filesystemBuildCapability,
  fingerprintDiffRecord,
  storedInputs,
  untrackedMissLine,
} from '../cache/build-cache.ts';
import { configInputsChanged, inputsChangedDuringBuild } from '../fingerprint/changes.ts';
import {
  fingerprintInstallProblem,
  fingerprintOffloadInputs,
  type FingerprintCheck,
} from '../fingerprint/operation.ts';
import { explainBuildMiss } from '../fingerprint/miss.ts';
import { isUncertain } from '../fingerprint/key.ts';
import type { Fingerprint } from '../fingerprint/evaluate.ts';
import type { StaticTarget } from '../fingerprint/inputs.ts';
import { formatDuration, phaseLine, shortHash } from '../command-output.ts';
import { DEFAULT_DEPS, type IosDeps } from '../commands/ios/dependencies.ts';
import { iosMetroRuntime, iosProcessRuntime } from '../commands/ios/launch.ts';
import { iosProviderRunOptions, isReleaseConfiguration, podAction } from '../commands/ios/support.ts';
import type { FailArgs } from '../commands/ios/types.ts';
import { runCancellationSignal } from '../engine/native-run.ts';
import { easDeviceBuildRemedy } from '../engine/eas-build.ts';
import { copyAppAside, writeIpTxt } from '../engine/ios-lan.ts';
import { prebuildPlanRefusal, planUnfingerprintedPrebuild, recordPrebuildAsync } from '../engine/prebuild.ts';
import { bundlerPin } from '../engine/bundler.ts';
import { buildsOnlyOnWorker, iosToolchainAsync } from '../engine/toolchain.ts';
import { iosSyncPlan } from '../offload/signing-files.ts';
import {
  fingerprintInputsSetting,
  resolveIosProjectDir,
  type IosProjectDir,
  type SettingsObject,
} from '../workspace/settings.ts';
import { IosRecipeRefusal, type IosProject, type IosArtifactContext, type IosArtifactRecipe } from './ios-project.ts';

import { planReactNativeIos } from './react-native-ios-plan.ts';

const PLATFORM = 'ios';

type ReactNativeIosDependencies = Pick<
  IosDeps,
  | 'detectIsExpo'
  | 'detectBundleId'
  | 'discoverXcodeProject'
  | 'resolveScheme'
  | 'fingerprint'
  | 'fingerprintForBuild'
  | 'untrackedNativeFiles'
  | 'resolveBuild'
  | 'storeBuild'
  | 'readBundleId'
  | 'readWorkspaceState'
  | 'loadProjectProvider'
  | 'planPrebuild'
  | 'runPrebuild'
  | 'readPodState'
  | 'podsAreStale'
  | 'runPodInstall'
  | 'iosToolchain'
  | 'buildIos'
  | 'gateProfileForDevice'
  | 'sealAppForDevice'
  | 'devClientScheme'
  | 'swapJsBundle'
>;

async function reactNativeIosSchemeProblem(
  root: string,
  iosDir: string,
  scheme: string | undefined,
  isExpo: boolean,
  d: ReactNativeIosDependencies,
): Promise<FailArgs | null> {
  if (scheme === undefined) return null;
  if (!scheme.trim())
    return {
      code: 'STIM_BAD_ARG',
      message: '--scheme must name a non-empty shared Xcode app scheme.',
      remedy: 'Pass the exact scheme name shown by xcodebuild -list.',
    };
  if (isExpo) return null;
  const project = d.discoverXcodeProject(root, iosDir);
  if (project.error) return project.error;
  return (await d.resolveScheme(project, { scheme })).error ?? null;
}

const runtimeKind: IosProject['runtimeKind'] = (configuration) =>
  isReleaseConfiguration(configuration) ? 'embedded-js' : 'metro';

export function reactNativeIosProject(
  root: string,
  settings: SettingsObject,
  dependencies: Partial<IosDeps> = {},
): IosProject {
  const d: ReactNativeIosDependencies = { ...DEFAULT_DEPS, ...dependencies };
  const isExpo = d.detectIsExpo(root);
  const iosProject = resolveIosProjectDir(settings, root);
  return {
    plan: (options, resolved, operation) =>
      planReactNativeIos(
        root,
        options,
        { ...DEFAULT_DEPS, ...dependencies },
        (scheme) => reactNativeIosSchemeProblem(root, iosProject.dir, scheme, isExpo, d),
        resolved,
        operation,
      ),
    isExpo,
    bundleId: () => d.detectBundleId(root, iosProject.dir),
    schemeProblem: (scheme) => reactNativeIosSchemeProblem(root, iosProject.dir, scheme, isExpo, d),
    targets: ['simulator', 'physical', 'remote', 'hosted'],
    eas: true,
    runtimeKind,
    runtime: ({ configuration, prepareMetro, prepareEmbedded }) =>
      runtimeKind(configuration) === 'embedded-js'
        ? iosProcessRuntime(prepareEmbedded, 'embedded-js')
        : iosMetroRuntime(prepareMetro),
    artifact: (context) => reactNativeIosArtifact(context, isExpo, iosProject, d, fingerprintInputsSetting(settings)),
  };
}

function fail(failure: FailArgs): never {
  throw new IosRecipeRefusal(failure);
}

function reactNativeIosArtifact(
  {
    operation,
    root,
    logFile,
    configuration,
    buildScheme,
    buildProfile,
    target,
    device,
    easProfile,
    optimizations,
    cache: cachePolicy,
    phase,
    note,
    logWriter,
    estimates,
    step,
    setPodsMs,
  }: IosArtifactContext,
  isExpo: boolean,
  iosProject: IosProjectDir,
  d: ReactNativeIosDependencies,
  fingerprintInputs: string[] | undefined,
): IosArtifactRecipe {
  const signingOptions = { env: operation?.env, signal: runCancellationSignal(operation) ?? operation?.signal };
  const physical = device !== null;
  const { udid } = target;
  const release = isReleaseConfiguration(configuration);
  const keyOptions = {
    scheme: buildScheme,
    ...(configuration ? { configuration } : {}),
    isSimulator: !physical,
    ...(target.keyArch ? { arch: target.keyArch } : {}),
    ...(buildProfile ? { buildProfile } : {}),
  };
  const fpTarget: StaticTarget = {
    platform: PLATFORM,
    iosProjectPath: iosProject.relative,
    ...(fingerprintInputs === undefined ? {} : { fingerprintInputs }),
  };
  const embedMode = release ? 'production' : 'development';
  let lookupFingerprint: Fingerprint | null = null;
  let storeFingerprint: Fingerprint | null = null;
  let storeHash: string | null = null;
  let mutatingSteps: string[] = [];
  let fingerprintCheck: FingerprintCheck | null = null;
  const identity = () => (storeHash ? { hash: storeHash, key: buildCacheKey(PLATFORM, storeHash, keyOptions) } : null);
  const computeFresh = async (): Promise<Fingerprint | null> => {
    const runSignal = operation ? runCancellationSignal(operation) : undefined;
    const signal = operation && runSignal ? AbortSignal.any([operation.signal, runSignal]) : operation?.signal;
    try {
      const result = await d.fingerprint(root, fpTarget, {
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
  const materialize: IosArtifactRecipe['materialize'] = async (artifactPath, { fresh: isFresh, ownTemporary }) => {
    const lanAddress = device?.lanAddress ?? null;
    const metroPort = device?.metroPort ?? null;
    const prepareDeviceApp = async (
      path: string,
      physicalDevice: NonNullable<IosArtifactContext['device']>,
      { fresh }: { fresh: boolean },
    ): Promise<string | null> => {
      const refuse = (code: string, reason: string, remedy: string): null => {
        if (fresh) {
          fail({ code, message: reason, remedy, build: { appPath: path } });
        }
        note(chalk.yellow(phaseLine('cache', `${reason} -- building fresh instead`)));
        note(chalk.dim(phaseLine('', remedy)));
        return null;
      };
      const gateProfile = async (): Promise<string | null> => {
        const gate = await d.gateProfileForDevice({
          ...signingOptions,
          appPath: path,
          udid: physicalDevice.udid,
          configuration,
        });
        return gate.ok ? path : refuse(gate.code, gate.reason, gate.remedy);
      };

      if (release) {
        if (!fresh) {
          note(
            chalk.yellow(
              phaseLine(
                'cache',
                `a cached ${configuration} device app carries its builder's JS, and the device JS swap lands with ` +
                  "phase 6 of appandflow/stim#178 -- building fresh instead, which bakes in this workspace's JS",
              ),
            ),
          );
          return null;
        }
        return gateProfile();
      }

      const scheme = d.devClientScheme(root, path);
      if (scheme) return gateProfile();

      let copy: { tmpDir: string; appPath: string };
      try {
        copy = copyAppAside(path);
      } catch (e) {
        return refuse(
          'STIM_INSTALL_FAILED',
          `Could not copy ${path} aside to write its ip.txt: ${(e as Error)?.message || e}`,
          'Free space in the temporary directory and run the command again.',
        );
      }
      ownTemporary(copy.tmpDir);
      writeIpTxt(copy.appPath, lanAddress as string, metroPort as number);
      const sealed = await d.sealAppForDevice({
        ...signingOptions,
        appPath: copy.appPath,
        udid: physicalDevice.udid,
        configuration,
        pinnedName: physicalDevice.signingName ?? null,
        pinnedSha1: physicalDevice.signingSha1 ?? null,
      });
      if (!sealed.ok) {
        try {
          rmSync(copy.tmpDir, { recursive: true, force: true });
        } catch {}
        for (const line of sealed.lastLines ?? []) note(chalk.dim(phaseLine('', line)));
        return refuse(sealed.code, sealed.reason, sealed.remedy);
      }
      phase(
        'ip.txt',
        `${lanAddress}:${metroPort} written into the install copy and re-sealed with "${sealed.identity.name}"` +
          `${sealed.mode === 'preserve-metadata' ? '' : ` (${sealed.mode})`}`,
      );
      return copy.appPath;
    };

    const installableCachedApp = async (cachedPath: string): Promise<string | null> => {
      if (device) return prepareDeviceApp(cachedPath, device, { fresh: false });
      if (!release) return cachedPath;
      if (buildsOnlyOnWorker(await d.iosToolchain(root, null))) {
        note(
          chalk.yellow(
            phaseLine(
              'swap',
              `a cached ${configuration} app carries its builder's JS, and only a Mac with Xcode can replace it -- building fresh instead`,
            ),
          ),
        );
        return null;
      }
      phase('swap', `regenerating this workspace's JS for the cached ${configuration} app`);
      const swap = await d.swapJsBundle({
        context: operation,
        onHeartbeat: note,
        root,
        iosDir: iosProject.dir,
        isExpo,
        cachedAppPath: cachedPath,
        logWriter: logWriter(),
      });
      if (swap?.ok && swap.appPath) {
        if (swap.note) note(chalk.yellow(phaseLine('swap', swap.note)));
        if (swap.tmpDir) ownTemporary(swap.tmpDir);
        phase(
          'swap',
          `${swap.hermes ? 'hermes bytecode' : 'plain JS'} + assets replaced, re-signed (${formatDuration(swap.durationMs ?? 0)})`,
        );
        return swap.appPath;
      }
      note(
        chalk.yellow(
          phaseLine(
            'swap',
            `failed at ${swap?.step || 'unknown step'}: ${swap?.reason || 'unknown reason'} -- ` +
              `building fresh instead (a cached ${configuration} app carries its builder's JS; it is never installed after a failed swap)`,
          ),
        ),
      );
      for (const line of swap?.lastLines ?? []) note(chalk.dim(phaseLine('', line)));
      return null;
    };

    if (isFresh) return device ? prepareDeviceApp(artifactPath, device, { fresh: true }) : artifactPath;
    return installableCachedApp(artifactPath);
  };
  return {
    async identity() {
      try {
        const computed = await d.fingerprintForBuild(root, fpTarget, {
          operation,
          embedMode,
          consult: cachePolicy.read,
          onDisagreement: (line) => phase('fingerprint', chalk.yellow(line)),
        });
        if ('uncertain' in computed) return { cacheIneligible: computed.uncertain };
        lookupFingerprint = storeFingerprint = computed.fingerprint;
        fingerprintCheck = computed.check;
        storeHash = computed.fingerprint.hash;
        if (computed.fingerprint.from === 'index')
          phase('fingerprint', chalk.dim('matches a recorded fingerprint; confirming it in the background'));
        return { hash: computed.fingerprint.hash, key: buildCacheKey(PLATFORM, computed.fingerprint.hash, keyOptions) };
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'reportCleanup' in error) throw error;
        const runSignal = operation ? runCancellationSignal(operation) : undefined;
        operation?.signal.throwIfAborted();
        runSignal?.throwIfAborted();
        return { cacheIneligible: `Could not fingerprint the native inputs: ${String(error)}` };
      }
    },
    fingerprintCheck: () => fingerprintCheck,
    cache: () =>
      filesystemBuildCapability({
        context: operation,
        resolve: d.resolveBuild,
        store: d.storeBuild,
        inputs: storeFingerprint
          ? { schema: storeFingerprint.schema, hash: storeFingerprint.hash, inputs: storeFingerprint.inputs }
          : null,
        readAppId: (path) => d.readBundleId(path),
      }),
    async validateExternal(path) {
      if (device) {
        const gate = await d.gateProfileForDevice({
          ...signingOptions,
          appPath: path,
          udid: device.udid,
          configuration,
        });
        if (!gate.ok) {
          fail({ code: gate.code, message: gate.reason, remedy: easDeviceBuildRemedy(easProfile!) });
        }
        if (!d.devClientScheme(root, path)) {
          fail({
            code: 'STIM_BAD_ARG',
            message: 'The EAS device app has no development-client URL scheme.',
            remedy:
              'Install expo-dev-client with npx expo install expo-dev-client, then rebuild the EAS profile and retry.',
          });
        }
      }
    },
    materialize,
    async prepare(beforePrepare) {
      mutatingSteps = [];

      const prebuild = storeFingerprint
        ? await d.planPrebuild(root, PLATFORM, {
            isExpo,
            fingerprint: storeHash ?? '',
            native: storeFingerprint.native,
          })
        : await planUnfingerprintedPrebuild(root, PLATFORM, isExpo, operation?.signal);
      if (prebuild === 'refuse') {
        if (!storeFingerprint)
          fail({
            code: 'STIM_NO_FINGERPRINT',
            message: 'Cannot verify the existing iOS native directory without a fingerprint.',
            remedy: 'Resolve the fingerprint error and retry before changing generated native files.',
          });
        fail({ ...prebuildPlanRefusal(root, PLATFORM) });
      }
      const pods = d.readPodState(root, iosProject.dir);
      const mutates =
        prebuild === 'generate' ||
        prebuild === 'regenerate' ||
        podAction(pods, d.podsAreStale(pods.lockText, pods.manifestText, pods.dir)).install;
      if (mutates && cachePolicy.read) beforePrepare();
      if (prebuild === 'generate' || prebuild === 'regenerate') {
        step('prebuild');
        await recordPrebuildAsync(root, PLATFORM, null);
        const result = await d.runPrebuild(root, PLATFORM, logWriter());
        if (result?.failed) {
          phase('prebuild', 'FAILED');
          fail({
            code: result.code || 'STIM_PREBUILD_FAILED',
            message: result.reason || 'expo prebuild failed.',
            remedy: result.remedy || `See ${logFile} for the transcript.`,
            lines: (result.lastLines || []).slice(-5),
          });
        }
        const outcome =
          prebuild === 'generate'
            ? 'ios/ absent -> generated'
            : 'ios/ not generated from this fingerprint -> updated in place';
        phase('prebuild', `${outcome} (${formatDuration(result?.durationMs ?? 0)})`);
        mutatingSteps.push('prebuild');
      }

      if (isExpo && buildScheme !== undefined) {
        const project = d.discoverXcodeProject(root, iosProject.dir);
        if (project.error) fail({ ...project.error });
        const schemeError = (await d.resolveScheme(project, { scheme: buildScheme })).error;
        if (schemeError) fail({ ...schemeError });
      }

      const podState = d.readPodState(root, iosProject.dir);
      const verdict = d.podsAreStale(podState.lockText, podState.manifestText, podState.dir);
      const action = podAction(podState, verdict, { prebuildRan: mutatingSteps.includes('prebuild') });
      if (action.install && buildsOnlyOnWorker(await d.iosToolchain(root, null))) {
        phase('pods', `${action.reason} -> no Xcode here; the Mac that builds runs pod install`);
      } else if (action.install) {
        step('pods');
        const result = await d.runPodInstall(root, logWriter(), {
          onHeartbeat: note,
          estimateMs: estimates().podsMs,
          directory: iosProject.dir,
        });
        const podCommand = result?.command || 'pod install';
        for (const line of result?.notes || []) note(chalk.dim(phaseLine('pods', line)));
        if (result?.failed) {
          phase('pods', 'FAILED');
          fail({
            code: result.code || 'STIM_DEPS_FAILED',
            message: result.reason || '`pod install` failed.',
            remedy: result.remedy || `See ${logFile} for the transcript.`,
            lines: result.diagnosticLines?.length ? result.diagnosticLines : (result.lastLines || []).slice(-5),
          });
        }
        setPodsMs(result?.durationMs ?? 0);
        phase(
          'pods',
          `${action.reason} -> installed with \`${podCommand}\` (${formatDuration(result?.durationMs ?? 0)})`,
        );
        mutatingSteps.push(podCommand);
      }
    },
    async reconcile() {
      const rekeyedBy: string[] = [];
      if (mutatingSteps.length && lookupFingerprint && storeFingerprint) {
        const after = await computeFresh();
        const prebuildRan = mutatingSteps.includes('prebuild');
        const editedConfig = after ? configInputsChanged(lookupFingerprint, after, { prebuildRan }) : [];
        if (after && !editedConfig.length && prebuildRan) await recordPrebuildAsync(root, PLATFORM, after.hash);
        if (!after || editedConfig.length) {
          storeHash = null;
          note(
            chalk.yellow(
              phaseLine(
                'fingerprint',
                after
                  ? changedDuringBuildLine(editedConfig)
                  : `unavailable after ${mutatingSteps.join(', ')}; the build will be installed but not cached`,
              ),
            ),
          );
        } else if (after.hash !== storeHash) {
          rekeyedBy.push(...mutatingSteps.map((mutation) => (mutation === 'prebuild' ? mutation : 'pod install')));
          note(
            chalk.dim(
              phaseLine(
                'fingerprint',
                `${shortHash(storeFingerprint.hash)} -> ${shortHash(after.hash)} (after ${mutatingSteps.join(', ')})`,
              ),
            ),
          );
          storeHash = after.hash;
          storeFingerprint = after;
        }
      }
      return { identity: identity(), rekeyedBy, mutationLabel: mutatingSteps.join('/') };
    },
    async validate() {
      if (!storeHash || !lookupFingerprint || !storeFingerprint) return null;
      const installProblem = fingerprintInstallProblem(root);
      if (installProblem) {
        note(chalk.yellow(phaseLine('fingerprint', `${installProblem}; the build will be installed but not cached`)));
        storeHash = null;
        return null;
      }
      const after = await computeFresh();
      const changed = after
        ? inputsChangedDuringBuild(lookupFingerprint, storeFingerprint, after, {
            prebuildRan: mutatingSteps.includes('prebuild'),
          })
        : [];
      if (!after || changed.length || after.native !== storeFingerprint.native) {
        storeHash = null;
        note(
          chalk.yellow(
            phaseLine(
              'fingerprint',
              after
                ? changedDuringBuildLine(changed)
                : 'unavailable after xcodebuild; the build will be installed but not cached',
            ),
          ),
        );
      } else if (after.hash !== storeHash) {
        const before = storeHash;
        storeHash = after.hash;
        storeFingerprint = after;
        note(chalk.dim(phaseLine('fingerprint', `${shortHash(before)} -> ${shortHash(storeHash)} (after xcodebuild)`)));
      }
      return identity();
    },
    compile: () =>
      d.buildIos({
        context: operation,
        root,
        iosDir: iosProject.dir,
        scheme: buildScheme,
        udid,
        destination: target.destination,
        arch: target.arch,
        ...(physical ? { sdk: target.sdk } : {}),
        logWriter: logWriter(),
        ...(configuration ? { configuration } : {}),
        estimateMs: estimates().coldBuildMs,
        onHeartbeat: note,
        onNote: note,
        optimizations,
      }),
    explain(rekeyedBy) {
      const current = { inputs: storeFingerprint?.inputs ?? [] };
      const explained = explainBuildMiss({
        root,
        platform: PLATFORM,
        current,
        rekeyedBy,
        deps: { storedInputs, readState: d.readWorkspaceState },
      });
      return {
        reason: explained.reason,
        diff:
          explained.previousHash && explained.changedNames.length
            ? fingerprintDiffRecord({
                changed: explained.changedNames,
                previousHash: explained.previousHash,
                hash: storeHash ?? '',
              })
            : null,
      };
    },
    untrackedLine: () =>
      untrackedMissLine(d.untrackedNativeFiles({ projectRoot: root, iosProjectPath: iosProject.relative })),
    expoCache:
      physical || !cachePolicy.remote || buildProfile || buildScheme
        ? null
        : {
            load: () => d.loadProjectProvider(root, { context: operation, isExpo, config: lookupFingerprint?.config }),
            runOptions: iosProviderRunOptions(configuration, target.keyArch),
          },
    offload: {
      context: () => {
        const runtime = physical ? null : target.offloadRuntime();
        const unsupported =
          target.offloadRefusal ??
          (!cachePolicy.write
            ? 'the build cache is off'
            : !runtime
              ? udid
                ? `the runtime of simulator ${udid} is unknown`
                : 'no simulator runtime is available for worker selection'
              : null);
        return { runtime, unsupported };
      },
      target: async (runtime) => ({
        platform: 'ios',
        local: {
          ...(await iosToolchainAsync(root, iosProject.dir)),
          ...(target.hostedArchitecture ? { arch: target.hostedArchitecture === 'x86_64' ? 'x64' : 'arm64' } : {}),
        },
        runtime,
        cocoapodsPinned: bundlerPin(root, iosProject.dir) !== null,
      }),
      request: (runtime) => ({
        platform: 'ios',
        cacheArtifact: cachePolicy.write && cachePolicy.remote && !release,
        reuseArtifact: cachePolicy.read && cachePolicy.remote,
        runtime,
        configuration,
        scheme: buildScheme ?? null,
        iosProjectPath: iosProject.relative,
        isExpo,
        optimizations,
      }),
      fingerprintInputs: async () => {
        if (!storeFingerprint) return { uncertain: 'the native fingerprint is unavailable' };
        const full = await computeFresh();
        if (!full || full.hash !== storeFingerprint.hash)
          return { uncertain: 'the native inputs changed before offload' };
        return fingerprintOffloadInputs(root, fpTarget, full, operation?.env ?? processContext(root).env);
      },
      syncPlan: iosSyncPlan,
      unchanged: async () => {
        if (fingerprintInstallProblem(root)) return false;
        const after = await computeFresh();
        return Boolean(after && after.hash === storeHash);
      },
      rekeyed: (hash) => {
        storeHash = hash;
        // The worker protocol returns only the rekeyed hash, so no verified input rows are available for miss explanations.
        storeFingerprint = null;
        return { hash, key: buildCacheKey(PLATFORM, hash, keyOptions) };
      },
    },
  };
}
