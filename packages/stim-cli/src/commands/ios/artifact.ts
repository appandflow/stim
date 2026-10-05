import { rmSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import {
  createWarnOnce,
  resolveTieredBuild,
  storeTieredBuild,
  type LoadCacheProviderResult,
  type ProviderCallResult,
} from '@stim-cli/cache';
import type { FingerprintSource } from '@expo/fingerprint';
import {
  buildCacheKey,
  changedDuringBuildLine,
  configInputsChanged,
  filesystemBuildCapability,
  fingerprintDiffRecord,
  inputsChangedDuringBuild,
  prepareProviderDownloadDir,
  providerDownloadPath,
  providerUploadOutcome,
  refingerprintAfterMutation,
  untrackedMissLine,
} from '../../cache/build-cache.ts';
import { explainBuildMiss, fingerprintErrorMissReason, skippedMissReason } from '../../cache/miss-reason.ts';
import { formatDuration, phaseLine, shortHash, stepTimer } from '../../command-output.ts';
import { waitForSharedBuild, type BuildLockHandle } from '../../engine/build-lock.ts';
import type { BuildSlotHandle } from '../../engine/build-slots.ts';
import { easDeviceBuildRemedy, type EasBuildResult } from '../../engine/eas-build.ts';
import { copyAppAside, writeIpTxt } from '../../engine/ios-lan.ts';
import { recordPrebuild, staleNativeDirRefusal } from '../../engine/prebuild.ts';
import {
  RESOLVE_TIMEOUT_MS,
  easAuthNote,
  isEasAuthFailureText,
  type LoadProjectProviderResult,
} from '../../engine/remote-cache.ts';
import type { RunRecorder, RunEstimates } from '../../engine/stats.ts';
import type { BuildPhase } from '../../engine/build-progress.ts';
import { COMPILATION_CACHE_NOT_RUN, compilationCacheActivityLine } from '../../engine/xcode.ts';
import type { NdjsonWriter } from '../../ndjson.ts';
import { artifactCachePolicy, type Optimizations } from '../../optimizations.ts';
import { claimFailure } from '../../ownership-claim.ts';
import {
  closeOffload,
  chooseBuildMachine,
  offloadBuild,
  buildPlacementCandidates,
  offloadPlacement,
  placementLoad,
  remotePhaseText,
  simulatorRuntime,
  type OffloadChoice,
} from '../../offload/client.ts';
import type { pairedMachines } from '../../offload/build-machines.ts';
import { bundlerPin } from '../../engine/bundler.ts';
import { namedBuildMachine, OffloadRefusal } from '../../offload/selection.ts';
import { iosToolchain } from '../../offload/toolchain.ts';
import { workspaceDir } from '../../workspace/paths.ts';
import type { CacheHitLevel, CompilationCacheActivity } from '../../engine/build-facts.ts';
import { machineCapacity, type BuildMissReason, type MachineCapacity, type OffloadMode } from '@stim-cli/core/state';
import type { IosDeps } from './dependencies.ts';
import type { SimulatorArch } from '../../engine/agent-device.ts';
import { finishIosUpload } from './result.ts';
import {
  PLATFORM,
  iosProviderRunOptions,
  isReleaseConfiguration,
  podAction,
  printDiagnostics,
  xcodeFailureReport,
} from './support.ts';
import type { BuildFailureFields, FailArgs, RemoteUploadLike, WaitedForBuild } from './types.ts';

// xcodebuild cannot target a remote simulator UDID, so remote builds use the generic destination.
const GENERIC_SIM_DESTINATION = 'generic/platform=iOS Simulator';
const IPHONEOS_SDK = 'iphoneos';
const PROVIDER_SKIPPED_ON_DEVICE =
  'a device build is local-tier only: its cache key names the iphoneos slice, and a remote or provider entry is keyed for the simulator';

interface IosArtifactRequest {
  buildMachine?: string;
  root: string;
  logFile: string;
  udid: string;
  remoteDestination: boolean;
  simulatorArch: SimulatorArch | null;
  device: {
    lanAddress: string | null;
    metroPort: number | null;
    signingName: string | null;
    signingSha1: string | null;
  } | null;
  configuration: string | null;
  buildScheme?: string;
  buildProfile: string | undefined;
  isExpo: boolean;
  optimizations: Optimizations['ios'];
  cache: {
    policy: ReturnType<typeof artifactCachePolicy>;
    providerConfig: ReturnType<IosDeps['resolveCacheProviderConfig']>;
    disabledByFlag: boolean;
  };
  easBuild: Extract<EasBuildResult, { ok: true }> | null;
  easProfile?: string;
  maxBuilds: number | null | undefined;
  progress: {
    phase: (name: unknown, text: string) => void;
    note: (line: string) => void;
    logWriter: () => NdjsonWriter;
    estimates: () => RunEstimates;
    stats: Pick<RunRecorder, 'setCacheKey' | 'setBuildMs' | 'setPodsMs' | 'setPlacement'>;
    step: (phase: BuildPhase) => void;
    miss: (reason: BuildMissReason, provisional?: boolean) => void;
    hit: () => void;
    place: (remote: { host: string; phase: string } | null) => void;
    waitingOn: (root: string | null) => void;
  };
}

type IosArtifactDeps = Pick<
  IosDeps,
  | 'fingerprintProject'
  | 'untrackedNativeFiles'
  | 'resolveBuild'
  | 'storeBuild'
  | 'loadCacheProvider'
  | 'readWorkspaceState'
  | 'loadProjectProvider'
  | 'checkEasAuth'
  | 'resolveRemote'
  | 'uploadRemote'
  | 'acquireBuildLock'
  | 'releaseBuildLock'
  | 'waitForBuild'
  | 'acquireBuildSlot'
  | 'releaseBuildSlot'
  | 'planPrebuild'
  | 'runPrebuild'
  | 'discoverXcodeProject'
  | 'resolveScheme'
  | 'readPodState'
  | 'podsAreStale'
  | 'runPodInstall'
  | 'buildIos'
  | 'gateProfileForDevice'
  | 'sealAppForDevice'
  | 'devClientScheme'
  | 'swapJsBundle'
  | 'now'
>;

/** The caller owns this installable app's temporary copies until release(). */
export interface PreparedIosArtifact {
  path: string;
  bundleId: string | null;
  cache: {
    identity: { fingerprint: string; key: string } | null;
    hit: CacheHitLevel;
    providerName: string | null;
    buildMachine: string;
    builtOn?: string;
    /** The build machine that compiled the app, when the build was offloaded. */
    offloadedTo: string | null;
    /** Why the app was built here after the run considered offloading it. */
    offloadFallback: string | null;
    readEnabled: boolean;
    missReason: BuildMissReason | null;
    waitedForBuild: WaitedForBuild | null;
    compilation: CompilationCacheActivity;
  };
  failureFields: BuildFailureFields;
  /** Returns true when an abandoned provider requires command termination after cleanup. */
  completeUploads(): Promise<boolean>;
  /** Removes only owned temporary copies; repeated calls are safe. */
  release(): void;
}

type IosArtifactResult =
  | { ok: true; artifact: PreparedIosArtifact }
  | { ok: false; failure: FailArgs; compilationCache: CompilationCacheActivity };

class ArtifactRefusal extends Error {
  readonly failure: FailArgs;

  constructor(failure: FailArgs) {
    super(failure.message ?? failure.code);
    this.failure = failure;
  }
}

export async function acquireIosArtifact(
  {
    root,
    logFile,
    udid,
    remoteDestination,
    simulatorArch,
    device,
    configuration,
    buildScheme,
    buildProfile,
    buildMachine = 'auto',
    isExpo,
    optimizations,
    cache,
    easBuild,
    easProfile,
    maxBuilds,
    progress,
  }: IosArtifactRequest,
  d: IosArtifactDeps,
): Promise<IosArtifactResult> {
  const { phase, note, logWriter, estimates, stats, step, miss, hit: lateHit, place, waitingOn } = progress;
  const physical = device !== null;
  const keyOptions = {
    scheme: buildScheme,
    ...(configuration ? { configuration } : {}),
    isSimulator: !physical,
    ...(simulatorArch ? { arch: simulatorArch } : {}),
    ...(buildProfile ? { buildProfile } : {}),
  };
  const providerRunOptions = iosProviderRunOptions(configuration, simulatorArch);
  const lanAddress = device?.lanAddress ?? null;
  const metroPort = device?.metroPort ?? null;
  const release = isReleaseConfiguration(configuration);
  const cachePolicy = cache.policy;
  const useBuildCache = cachePolicy.read;
  const cacheProviderConfig = cache.providerConfig;
  let compilationCache: CompilationCacheActivity = COMPILATION_CACHE_NOT_RUN;
  function fail(failure: FailArgs): never {
    throw new ArtifactRefusal(failure);
  }
  const temporaryDirs = new Set<string>();
  const releaseArtifact = () => {
    for (const directory of temporaryDirs) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {}
      temporaryDirs.delete(directory);
    }
  };
  let buildLock: BuildLockHandle | null = null;
  const releaseLock = () => {
    if (!buildLock) return;
    const held = buildLock;
    buildLock = null;
    try {
      d.releaseBuildLock(held);
    } catch (e) {
      note(chalk.dim(`Could not release the build lock at ${held.path}: ${(e as Error)?.message || e}`));
    }
  };

  let buildSlot: BuildSlotHandle | null = null;
  const releaseSlot = () => {
    if (!buildSlot) return;
    const held = buildSlot;
    buildSlot = null;
    try {
      d.releaseBuildSlot(held);
    } catch (e) {
      note(chalk.dim(`Could not release the build slot: ${(e as Error)?.message || e}`));
    }
  };

  let fingerprint = '';
  let fingerprintSources: FingerprintSource[] = [];
  let cacheKey = '';
  let storeHash: string | null = null;
  let storeKey: string | null = null;
  let storeSources: FingerprintSource[] = [];
  let appPath: string | null = null;
  let bundleId: string | null = null;
  let cacheHit: CacheHitLevel = false;
  let offloadedTo: string | null = null;
  let offloadFallback: string | null = null;
  let fallbackMachine: string | null = null;
  let hereReason: string | null = null;
  let builtOn: string | undefined;
  const fallBack = (reason: string, line: string = reason) => {
    if (namedBuildMachine(buildMachine)) throw new OffloadRefusal(buildMachine, reason);
    offloadFallback = reason;
    buildFailure = { ...buildFailure, offloadFallback: reason };
    phase('build', `${line} -> building here`);
  };
  const openOffload: { choice: OffloadChoice | null } = { choice: null };
  let remote: LoadProjectProviderResult | null = null;
  let abandonedRemote = false;
  let uploadPending: Promise<RemoteUploadLike> | null = null;
  let providerUpload: Promise<ProviderCallResult<void>> | null = null;
  let providerName: string | null = null;
  let providerLoad: Promise<LoadCacheProviderResult> | null = null;
  const cacheWarn = createWarnOnce((line) => note(chalk.yellow(phaseLine('cache', line))));
  const loadProvider =
    cachePolicy.remote && cacheProviderConfig && !physical
      ? () => (providerLoad ??= d.loadCacheProvider({ projectRoot: root, config: cacheProviderConfig }))
      : null;
  if (cacheProviderConfig && physical) {
    note(chalk.dim(phaseLine('cache', PROVIDER_SKIPPED_ON_DEVICE)));
  }
  let waitedForBuild: WaitedForBuild | null = null;
  let releasedWait: { facts: WaitedForBuild; who: string } | null = null;
  let swapFellBack = false;
  let buildFailure: BuildFailureFields = {};
  let missReason: BuildMissReason | null = null;

  async function resolveInitialFingerprint(): Promise<void> {
    if (easBuild?.ok) {
      fingerprint = storeHash = easBuild.fingerprint;
      cacheKey = storeKey = easBuild.cacheKey;
      appPath = easBuild.path;
      cacheHit = easBuild.cacheHit;
      providerName = 'eas';
      stats.setCacheKey(cacheKey);
      if (physical) {
        const gate = d.gateProfileForDevice({ appPath, udid, configuration });
        if (!gate.ok) {
          fail({ code: gate.code, message: gate.reason, remedy: easDeviceBuildRemedy(easProfile!) });
        }
        if (!d.devClientScheme(root, appPath)) {
          fail({
            code: 'STIM_BAD_ARG',
            message: 'The EAS device app has no development-client URL scheme.',
            remedy:
              'Install expo-dev-client with npx expo install expo-dev-client, then rebuild the EAS profile and retry.',
          });
        }
      }
      return;
    }
    step('cache-lookup');
    const fingerprintTimer = stepTimer(d.now);
    let computedFingerprint: string | null;
    let fingerprintError = 'no hash';
    try {
      const computed = await d.fingerprintProject(root, { platform: PLATFORM });
      computedFingerprint = computed?.hash ?? null;
      fingerprintSources = computed?.sources ?? [];
    } catch (e) {
      computedFingerprint = null;
      fingerprintError = String((e as Error)?.message || e);
      note(chalk.dim(`Fingerprinting failed: ${fingerprintError}`));
    }
    if (!computedFingerprint) {
      fail({
        code: 'STIM_NO_FINGERPRINT',
        message: `Could not fingerprint ${root}: @expo/fingerprint produced no hash for it.`,
        remedy: 'Check the project native inputs and the @expo/fingerprint error above, then retry.',
        build: { cacheSkipped: !useBuildCache, missReason: fingerprintErrorMissReason(fingerprintError) },
      });
    }
    fingerprint = computedFingerprint;
    cacheKey = buildCacheKey(PLATFORM, fingerprint, keyOptions);
    stats.setCacheKey(cacheKey);
    storeHash = fingerprint;
    storeKey = cacheKey;
    storeSources = fingerprintSources;

    const found = await resolveTieredBuild({
      local: filesystemBuildCapability({ resolve: d.resolveBuild, store: d.storeBuild, sources: fingerprintSources }),
      loadProvider,
      target: { projectRoot: root, platform: PLATFORM, key: cacheKey },
      destinationDir: providerDownloadPath(workspaceDir(root)),
      ensureDestination: prepareProviderDownloadDir,
      skipRead: !useBuildCache,
      warn: cacheWarn,
    });
    const cached = found?.tier === 'local' ? found.path : null;
    cacheHit = cached ? 'local' : false;
    phase(
      'fingerprint',
      `${shortHash(fingerprint)} ${cached ? 'hit' : 'miss'}${useBuildCache ? '' : cache.disabledByFlag ? ' (--no-build-cache)' : ' (cache reuse off in config)'} ${fingerprintTimer()}`,
    );
    if (found?.tier === 'provider') {
      cacheHit = 'remote';
      providerName = found.providerName ?? null;
      phase('cache', `provider hit (${providerName})${found.storedLocally ? ' -> stored locally' : ''}`);
    }
    appPath = found?.path ?? null;
    return;
  }

  async function resolveRemoteArtifact(): Promise<LoadProjectProviderResult | null> {
    if (physical || !cachePolicy.remote || buildProfile || buildScheme) return null;
    if (!appPath) {
      const loaded: LoadProjectProviderResult = await d.loadProjectProvider(root, { isExpo });
      if (loaded?.unavailable) {
        note(chalk.yellow(phaseLine('cache', `provider not usable: ${loaded.unavailable}`)));
      } else if (loaded?.provider) {
        remote = loaded;
      }
      if (remote?.name === 'eas') {
        const auth = d.checkEasAuth({ projectRoot: root, owner: loaded?.owner || null });
        const authNote = easAuthNote(auth as Parameters<typeof easAuthNote>[0]);
        if (authNote) note(chalk.yellow(phaseLine('cache', authNote)));
        if (auth?.code === 'logged-out') remote = null;
      }
    }

    if (remote && useBuildCache) {
      const remoteTimer = stepTimer(d.now);
      const hit = await d.resolveRemote({
        logWriter: logWriter(),
        provider: remote.provider,
        platform: PLATFORM,
        projectRoot: root,
        fingerprintHash: fingerprint,
        runOptions: providerRunOptions,
      });
      if (hit?.appPath) {
        let stored = null;
        try {
          stored = d.storeBuild(PLATFORM, cacheKey, hit.appPath, { sources: fingerprintSources });
        } catch (e) {
          note(
            chalk.yellow(phaseLine('cache', `remote hit could not be stored locally: ${(e as Error)?.message || e}`)),
          );
        }
        appPath = stored || hit.appPath;
        cacheHit = 'remote';
        phase('cache', `remote hit (${remote.name})${stored ? ' -> stored locally' : ''} ${remoteTimer()}`);
      } else if (hit?.timedOut) {
        abandonedRemote = true;
        note(
          chalk.yellow(
            phaseLine(
              'cache',
              `${remote.name} did not answer within ${formatDuration(RESOLVE_TIMEOUT_MS)}; building instead`,
            ),
          ),
        );
      } else if (hit?.failed) {
        const authNote =
          remote.name === 'eas' && isEasAuthFailureText(hit.failed)
            ? easAuthNote({ code: 'logged-out', reason: hit.failed })
            : null;
        note(
          chalk.yellow(
            phaseLine('cache', authNote || `${remote.name} could not be used: ${hit.failed}; building instead`),
          ),
        );
      } else {
        phase('cache', `remote miss (${remote.name}) ${remoteTimer()}`);
      }
    }
    return remote;
  }

  async function awaitSharedBuild(): Promise<void> {
    if (!useBuildCache || appPath) return;
    const shared = await waitForSharedBuild({
      platform: PLATFORM,
      key: cacheKey,
      fingerprint,
      root,
      logFile,
      command: 'stim ios',
      acquire: d.acquireBuildLock,
      wait: d.waitForBuild,
      now: d.now,
      phase: (text) => {
        step('wait');
        phase('build', text);
      },
      waitingOn,
      warn: (text) => note(chalk.yellow(phaseLine('build', text))),
      out: note,
    });
    if (shared.refusal) {
      fail({ ...shared.refusal, build: { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache } });
    }
    buildLock = shared.lock;
    releasedWait = shared.released;
    if (shared.hit) {
      appPath = shared.hit.path;
      cacheHit = 'local';
      waitedForBuild = shared.hit.waited;
    }
  }

  const prepareDeviceApp = async (path: string, { fresh }: { fresh: boolean }): Promise<string | null> => {
    const refuse = (code: string, reason: string, remedy: string): null => {
      if (fresh) {
        fail({ code, message: reason, remedy, build: { ...buildFailure, appPath: path } });
      }
      note(chalk.yellow(phaseLine('cache', `${reason} -- building fresh instead`)));
      note(chalk.dim(phaseLine('', remedy)));
      swapFellBack = true;
      return null;
    };
    const gateProfile = (): string | null => {
      const gate = d.gateProfileForDevice({ appPath: path, udid, configuration });
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
        swapFellBack = true;
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
    temporaryDirs.add(copy.tmpDir);
    writeIpTxt(copy.appPath, lanAddress as string, metroPort as number);
    const sealed = d.sealAppForDevice({
      appPath: copy.appPath,
      udid,
      configuration,
      pinnedName: device?.signingName ?? null,
      pinnedSha1: device?.signingSha1 ?? null,
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
    if (physical) return prepareDeviceApp(cachedPath, { fresh: false });
    if (!release) return cachedPath;
    phase('swap', `regenerating this workspace's JS for the cached ${configuration} app`);
    const swap = await d.swapJsBundle({ root, isExpo, cachedAppPath: cachedPath, logWriter: logWriter() });
    if (swap?.ok && swap.appPath) {
      if (swap.note) note(chalk.yellow(phaseLine('swap', swap.note)));
      if (swap.tmpDir) temporaryDirs.add(swap.tmpDir);
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
    swapFellBack = true;
    return null;
  };

  async function prepareCachedArtifact(): Promise<void> {
    if (appPath && cacheHit) {
      const prepared = await installableCachedApp(appPath);
      appPath = prepared;
      if (!prepared) {
        cacheHit = false;
        waitedForBuild = null;
      }
    }
  }

  function reasonForMiss(rekeyedBy: string[]): { reason: BuildMissReason; diff: Record<string, unknown> | null } {
    if (swapFellBack) {
      return {
        reason: skippedMissReason('the cached app could not be reused, so this run built it fresh'),
        diff: null,
      };
    }
    if (!useBuildCache) {
      return {
        reason: skippedMissReason(
          cache.disabledByFlag ? 'cache reuse turned off by --no-build-cache' : 'cache reuse off in config',
        ),
        diff: null,
      };
    }
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
  }

  function reportPendingRecheck(prebuild: ReturnType<IosArtifactDeps['planPrebuild']>): void {
    const pods = d.readPodState(root);
    const mutates =
      prebuild === 'generate' ||
      prebuild === 'regenerate' ||
      podAction(pods, d.podsAreStale(pods.lockText, pods.manifestText)).install;
    if (mutates && useBuildCache) miss(reasonForMiss([]).reason, true);
  }

  function explainMiss(rekeyedBy: string[]): void {
    const explained = reasonForMiss(rekeyedBy);
    missReason = explained.reason;
    if (explained.diff) logWriter().write(explained.diff);
    buildFailure = { ...buildFailure, missReason };
    miss(missReason);
    phase('cache', `miss: ${missReason.summary}`);
    if (missReason.kind === 'no-baseline') {
      const untracked = untrackedMissLine(d.untrackedNativeFiles({ projectRoot: root }));
      if (untracked) note(chalk.dim(phaseLine('fingerprint', untracked)));
    }
  }

  async function settleStoreKeyAfterCompile(prebuildRan: boolean): Promise<void> {
    if (!storeHash || !storeKey) return;
    const afterBuild = await refingerprintAfterMutation({
      projectRoot: root,
      platform: PLATFORM,
      previousHash: storeHash,
      fingerprint: d.fingerprintProject,
    });
    const changedDuringBuild = afterBuild
      ? inputsChangedDuringBuild({
          platform: PLATFORM,
          lookup: fingerprintSources,
          prebuildRan,
          compiled: storeSources,
          current: afterBuild.sources,
        })
      : [];
    if (!afterBuild || changedDuringBuild.length) {
      storeHash = null;
      storeKey = null;
      buildFailure = { ...buildFailure, fingerprint: null, cacheKey: null };
      note(
        chalk.yellow(
          phaseLine(
            'fingerprint',
            afterBuild
              ? changedDuringBuildLine(changedDuringBuild)
              : 'unavailable after xcodebuild; the build will be installed but not cached',
          ),
        ),
      );
    } else if (afterBuild.moved) {
      const beforeBuildHash = storeHash;
      storeHash = afterBuild.hash;
      storeSources = afterBuild.sources;
      storeKey = buildCacheKey(PLATFORM, afterBuild.hash, keyOptions);
      buildFailure = { ...buildFailure, fingerprint: storeHash, cacheKey: storeKey };
      note(
        chalk.dim(
          phaseLine('fingerprint', `${shortHash(beforeBuildHash)} -> ${shortHash(storeHash)} (after xcodebuild)`),
        ),
      );
    }
  }

  async function takeBuildSlot(): Promise<void> {
    if (!maxBuilds) return;
    try {
      buildSlot = await d.acquireBuildSlot({ max: maxBuilds, root, logFile, out: note });
    } catch (e) {
      const refusal = claimFailure(e, 'stim ios');
      if (refusal) {
        fail({ code: refusal.code, message: refusal.message, remedy: refusal.remedy, build: buildFailure });
      }
      note(
        chalk.yellow(phaseLine('build', `could not take a build slot: ${(e as Error)?.message || e}; building anyway`)),
      );
    }
  }

  interface Candidate {
    mode: OffloadMode;
    here: MachineCapacity;
    reason: string;
    runtime: string;
    machines: ReturnType<typeof pairedMachines>;
  }

  /** Whether this build should leave this Mac, before any machine is asked; null builds here. */
  function placeBuild(): Candidate | null {
    const { mode, machines } = buildPlacementCandidates(buildMachine);
    if (machines.length === 0 && !namedBuildMachine(buildMachine) && buildMachine !== 'local') return null;
    const runtime = physical || remoteDestination || release ? null : simulatorRuntime(udid);
    const unsupported = physical
      ? 'device builds build here'
      : remoteDestination
        ? '--remote builds build here'
        : release
          ? `${configuration} builds build here`
          : !cachePolicy.write
            ? 'the build cache is off'
            : !runtime
              ? `the runtime of simulator ${udid} is unknown`
              : null;
    const here = machineCapacity();
    const placement = offloadPlacement({ mode, machines: machines.length, here, unsupported, selected: buildMachine });
    if (!placement.offload) {
      hereReason = placement.reason;
      if (mode !== 'off') phase('build', `placement: here (${placement.reason})`);
      return null;
    }
    return { mode, here, reason: placement.reason, runtime: runtime!, machines };
  }

  /** Asks the paired machines once the post-mutation key is known; null builds here. */
  async function chooseMachine(candidate: Candidate): Promise<OffloadChoice | null> {
    const choice = await chooseBuildMachine({
      projectRoot: root,
      target: {
        platform: 'ios',
        local: iosToolchain(),
        runtime: candidate.runtime,
        cocoapodsPinned: bundlerPin(root) !== null,
      },
      mode: candidate.mode,
      here: candidate.here,
      note: (line) => note(chalk.dim(phaseLine('build', `offload: ${line}`))),
      machines: candidate.machines,
      selected: buildMachine,
    });
    if (typeof choice === 'string') {
      const only = candidate.machines.length === 1 ? candidate.machines[0]!.machine : null;
      if (only && choice.startsWith(`${only}: `)) fallbackMachine = only;
      fallBack(choice);
      return null;
    }
    openOffload.choice = choice;
    phase('build', `placement: ${choice.machine} (${candidate.reason}${placementLoad(choice)})`);
    return choice;
  }

  /** Builds on the chosen machine and stores the app under the post-mutation key; false builds here instead unless a machine was named. */
  async function compileElsewhere({
    choice,
    candidate,
  }: {
    choice: OffloadChoice;
    candidate: Candidate;
  }): Promise<boolean> {
    const runtime = candidate.runtime;
    if (!storeKey || !storeHash) {
      if (namedBuildMachine(buildMachine)) fallBack('the build fingerprint or cache key is unavailable');
      return false;
    }
    const stagingDir = join(workspaceDir(root), 'offload', PLATFORM);
    const outcome = await offloadBuild({
      choice,
      expectedFingerprint: storeHash,
      request: { platform: 'ios', runtime, configuration, scheme: buildScheme ?? null, isExpo, optimizations },
      stagingDir,
      onPhase: (name, msg) => phase(name, remotePhaseText(name, msg, choice.machine)),
      onEnter: (name) => {
        if (name === 'compile' || name === 'build' || name === 'prebuild' || name === 'pods') {
          builtOn = choice.machine;
          buildFailure = { ...buildFailure, builtOn };
        }
        place({ host: choice.machine, phase: name });
        step(name === 'prebuild' || name === 'pods' ? name : 'compile');
      },
      onRecord: (record) => logWriter().write({ ...record, offloadedTo: choice.machine }),
      note: (line) => phase('build', line),
    });
    place(null);
    let stored: string | null = null;
    let reason = outcome.ok ? null : outcome.reason;
    if (outcome.ok) {
      const settled = await refingerprintAfterMutation({
        projectRoot: root,
        platform: PLATFORM,
        previousHash: storeHash,
        fingerprint: d.fingerprintProject,
      });
      if (!settled || settled.moved) {
        reason = 'the checkout here changed while it built';
      } else {
        try {
          stored = d.storeBuild(PLATFORM, storeKey, outcome.artifactPath, {
            sources: storeSources,
            overwrite: !useBuildCache,
          });
        } catch (e) {
          reason = `could not store the app: ${(e as Error)?.message || e}`;
        }
      }
    }
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    step('compile');
    const prepared = stored ? await installableCachedApp(stored) : null;
    if (!outcome.ok || !prepared) {
      const why = reason ?? 'the stored app is not installable';
      fallbackMachine = choice.machine;
      fallBack(`${choice.machine}: ${why}`, `offload failed: ${why}`);
      logWriter().write({ src: 'build', level: 'warn', event: 'offload_failed', msg: reason, machine: choice.machine });
      return false;
    }
    const { timings } = outcome;
    appPath = prepared;
    builtOn = outcome.machine;
    offloadedTo = outcome.machine;
    stats.setPlacement({
      decision: 'offloaded',
      machine: outcome.machine,
      reason: `${candidate.reason}${placementLoad(choice)}`,
      buildMs: timings.totalMs,
    });
    phase(
      'build',
      `built on ${outcome.machine} in ${formatDuration(timings.totalMs)}: offer ${formatDuration(timings.offerMs)}, ` +
        `sync ${formatDuration(timings.syncMs)}, build ${formatDuration(timings.workerMs)}, fetch ${formatDuration(timings.fetchMs)}`,
    );
    compilationCache = outcome.compilationCache;
    phase('cache', `compilation cache on ${outcome.machine} ${compilationCacheActivityLine(compilationCache)}`);
    logWriter().write({
      src: 'build',
      level: 'info',
      event: 'offload_done',
      msg: `built on ${outcome.machine}`,
      timings,
    });
    return true;
  }

  async function buildArtifact(): Promise<void> {
    buildFailure = { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache, buildMachine };
    if (!appPath) {
      const offload = placeBuild();
      if (!offload) await takeBuildSlot();

      const mutatingSteps: string[] = [];
      const rekeyedBy: string[] = [];

      const prebuild = d.planPrebuild(root, PLATFORM, { isExpo, fingerprint, sources: fingerprintSources });
      if (prebuild === 'refuse') {
        fail({ ...staleNativeDirRefusal(PLATFORM), build: buildFailure });
      }
      reportPendingRecheck(prebuild);
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
            build: buildFailure,
          });
        }
        const outcome =
          prebuild === 'generate'
            ? 'ios/ absent -> generated'
            : 'ios/ not generated from this fingerprint -> regenerated with --clean';
        phase('prebuild', `${outcome} (${formatDuration(result?.durationMs ?? 0)})`);
        mutatingSteps.push('prebuild');
      }

      // A bare (non-Expo) project's ios/ never regenerates; ios.ts already validated --scheme against it.
      if (isExpo && buildScheme !== undefined) {
        const project = d.discoverXcodeProject(root);
        if (project.error) fail({ ...project.error, build: buildFailure });
        const schemeError = d.resolveScheme(project, { scheme: buildScheme }).error;
        if (schemeError) fail({ ...schemeError, build: buildFailure });
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
            build: buildFailure,
          });
        }
        stats.setPodsMs(result?.durationMs ?? 0);
        phase(
          'pods',
          `${action.reason} -> installed with \`${podCommand}\` (${formatDuration(result?.durationMs ?? 0)})`,
        );
        mutatingSteps.push(podCommand);
      }

      if (mutatingSteps.length) {
        const after = await refingerprintAfterMutation({
          projectRoot: root,
          platform: PLATFORM,
          previousHash: fingerprint,
          fingerprint: d.fingerprintProject,
        });
        const prebuildRan = mutatingSteps.includes('prebuild');
        const editedConfig = after ? configInputsChanged(fingerprintSources, after.sources, { prebuildRan }) : [];
        if (after && !editedConfig.length && prebuildRan) {
          recordPrebuild(root, PLATFORM, after.hash);
        }
        if (!after || editedConfig.length) {
          storeHash = null;
          storeKey = null;
          buildFailure = { ...buildFailure, fingerprint: null, cacheKey: null };
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
          storeKey = buildCacheKey(PLATFORM, after.hash, keyOptions);
          buildFailure = { ...buildFailure, fingerprint: storeHash, cacheKey: storeKey };
          note(
            chalk.dim(
              phaseLine(
                'fingerprint',
                `${shortHash(fingerprint)} -> ${shortHash(storeHash)} (after ${mutatingSteps.join(', ')})`,
              ),
            ),
          );

          const late = useBuildCache ? d.resolveBuild(PLATFORM, storeKey) : null;
          if (late) {
            const prepared = await installableCachedApp(late);
            if (prepared) {
              appPath = prepared;
              cacheHit = 'local';
              lateHit();
              phase('cache', `hit ${shortHash(storeHash)} (post-${mutatingSteps.join('/')} key)`);
              if (releasedWait) {
                waitedForBuild = releasedWait.facts;
                phase(
                  'build',
                  `waited ${formatDuration(waitedForBuild.ms)} for ${releasedWait.who}'s build -> installed from cache -- stim guide lifecycle concurrency`,
                );
              }
            }
          }
        }
      }

      if (offload && !appPath) {
        explainMiss(rekeyedBy);
        step('compile');
        if (!storeKey)
          fallBack('no cache key to store the app under', 'offload failed: no cache key to store the app under');
        const choice = storeKey ? await chooseMachine(offload) : null;
        if (!choice || !(await compileElsewhere({ choice, candidate: offload }))) await takeBuildSlot();
      }

      if (!appPath) {
        if (!offload) explainMiss(rekeyedBy);
        step('compile');
        if (offload) {
          stats.setPlacement({
            decision: 'fell-back',
            reason: offloadFallback ?? 'offload failed',
            ...(fallbackMachine ? { machine: fallbackMachine } : {}),
          });
        } else if (hereReason) {
          stats.setPlacement({ decision: 'here', reason: hereReason });
        }
        builtOn = 'here';
        buildFailure = { ...buildFailure, builtOn };
        phase('build', `compiling ${configuration || 'Debug'} with xcodebuild`);
        const result = await d.buildIos({
          root,
          scheme: buildScheme,
          udid,
          destination: remoteDestination ? GENERIC_SIM_DESTINATION : null,
          arch: remoteDestination ? simulatorArch : null,
          ...(physical ? { sdk: IPHONEOS_SDK } : {}),
          logWriter: logWriter(),
          ...(configuration ? { configuration } : {}),
          estimateMs: estimates().coldBuildMs,
          optimizations: optimizations,
        });
        compilationCache = result.compilationCache;
        phase('cache', `compilation cache ${compilationCacheActivityLine(compilationCache)}`);
        if (!result.ok) {
          phase('build', `FAILED after ${formatDuration(result.durationMs)}`);
          printDiagnostics(note, result);
          const report = xcodeFailureReport(result, logFile);
          fail({
            code: result.code,
            message: report.message,
            remedy: report.remedy,
            logPath: logFile,
            build: { ...buildFailure, diagnostics: result.diagnostics },
          });
        }
        stats.setBuildMs(result.durationMs);
        phase('build', `ok (${formatDuration(result.durationMs)})`);
        appPath = result.appPath;
        bundleId = result.bundleId;

        await settleStoreKeyAfterCompile(mutatingSteps.includes('prebuild'));

        if (storeKey && cachePolicy.write) {
          try {
            const stored = await storeTieredBuild({
              local: filesystemBuildCapability({
                resolve: d.resolveBuild,
                store: d.storeBuild,
                sources: storeSources,
              }),
              loadProvider,
              target: { projectRoot: root, platform: PLATFORM, key: storeKey },
              sourcePath: appPath!,
              overwrite: !useBuildCache || swapFellBack,
              warn: cacheWarn,
            });
            providerUpload = stored.providerUpload;
            providerName = stored.providerName ?? providerName;
          } catch (e) {
            note(chalk.yellow(`Could not store the build in the shared cache: ${(e as Error)?.message || e}`));
          }
        }

        if (physical) {
          const prepared = await prepareDeviceApp(appPath!, { fresh: true });
          if (!prepared) return;
          appPath = prepared;
        }

        if (remote && !physical && storeHash) {
          uploadPending = d.uploadRemote({
            logWriter: logWriter(),
            provider: remote.provider,
            platform: PLATFORM,
            projectRoot: root,
            fingerprintHash: storeHash,
            buildPath: appPath!,
            runOptions: providerRunOptions,
          });
        }
      }
    }
  }

  let transferred = false;
  try {
    await resolveInitialFingerprint();
    if (!easBuild) {
      remote = await resolveRemoteArtifact();
      if (!appPath) miss(reasonForMiss([]).reason);
      await awaitSharedBuild();
      await prepareCachedArtifact();
      if (appPath) lateHit();
      else if (swapFellBack) miss(reasonForMiss([]).reason);
      await buildArtifact();
    }
    const artifact: PreparedIosArtifact = {
      path: appPath!,
      bundleId,
      cache: {
        identity: storeHash && storeKey ? { fingerprint: storeHash, key: storeKey } : null,
        hit: cacheHit,
        providerName: remote?.name ?? providerName,
        buildMachine,
        ...(builtOn ? { builtOn } : {}),
        offloadedTo,
        offloadFallback: offloadedTo ? null : offloadFallback,
        readEnabled: useBuildCache,
        missReason: cacheHit ? null : missReason,
        waitedForBuild,
        compilation: compilationCache,
      },
      failureFields: {
        ...buildFailure,
        buildMachine,
        ...(builtOn ? { builtOn } : {}),
        fingerprint: storeHash,
        cacheKey: storeKey,
        cacheHit,
        cacheSkipped: !useBuildCache,
      },
      completeUploads: async () => {
        const uploadWasAbandoned = await finishIosUpload(uploadPending, remote, phase, note);
        const outcome = providerUploadOutcome(providerUpload ? await providerUpload : null, providerName);
        if (outcome) {
          if (outcome.warn) note(chalk.yellow(phaseLine('cache', outcome.line)));
          else phase('cache', outcome.line);
        }
        return abandonedRemote || uploadWasAbandoned;
      },
      release: releaseArtifact,
    };
    transferred = true;
    return { ok: true, artifact };
  } catch (error) {
    if (error instanceof OffloadRefusal) {
      const refusal = error;
      return {
        ok: false,
        failure: {
          code: refusal.code,
          message: refusal.message,
          remedy: refusal.remedy,
          build: { ...buildFailure, buildMachine, ...(builtOn ? { builtOn } : {}) },
        },
        compilationCache,
      };
    }
    if (error instanceof ArtifactRefusal) return { ok: false, failure: error.failure, compilationCache };
    throw error;
  } finally {
    if (openOffload.choice) closeOffload(openOffload.choice);
    releaseLock();
    releaseSlot();
    if (!transferred) releaseArtifact();
  }
}
