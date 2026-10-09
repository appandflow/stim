import { rmSync } from 'node:fs';
import chalk from 'chalk';
import type { FingerprintSource } from '@expo/fingerprint';
import {
  buildCacheKey,
  changedDuringBuildLine,
  configInputsChanged,
  filesystemBuildCapability,
  fingerprintDiffRecord,
  inputsChangedDuringBuild,
  refingerprintAfterMutation,
  untrackedMissLine,
} from '../cache/build-cache.ts';
import { explainBuildMiss, fingerprintErrorMissReason } from '../cache/miss-reason.ts';
import { formatDuration, phaseLine, shortHash } from '../command-output.ts';
import { DEFAULT_DEPS, type IosDeps } from '../commands/ios/dependencies.ts';
import { iosMetroRuntime, iosProcessRuntime } from '../commands/ios/launch.ts';
import { iosProviderRunOptions, isReleaseConfiguration, podAction } from '../commands/ios/support.ts';
import type { FailArgs } from '../commands/ios/types.ts';
import { easDeviceBuildRemedy } from '../engine/eas-build.ts';
import { copyAppAside, writeIpTxt } from '../engine/ios-lan.ts';
import { recordPrebuild, staleNativeDirRefusal } from '../engine/prebuild.ts';
import { bundlerPin } from '../engine/bundler.ts';
import { iosToolchain } from '../offload/toolchain.ts';
import { IosRecipeRefusal, type IosProject, type IosArtifactContext, type IosArtifactRecipe } from './ios-project.ts';

const PLATFORM = 'ios';

type ReactNativeIosDependencies = Pick<
  IosDeps,
  | 'detectIsExpo'
  | 'detectBundleId'
  | 'discoverXcodeProject'
  | 'resolveScheme'
  | 'fingerprintProject'
  | 'untrackedNativeFiles'
  | 'resolveBuild'
  | 'storeBuild'
  | 'readWorkspaceState'
  | 'loadProjectProvider'
  | 'planPrebuild'
  | 'runPrebuild'
  | 'readPodState'
  | 'podsAreStale'
  | 'runPodInstall'
  | 'buildIos'
  | 'gateProfileForDevice'
  | 'sealAppForDevice'
  | 'devClientScheme'
  | 'swapJsBundle'
>;

export function reactNativeIosSchemeProblem(
  root: string,
  scheme: string | undefined,
  isExpo: boolean,
  d: ReactNativeIosDependencies,
): FailArgs | null {
  if (scheme === undefined) return null;
  if (!scheme.trim())
    return {
      code: 'STIM_BAD_ARG',
      message: '--scheme must name a non-empty shared Xcode app scheme.',
      remedy: 'Pass the exact scheme name shown by xcodebuild -list.',
    };
  if (isExpo) return null;
  const project = d.discoverXcodeProject(root);
  if (project.error) return project.error;
  return d.resolveScheme(project, { scheme }).error ?? null;
}

const runtimeKind: IosProject['runtimeKind'] = (configuration) =>
  isReleaseConfiguration(configuration) ? 'embedded-js' : 'metro';

export function reactNativeIosProject(
  root: string,
  dependencies: Partial<ReactNativeIosDependencies> = {},
): IosProject {
  const d: ReactNativeIosDependencies = { ...DEFAULT_DEPS, ...dependencies };
  const isExpo = d.detectIsExpo(root);

  return {
    isExpo,
    bundleId: () => d.detectBundleId(root),
    schemeProblem: (scheme) => reactNativeIosSchemeProblem(root, scheme, isExpo, d),
    targets: ['simulator', 'physical', 'remote', 'hosted'],
    eas: true,
    runtimeKind,
    runtime: ({ configuration, prepareMetro, prepareEmbedded }) =>
      runtimeKind(configuration) === 'embedded-js'
        ? iosProcessRuntime(prepareEmbedded, 'embedded-js')
        : iosMetroRuntime(prepareMetro),
    artifact: (context) => reactNativeIosArtifact(context, isExpo, d),
  };
}

function fail(failure: FailArgs): never {
  throw new IosRecipeRefusal(failure);
}

function reactNativeIosArtifact(
  {
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
  d: ReactNativeIosDependencies,
): IosArtifactRecipe {
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
  let fingerprint = '';
  let fingerprintSources: FingerprintSource[] = [];
  let storeHash: string | null = null;
  let storeSources: FingerprintSource[] = [];
  let mutatingSteps: string[] = [];
  const identity = () => (storeHash ? { hash: storeHash, key: buildCacheKey(PLATFORM, storeHash, keyOptions) } : null);
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
      const gateProfile = (): string | null => {
        const gate = d.gateProfileForDevice({ appPath: path, udid: physicalDevice.udid, configuration });
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
      const sealed = d.sealAppForDevice({
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
      phase('swap', `regenerating this workspace's JS for the cached ${configuration} app`);
      const swap = await d.swapJsBundle({ root, isExpo, cachedAppPath: cachedPath, logWriter: logWriter() });
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
      let computedFingerprint: string | null;
      let fingerprintError = 'no hash';
      try {
        const computed = await d.fingerprintProject(root, { platform: PLATFORM });
        computedFingerprint = computed?.hash ?? null;
        fingerprintSources = computed?.sources ?? [];
      } catch (error) {
        computedFingerprint = null;
        fingerprintError = String((error as Error)?.message || error);
        note(chalk.dim(`Fingerprinting failed: ${fingerprintError}`));
      }
      if (!computedFingerprint)
        fail({
          code: 'STIM_NO_FINGERPRINT',
          message: `Could not fingerprint ${root}: @expo/fingerprint produced no hash for it.`,
          remedy: 'Check the project native inputs and the @expo/fingerprint error above, then retry.',
          build: { cacheSkipped: !cachePolicy.read, missReason: fingerprintErrorMissReason(fingerprintError) },
        });
      fingerprint = storeHash = computedFingerprint;
      storeSources = fingerprintSources;
      return identity()!;
    },
    cache: () => filesystemBuildCapability({ resolve: d.resolveBuild, store: d.storeBuild, sources: storeSources }),
    validateExternal(path) {
      if (device) {
        const gate = d.gateProfileForDevice({ appPath: path, udid: device.udid, configuration });
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

      const prebuild = d.planPrebuild(root, PLATFORM, { isExpo, fingerprint, sources: fingerprintSources });
      if (prebuild === 'refuse') {
        fail({ ...staleNativeDirRefusal(PLATFORM) });
      }
      const pods = d.readPodState(root);
      const mutates =
        prebuild === 'generate' ||
        prebuild === 'regenerate' ||
        podAction(pods, d.podsAreStale(pods.lockText, pods.manifestText)).install;
      if (mutates && cachePolicy.read) beforePrepare();
      if (prebuild === 'generate' || prebuild === 'regenerate') {
        step('prebuild');
        recordPrebuild(root, PLATFORM, null);
        const result = await d.runPrebuild(root, PLATFORM, logWriter(), { clean: prebuild === 'regenerate' });
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
            : 'ios/ not generated from this fingerprint -> regenerated with --clean';
        phase('prebuild', `${outcome} (${formatDuration(result?.durationMs ?? 0)})`);
        mutatingSteps.push('prebuild');
      }

      if (isExpo && buildScheme !== undefined) {
        const project = d.discoverXcodeProject(root);
        if (project.error) fail({ ...project.error });
        const schemeError = d.resolveScheme(project, { scheme: buildScheme }).error;
        if (schemeError) fail({ ...schemeError });
      }

      const podState = d.readPodState(root);
      const verdict = d.podsAreStale(podState.lockText, podState.manifestText);
      const action = podAction(podState, verdict);
      if (action.install) {
        step('pods');
        const result = await d.runPodInstall(root, logWriter(), { estimateMs: estimates().podsMs });
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
      if (mutatingSteps.length) {
        const after = await refingerprintAfterMutation({
          projectRoot: root,
          platform: PLATFORM,
          previousHash: fingerprint,
          fingerprint: d.fingerprintProject,
        });
        const prebuildRan = mutatingSteps.includes('prebuild');
        const editedConfig = after ? configInputsChanged(fingerprintSources, after.sources, { prebuildRan }) : [];
        if (after && !editedConfig.length && prebuildRan) recordPrebuild(root, PLATFORM, after.hash);
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
        } else if (after.moved) {
          rekeyedBy.push(...mutatingSteps.map((mutation) => (mutation === 'prebuild' ? mutation : 'pod install')));
          storeHash = after.hash;
          storeSources = after.sources;
          note(
            chalk.dim(
              phaseLine(
                'fingerprint',
                `${shortHash(fingerprint)} -> ${shortHash(storeHash)} (after ${mutatingSteps.join(', ')})`,
              ),
            ),
          );
        }
      }
      return { identity: identity(), rekeyedBy, mutationLabel: mutatingSteps.join('/') };
    },
    async validate() {
      if (!storeHash) return null;
      const after = await refingerprintAfterMutation({
        projectRoot: root,
        platform: PLATFORM,
        previousHash: storeHash,
        fingerprint: d.fingerprintProject,
      });
      const changed = after
        ? inputsChangedDuringBuild({
            platform: PLATFORM,
            lookup: fingerprintSources,
            prebuildRan: mutatingSteps.includes('prebuild'),
            compiled: storeSources,
            current: after.sources,
          })
        : [];
      if (!after || changed.length) {
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
      } else if (after.moved) {
        const before = storeHash;
        storeHash = after.hash;
        storeSources = after.sources;
        note(chalk.dim(phaseLine('fingerprint', `${shortHash(before)} -> ${shortHash(storeHash)} (after xcodebuild)`)));
      }
      return identity();
    },
    compile: () =>
      d.buildIos({
        root,
        scheme: buildScheme,
        udid,
        destination: target.destination,
        arch: target.arch,
        ...(physical ? { sdk: target.sdk } : {}),
        logWriter: logWriter(),
        ...(configuration ? { configuration } : {}),
        estimateMs: estimates().coldBuildMs,
        optimizations,
      }),
    explain(rekeyedBy) {
      const current = { hash: storeHash ?? fingerprint, sources: storeSources };
      const explained = explainBuildMiss({
        root,
        platform: PLATFORM,
        current,
        rekeyedBy,
        baselineDeps: { readState: d.readWorkspaceState },
      });
      return {
        reason: explained.reason,
        diff:
          explained.previousHash && explained.changedNames.length
            ? fingerprintDiffRecord({
                changed: explained.changedNames,
                previousHash: explained.previousHash,
                hash: current.hash,
              })
            : null,
      };
    },
    untrackedLine: () => untrackedMissLine(d.untrackedNativeFiles({ projectRoot: root })),
    legacyCache:
      physical || !cachePolicy.remote || buildProfile || buildScheme
        ? null
        : {
            load: () => d.loadProjectProvider(root, { isExpo }),
            runOptions: iosProviderRunOptions(configuration, target.keyArch),
          },
    offload: {
      context: () => {
        const runtime = physical || release ? null : target.offloadRuntime();
        const unsupported =
          target.offloadRefusal ??
          (release
            ? `${configuration} builds build here`
            : !cachePolicy.write
              ? 'the build cache is off'
              : !runtime
                ? udid
                  ? `the runtime of simulator ${udid} is unknown`
                  : 'no simulator runtime is available for worker selection'
                : null);
        return { runtime, unsupported };
      },
      target: (runtime) => ({
        platform: 'ios',
        local: {
          ...iosToolchain(root),
          ...(target.hostedArchitecture ? { arch: target.hostedArchitecture === 'x86_64' ? 'x64' : 'arm64' } : {}),
        },
        runtime,
        cocoapodsPinned: bundlerPin(root) !== null,
      }),
      request: (runtime) => ({
        platform: 'ios',
        runtime,
        configuration,
        scheme: buildScheme ?? null,
        isExpo,
        optimizations,
      }),
      unchanged: async () => {
        const after = await refingerprintAfterMutation({
          projectRoot: root,
          platform: PLATFORM,
          previousHash: storeHash!,
          fingerprint: d.fingerprintProject,
        });
        return Boolean(after && !after.moved);
      },
    },
  };
}
