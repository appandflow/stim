import { rmSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import {
  createWarnOnce,
  resolveTieredBuild,
  storeTieredBuild,
  type loadCacheProvider,
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
  refingerprintAfterMutation,
  untrackedMissLine,
  type fingerprintProject,
  type resolveBuild,
  type storeBuild,
  type storedAssetManifest,
  type untrackedNativeFiles,
} from '../../cache/build-cache.ts';
import { explainBuildMiss, fingerprintErrorMissReason, skippedMissReason } from '../../cache/miss-reason.ts';
import { formatDuration, phaseLine, shortHash, stepTimer } from '../../command-output.ts';
import {
  waitForSharedBuild,
  type acquireBuildLock,
  type releaseBuildLock,
  type waitForBuild as waitForOtherBuild,
  type BuildLockHandle,
} from '../../engine/build-lock.ts';
import type { acquireBuildSlot, releaseBuildSlot, BuildSlotHandle } from '../../engine/build-slots.ts';
import { resolveKeystore, type swapApkBundle } from '../../engine/apk-swap.ts';
import type { captureAssetManifest } from '../../engine/asset-manifest.ts';
import { CCACHE_NOT_RUN, CCACHE_UNAVAILABLE, ccacheActivityLine, type resolveCcache } from '../../engine/ccache.ts';
import type { OwnedDeviceRecord } from '../../engine/device.ts';
import type { EasBuildResult } from '../../engine/eas-build.ts';
import { formatDiagnostic } from '../../engine/errors-gradle.ts';
import type { buildAndroid } from '../../engine/gradle.ts';
import { recordPrebuild, staleNativeDirRefusal, type planPrebuild, type runPrebuild } from '../../engine/prebuild.ts';
import {
  easAuthNote,
  isEasAuthFailureText,
  RESOLVE_TIMEOUT_MS,
  type checkEasAuth,
  type loadProjectProvider,
  type resolveRemote,
  type uploadRemote,
  type LoadProjectProviderResult,
} from '../../engine/remote-cache.ts';
import type { RunEstimates, RunRecorder } from '../../engine/stats.ts';
import type { BuildPhase } from '../../engine/build-progress.ts';
import { machineCapacity, type BuildMissReason, type MachineCapacity, type OffloadMode } from '@stim-cli/core/state';
import { claimFailure } from '../../ownership-claim.ts';
import type { pairedMachines } from '../../offload/build-machines.ts';
import {
  closeOffload,
  chooseBuildMachine,
  offloadBuild,
  buildPlacementCandidates,
  offloadPlacement,
  placementLoad,
  remotePhaseText,
  type OffloadChoice,
} from '../../offload/client.ts';
import { namedBuildMachine, OffloadRefusal } from '../../offload/selection.ts';
import { androidRequirements, androidToolchain } from '../../offload/toolchain.ts';
import { workspaceDir } from '../../workspace/paths.ts';
import { detectAndroidPackage } from '../../workspace/app-id.ts';
import type { SettingsObject } from '../../workspace/settings.ts';
import type { androidDeviceAbi } from '../../devices/android.ts';
import type { CcacheActivity, WaitedForBuild } from '../../engine/build-facts.ts';
import type { readWorkspaceState } from '../../workspace/workspace-state.ts';
import type { AndroidRunPlan } from './plan.ts';
import { androidBuildOptions, displayPath, NO_FINGERPRINT, PLATFORM } from './support.ts';
import type { AndroidRecord, AndroidWriter, FailExtra, PrebuildResultLike, RemoteUploadLike } from './types.ts';

const FALLBACK_LINES = 5;

interface AndroidArtifactRequest {
  root: string;
  buildLog: string;
  writer: AndroidWriter;
  settings: SettingsObject;
  isExpo: boolean;
  device: OwnedDeviceRecord;
  physical: boolean;
  /** Whether the app runs on a remote device backend rather than a local emulator. */
  remote: boolean;
  buildPlan: AndroidRunPlan['build'];
  cacheProviderConfig: AndroidRunPlan['cacheProviderConfig'];
  requestedBuildCache: boolean;
  easBuild: Extract<EasBuildResult, { ok: true }> | null;
  androidPackage: string | null;
  record: AndroidRecord;
  maxBuilds: number | null | undefined;
  progress: {
    phase: (label: unknown, text: string) => void;
    out: (line: string) => void;
    estimates: () => RunEstimates;
    stats: Pick<RunRecorder, 'setCacheKey' | 'setBuildMs' | 'setPlacement'>;
    step: (phase: BuildPhase) => void;
    miss: (reason: BuildMissReason, provisional?: boolean) => void;
    hit: () => void;
    place: (remote: { host: string; phase: string } | null) => void;
    waitingOn: (root: string | null) => void;
  };
}

interface AndroidArtifactDeps {
  deviceAbi: typeof androidDeviceAbi;
  fingerprint: typeof fingerprintProject;
  untracked: typeof untrackedNativeFiles;
  resolveCached: typeof resolveBuild;
  storeCached: typeof storeBuild;
  storedAssets: typeof storedAssetManifest;
  captureAssets: typeof captureAssetManifest;
  acquireLock: typeof acquireBuildLock;
  releaseLock: typeof releaseBuildLock;
  waitForBuild: typeof waitForOtherBuild;
  loadProvider: typeof loadProjectProvider;
  easAuth: typeof checkEasAuth;
  resolveRemoteBuild: typeof resolveRemote;
  uploadRemoteBuild: typeof uploadRemote;
  loadCacheProviderModule: typeof loadCacheProvider;
  acquireSlot: typeof acquireBuildSlot;
  releaseSlot: typeof releaseBuildSlot;
  planPrebuildFor: typeof planPrebuild;
  prebuild: typeof runPrebuild;
  build: typeof buildAndroid;
  ccacheFor: typeof resolveCcache;
  swapApk: typeof swapApkBundle;
  readState: typeof readWorkspaceState;
  now: () => number;
}

/** The installable APK plus the cache work this run still owes the caller. */
interface PreparedAndroidArtifact {
  apkPath: string | null;
  androidPackage: string | null;
  swapDir: string | null;
  waitedForBuild: WaitedForBuild | null;
  ccache: CcacheActivity;
  uploadPending: Promise<RemoteUploadLike> | null;
  providerUpload: Promise<ProviderCallResult<void>> | null;
  providerName: string | null;
  remote: LoadProjectProviderResult | null;
  abandonedRemote: boolean;
}

interface AndroidArtifactFailure {
  code: string | undefined;
  message: string | null | undefined;
  remedy: string | null | undefined;
  extra: FailExtra;
}

type AndroidArtifactResult =
  | { ok: true; artifact: PreparedAndroidArtifact }
  | { ok: false; failure: AndroidArtifactFailure; ccache: CcacheActivity };

function fail(
  code: string | undefined,
  message?: string | null,
  remedy?: string | null,
  extra: FailExtra = {},
): AndroidArtifactFailure {
  return { code, message, remedy, extra };
}

export async function acquireAndroidArtifact(
  {
    root,
    buildLog,
    writer,
    settings,
    isExpo,
    device,
    physical,
    remote: remoteTarget,
    buildPlan,
    cacheProviderConfig,
    requestedBuildCache,
    easBuild,
    androidPackage: initialPackage,
    record,
    maxBuilds,
    progress,
  }: AndroidArtifactRequest,
  {
    deviceAbi,
    fingerprint,
    untracked,
    resolveCached,
    storeCached,
    storedAssets,
    captureAssets,
    acquireLock,
    releaseLock,
    waitForBuild,
    loadProvider,
    easAuth,
    resolveRemoteBuild,
    uploadRemoteBuild,
    loadCacheProviderModule,
    acquireSlot,
    releaseSlot,
    planPrebuildFor,
    prebuild,
    build,
    ccacheFor,
    swapApk,
    readState,
    now,
  }: AndroidArtifactDeps,
): Promise<AndroidArtifactResult> {
  const { phase, out, estimates, stats, step, miss, hit: lateHit, place, waitingOn } = progress;
  let fallbackMachine: string | null = null;
  let hereReason = 'no build machine is paired';
  let slotWaitMs: number | undefined;
  const buildMachine = record.buildMachine ?? 'auto';
  const fallBack = (reason: string, line: string = reason) => {
    if (namedBuildMachine(buildMachine)) throw new OffloadRefusal(buildMachine, reason);
    record.offloadFallback = reason;
    phase('build', `${line} -> building here`);
  };
  const { variant, release, profile: buildProfile, cas, cache: cachePolicy } = buildPlan;
  const useBuildCache = cachePolicy.read;
  let androidPackage = initialPackage;
  let ccacheActivity: CcacheActivity = CCACHE_NOT_RUN;
  let phaseFailure: AndroidArtifactFailure | null = null;

  const refused = (): AndroidArtifactResult => ({ ok: false, failure: phaseFailure!, ccache: ccacheActivity });

  let buildLock: BuildLockHandle | null = null;
  const releaseHeldLock = () => {
    if (!buildLock) return;
    const held = buildLock;
    buildLock = null;
    try {
      releaseLock(held);
    } catch (err) {
      out(
        phaseLine(
          'build',
          chalk.dim(`could not release the build lock at ${held.path}: ${(err as Error)?.message || err}`),
        ),
      );
    }
  };

  let buildSlot: BuildSlotHandle | null = null;
  const releaseHeldSlot = () => {
    if (!buildSlot) return;
    const held = buildSlot;
    buildSlot = null;
    try {
      releaseSlot(held);
    } catch (err) {
      out(phaseLine('build', chalk.dim(`could not release the build slot: ${(err as Error)?.message || err}`)));
    }
  };

  const {
    abi: buildAbi,
    runOptions: buildRunOptions,
    remoteRunOptions,
  } = androidBuildOptions({
    release,
    physical,
    device,
    variant,
    deviceAbi,
    compiler: cas?.id,
    buildProfile,
    targetAbiOnly: buildPlan.targetAbiOnly,
  });

  let hash = '';
  let providerUpload: Promise<ProviderCallResult<void>> | null = null;
  let providerName: string | null = null;
  let providerLoad: Promise<LoadCacheProviderResult> | null = null;
  const cacheWarn = createWarnOnce((line) => phase('cache', chalk.yellow(line)));
  const loadTieredProvider =
    cachePolicy.remote && cacheProviderConfig
      ? () => (providerLoad ??= loadCacheProviderModule({ projectRoot: root, config: cacheProviderConfig }))
      : null;
  let fingerprintSources: FingerprintSource[] = [];
  let cacheKey = '';
  let storeHash = '';
  let storeKey = '';
  let storeSources: FingerprintSource[] = [];
  let apkPath: string | null = null;
  let swapFellBack = false;

  async function resolveInitialFingerprint(): Promise<boolean> {
    if (easBuild?.ok) {
      hash = storeHash = easBuild.fingerprint;
      cacheKey = storeKey = easBuild.cacheKey;
      apkPath = easBuild.path;
      record.fingerprint = hash;
      record.cacheKey = cacheKey;
      record.cacheHit = easBuild.cacheHit;
      record.cacheSkipped = !useBuildCache;
      providerName = 'eas';
      stats.setCacheKey(cacheKey);
      return true;
    }
    step('cache-lookup');
    const fingerprintTimer = stepTimer(now);
    try {
      const computed = await fingerprint(root, { platform: PLATFORM });
      hash = computed?.hash ?? '';
      fingerprintSources = computed?.sources ?? [];
    } catch (err) {
      const message = String((err as Error)?.message || err);
      record.cacheSkipped = !useBuildCache;
      record.missReason = fingerprintErrorMissReason(message);
      phaseFailure = fail(
        NO_FINGERPRINT,
        `@expo/fingerprint could not fingerprint ${root}: ${message}`,
        'Fix the @expo/fingerprint error above, then retry.',
        { lastBuildStatus: true },
      );
      return false;
    }
    if (!hash) {
      record.cacheSkipped = !useBuildCache;
      record.missReason = fingerprintErrorMissReason('no hash');
      phaseFailure = fail(
        NO_FINGERPRINT,
        `@expo/fingerprint returned no hash for ${root}, so the build cache cannot be addressed.`,
        'Check the project native inputs and the @expo/fingerprint error above, then retry.',
        { lastBuildStatus: true },
      );
      return false;
    }
    record.fingerprint = hash;
    cacheKey = buildCacheKey(PLATFORM, hash, buildRunOptions);
    stats.setCacheKey(cacheKey);
    record.cacheKey = cacheKey;
    storeHash = hash;
    storeKey = cacheKey;
    storeSources = fingerprintSources;

    const found = await resolveTieredBuild({
      local: filesystemBuildCapability({ resolve: resolveCached, store: storeCached, sources: fingerprintSources }),
      loadProvider: loadTieredProvider,
      target: { projectRoot: root, platform: PLATFORM, key: cacheKey },
      destinationDir: providerDownloadPath(workspaceDir(root)),
      ensureDestination: prepareProviderDownloadDir,
      skipRead: !useBuildCache,
      warn: cacheWarn,
    });
    const cached = found?.tier === 'local' ? found.path : null;
    record.cacheHit = cached ? 'local' : false;
    record.cacheSkipped = !useBuildCache;
    phase(
      'fingerprint',
      `${shortHash(hash)} ${cached ? 'hit' : 'miss'}${useBuildCache ? '' : !requestedBuildCache ? ' (--no-build-cache)' : ' (cache reuse off in config)'} ${fingerprintTimer()}`,
    );
    if (found?.tier === 'provider') {
      record.cacheHit = 'remote';
      providerName = found.providerName ?? null;
      phase('cache', `provider hit (${providerName})${found.storedLocally ? ' -> stored locally' : ''}`);
    }
    apkPath = found?.path ?? null;
    return true;
  }

  if (!(await resolveInitialFingerprint())) return refused();

  let remote: LoadProjectProviderResult | null = null;
  let abandonedRemote = false;
  let uploadPending: Promise<RemoteUploadLike> | null = null;

  async function resolveRemoteArtifact(): Promise<void> {
    // Expo buildCacheProvider run options cannot key Android ABIs, so targeted APKs are unsafe in this tier.
    if (buildAbi || cas || buildProfile || !cachePolicy.remote) return;

    if (!apkPath) {
      const loaded: LoadProjectProviderResult = await loadProvider(root, { isExpo });
      if (loaded?.unavailable) {
        phase('cache', chalk.yellow(`provider not usable: ${loaded.unavailable}`));
      } else if (loaded?.provider) {
        remote = loaded;
      }
      if (remote?.name === 'eas') {
        const auth = easAuth({ projectRoot: root, owner: loaded?.owner || null });
        const authNote = easAuthNote(auth as Parameters<typeof easAuthNote>[0]);
        if (authNote) phase('cache', chalk.yellow(authNote));
        if (auth?.code === 'logged-out') remote = null;
      }
    }

    if (remote && useBuildCache) {
      const remoteTimer = stepTimer(now);
      const hit = await resolveRemoteBuild({
        logWriter: writer,
        provider: remote.provider,
        platform: PLATFORM,
        projectRoot: root,
        fingerprintHash: hash,
        runOptions: remoteRunOptions,
      });
      if (hit?.appPath) {
        let stored = null;
        try {
          stored = storeCached(PLATFORM, cacheKey, hit.appPath, { sources: fingerprintSources });
        } catch (err) {
          phase('cache', chalk.yellow(`remote hit could not be stored locally: ${(err as Error)?.message || err}`));
        }
        apkPath = stored || hit.appPath;
        record.cacheHit = 'remote';
        phase('cache', `remote hit (${remote.name})${stored ? ' -> stored locally' : ''} ${remoteTimer()}`);
      } else if (hit?.timedOut) {
        abandonedRemote = true;
        phase(
          'cache',
          chalk.yellow(`${remote.name} did not answer within ${formatDuration(RESOLVE_TIMEOUT_MS)}; building instead`),
        );
      } else if (hit?.failed) {
        const authNote =
          remote.name === 'eas' && isEasAuthFailureText(hit.failed)
            ? easAuthNote({ code: 'logged-out', reason: hit.failed })
            : null;
        phase('cache', chalk.yellow(authNote || `${remote.name} could not be used: ${hit.failed}; building instead`));
      } else {
        phase('cache', `remote miss (${remote.name}) ${remoteTimer()}`);
      }
    }
  }

  if (!easBuild) {
    await resolveRemoteArtifact();
    if (!apkPath) miss(reasonForMiss([]).reason);
  }

  let waitedForBuild: WaitedForBuild | null = null;
  let releasedWait: { facts: WaitedForBuild; who: string } | null = null;
  if (!easBuild && useBuildCache && !apkPath) {
    const shared = await waitForSharedBuild({
      platform: PLATFORM,
      key: cacheKey,
      fingerprint: hash,
      root,
      logFile: buildLog,
      command: 'stim android',
      acquire: acquireLock,
      wait: waitForBuild,
      now,
      phase: (text) => {
        step('wait');
        phase('build', text);
      },
      waitingOn,
      warn: (text) => phase('build', chalk.yellow(text)),
      out,
    });
    if (shared.refusal) {
      const { code, message, remedy } = shared.refusal;
      phaseFailure = fail(code, message, remedy, { lastBuildStatus: true });
      return refused();
    }
    buildLock = shared.lock;
    releasedWait = shared.released;
    if (shared.hit) {
      apkPath = shared.hit.path;
      record.cacheHit = 'local';
      waitedForBuild = shared.hit.waited;
    }
  }

  let swapDir: string | null = null;
  const installableCachedApk = async (key: string, cachedPath: string): Promise<string | null> => {
    if (!release) return cachedPath;
    phase('swap', `regenerating this workspace's JS for the cached ${variant} APK`);
    const swap = await swapApk({
      root,
      isExpo,
      cachedApkPath: cachedPath,
      keystore: resolveKeystore(root, settings),
      logWriter: writer,
      storedAssets: storedAssets(PLATFORM, key),
    });
    if (swap?.ok && swap.apkPath) {
      if (swap.note) phase('swap', chalk.yellow(swap.note));
      swapDir = swap.tmpDir ?? null;
      phase(
        'swap',
        `${swap.hermes ? 'hermes bytecode' : 'plain JS'} repacked (store), zipaligned and re-signed (${formatDuration(swap.durationMs)})`,
      );
      return swap.apkPath;
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
    swapFellBack = true;
    return null;
  };

  async function prepareCachedArtifact(): Promise<void> {
    if (apkPath && record.cacheHit) {
      const prepared = await installableCachedApk(cacheKey, apkPath);
      apkPath = prepared;
      if (!prepared) {
        record.cacheHit = false;
        waitedForBuild = null;
      }
    }
  }

  function reasonForMiss(rekeyedBy: string[]): { reason: BuildMissReason; diff: Record<string, unknown> | null } {
    if (swapFellBack) {
      return {
        reason: skippedMissReason('the cached APK could not be reused, so this run built it fresh'),
        diff: null,
      };
    }
    if (!useBuildCache) {
      return {
        reason: skippedMissReason(
          requestedBuildCache ? 'cache reuse off in config' : 'cache reuse turned off by --no-build-cache',
        ),
        diff: null,
      };
    }
    const current = { hash: storeHash, sources: storeSources };
    const explained = explainBuildMiss({
      root,
      platform: PLATFORM,
      current,
      rekeyedBy,
      baselineDeps: { readState },
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

  function explainMiss(rekeyedBy: string[]): void {
    const explained = reasonForMiss(rekeyedBy);
    record.missReason = explained.reason;
    if (explained.diff) writer.write(explained.diff);
    miss(record.missReason);
    phase('cache', `miss: ${record.missReason.summary}`);
    if (record.missReason.kind === 'no-baseline') {
      const line = untrackedMissLine(untracked({ projectRoot: root }));
      if (line) phase('fingerprint', chalk.dim(line));
    }
  }

  async function takeBuildSlot(): Promise<boolean> {
    if (!maxBuilds) return true;
    try {
      buildSlot = await acquireSlot({ max: maxBuilds, root, logFile: buildLog, out });
      slotWaitMs = buildSlot.slotWaitMs;
    } catch (err) {
      const refusal = claimFailure(err, 'stim android');
      if (refusal) {
        phaseFailure = fail(refusal.code, refusal.message, refusal.remedy, { lastBuildStatus: true });
        return false;
      }
      phase('build', chalk.yellow(`could not take a build slot: ${(err as Error)?.message || err}; building anyway`));
    }
    return true;
  }

  interface Candidate {
    mode: OffloadMode;
    here: MachineCapacity;
    reason: string;
    machines: ReturnType<typeof pairedMachines>;
  }

  /** Whether this build should leave this Mac, before any machine is asked; null builds here. */
  function placeBuild(): Candidate | null {
    const { mode, machines } = buildPlacementCandidates(buildMachine);
    if (machines.length === 0 && !namedBuildMachine(buildMachine) && buildMachine !== 'local') return null;
    const unsupported = physical
      ? 'device builds build here'
      : remoteTarget
        ? 'remote device builds build here'
        : release
          ? `${variant} builds build here`
          : cas
            ? 'Apple Clang CAS builds build here'
            : !cachePolicy.write
              ? 'the build cache is off'
              : null;
    const here = machineCapacity();
    const placement = offloadPlacement({ mode, machines: machines.length, here, unsupported, selected: buildMachine });
    if (!placement.offload) {
      hereReason = placement.reason;
      if (mode !== 'off') phase('build', `placement: here (${placement.reason})`);
      return null;
    }
    return { mode, here, reason: placement.reason, machines };
  }

  const openOffload: { choice: OffloadChoice | null } = { choice: null };

  /** Asks the paired machines once the post-mutation key is known; null builds here. */
  async function chooseMachine(candidate: Candidate): Promise<OffloadChoice | null> {
    const choice = await chooseBuildMachine({
      projectRoot: root,
      target: { platform: 'android', local: androidToolchain(), requires: androidRequirements(root) },
      mode: candidate.mode,
      here: candidate.here,
      note: (line) => phase('build', chalk.dim(`offload: ${line}`)),
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

  /** Builds on the chosen machine and stores the APK under the post-mutation key; false builds here instead unless a machine was named. */
  async function compileElsewhere(choice: OffloadChoice, candidate: Candidate): Promise<boolean> {
    if (!storeKey || !storeHash) {
      if (namedBuildMachine(buildMachine)) fallBack('the build fingerprint or cache key is unavailable');
      return false;
    }
    const stagingDir = join(workspaceDir(root), 'offload', PLATFORM);
    const outcome = await offloadBuild({
      choice,
      expectedFingerprint: storeHash,
      request: {
        platform: 'android',
        isExpo,
        android: {
          variant,
          abi: buildAbi,
          gradleBuildCache: buildPlan.gradleBuildCache,
          pch: buildPlan.pch,
          compilerCache: buildPlan.compilerCache === 'none' ? 'none' : 'ccache',
        },
      },
      stagingDir,
      onPhase: (name, msg) => phase(name, remotePhaseText(name, msg, choice.machine)),
      onEnter: (name) => {
        if (name === 'compile' || name === 'build' || name === 'prebuild' || name === 'pods')
          record.builtOn = choice.machine;
        place({ host: choice.machine, phase: name });
        step(name === 'prebuild' ? name : 'compile');
      },
      onRecord: (entry) => writer.write({ ...entry, offloadedTo: choice.machine }),
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
        fingerprint,
      });
      if (!settled || settled.moved) {
        reason = 'the checkout here changed while it built';
      } else {
        try {
          stored = storeCached(PLATFORM, storeKey, outcome.artifactPath, {
            sources: storeSources,
            overwrite: !useBuildCache,
          });
        } catch (err) {
          reason = `could not store the APK: ${(err as Error)?.message || err}`;
        }
      }
    }
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    step('compile');
    if (!outcome.ok || !stored) {
      const why = reason ?? 'the APK was not stored';
      fallbackMachine = choice.machine;
      fallBack(`${choice.machine}: ${why}`, `offload failed: ${why}`);
      writer.write({ src: 'build', level: 'warn', event: 'offload_failed', msg: reason, machine: choice.machine });
      return false;
    }
    const { timings } = outcome;
    apkPath = stored;
    record.builtOn = outcome.machine;
    record.offloadedTo = outcome.machine;
    stats.setPlacement({
      decision: 'offloaded',
      machine: outcome.machine,
      reason: `${candidate.reason}${placementLoad(choice)}`,
      buildMs: timings.totalMs,
    });
    ccacheActivity = outcome.ccache;
    phase(
      'build',
      `built on ${outcome.machine} in ${formatDuration(timings.totalMs)}: offer ${formatDuration(timings.offerMs)}, ` +
        `sync ${formatDuration(timings.syncMs)}, build ${formatDuration(timings.workerMs)}, fetch ${formatDuration(timings.fetchMs)}`,
    );
    phase('cache', `compilation cache on ${outcome.machine} ${ccacheActivityLine(ccacheActivity)}`);
    writer.write({ src: 'build', level: 'info', event: 'offload_done', msg: `built on ${outcome.machine}`, timings });
    return true;
  }

  async function buildArtifact(): Promise<boolean> {
    if (!apkPath) {
      try {
        const offload = placeBuild();
        if (!offload && !(await takeBuildSlot())) return false;

        const rekeyedBy: string[] = [];
        let editedConfig: string[] = [];
        const prebuildPlan = planPrebuildFor(root, PLATFORM, {
          isExpo,
          fingerprint: hash,
          sources: fingerprintSources,
        });
        const prebuildRan = prebuildPlan === 'generate' || prebuildPlan === 'regenerate';
        if (prebuildPlan === 'refuse') {
          const refusal = staleNativeDirRefusal(PLATFORM);
          phaseFailure = fail(refusal.code, refusal.message, refusal.remedy, { lastBuildStatus: true });
          return false;
        }
        if (prebuildRan) {
          miss(reasonForMiss([]).reason, true);
          step('prebuild');
          recordPrebuild(root, PLATFORM, null);
          const pre: PrebuildResultLike = await prebuild(root, PLATFORM, writer, {
            isExpo,
            clean: prebuildPlan === 'regenerate',
          });
          if (pre.failed) {
            phaseFailure = fail(pre.code!, pre.reason, pre.remedy, {
              lastBuildStatus: true,
              lines: tail(pre.lastLines),
              logPath: displayPath(root, buildLog),
            });
            return false;
          }
          const outcome =
            prebuildPlan === 'generate'
              ? 'android/ generated'
              : 'android/ not generated from this fingerprint -> regenerated with --clean';
          phase('prebuild', `${outcome} (${formatDuration(pre.durationMs)})`);
          androidPackage = detectAndroidPackage(root) || androidPackage;
          record.bundleId = androidPackage;

          const after = await refingerprintAfterMutation({
            projectRoot: root,
            platform: PLATFORM,
            previousHash: hash,
            fingerprint,
          });
          editedConfig = after ? configInputsChanged(fingerprintSources, after.sources, { prebuildRan }) : [];
          if (after && !editedConfig.length) recordPrebuild(root, PLATFORM, after.hash);
          if (after?.moved && !editedConfig.length) {
            rekeyedBy.push('prebuild');
            storeHash = after.hash;
            storeSources = after.sources;
            storeKey = buildCacheKey(PLATFORM, after.hash, buildRunOptions);
            record.fingerprint = storeHash;
            record.cacheKey = storeKey;
            phase('fingerprint', chalk.dim(`${shortHash(hash)} -> ${shortHash(storeHash)} (after prebuild)`));

            const late = useBuildCache ? resolveCached(PLATFORM, storeKey) : null;
            if (late) {
              const prepared = await installableCachedApk(storeKey, late);
              if (prepared) {
                apkPath = prepared;
                record.cacheHit = 'local';
                lateHit();
                phase('cache', `hit ${shortHash(storeHash)} (post-prebuild key)`);
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

        if (offload && !apkPath) {
          explainMiss(rekeyedBy);
          step('compile');
          let built = false;
          if (editedConfig.length) {
            fallBack(
              'prebuild changed config inputs, so the APK cannot be cached',
              'offload failed: prebuild changed config inputs, so the APK cannot be cached',
            );
          } else {
            const choice = await chooseMachine(offload);
            if (choice) built = await compileElsewhere(choice, offload);
          }
          if (!built && !(await takeBuildSlot())) return false;
        }

        if (!apkPath) {
          if (!offload) {
            explainMiss(rekeyedBy);
            step('compile');
          }
          if (offload) {
            stats.setPlacement({
              decision: 'fell-back',
              slotWaitMs,
              reason: record.offloadFallback ?? 'offload failed',
              ...(fallbackMachine ? { machine: fallbackMachine } : {}),
            });
          } else {
            stats.setPlacement({ decision: 'here', reason: hereReason, slotWaitMs });
          }
          record.builtOn = 'here';
          phase('build', `compiling ${variant || 'debug'} with Gradle`);
          const built = await build(
            { root, logWriter: writer, variant, abi: buildAbi },
            {
              estimateMs: estimates().coldBuildMs,
              ccache: buildPlan.compilerCache === 'ccache' ? ccacheFor({ root, onNote: out }) : null,
              cas,
              buildCache: buildPlan.gradleBuildCache,
              pch: buildPlan.pch,
              compilerCacheDisabled: buildPlan.compilerCache === 'none',
            },
          );
          ccacheActivity = built.ccache ?? CCACHE_UNAVAILABLE;
          phase('cache', `compilation cache ${ccacheActivityLine(ccacheActivity)}`);
          if (!built.ok) {
            const diagnostics = built.diagnostics;
            for (const diag of diagnostics) {
              writer.write({ src: 'build', level: 'error', event: 'gradle_diagnostic', msg: formatDiagnostic(diag) });
            }
            phase('build', chalk.red(`FAILED after ${formatDuration(built.durationMs)}`));
            const extracted = diagnostics.map(formatDiagnostic);
            if (built.truncated > 0) extracted.push(`... and ${built.truncated} more diagnostic(s) in the log`);
            phaseFailure = fail(
              built.code,
              built.reason,
              diagnostics.find((d) => d.remedy)?.remedy || built.remedy || null,
              {
                lastBuildStatus: true,
                diagnostics: extracted,
                buildDiagnostics: diagnostics,
                lines: extracted.length ? [] : tail(built.lastLines),
                logPath: displayPath(root, buildLog),
              },
            );
            return false;
          }
          apkPath = built.apkPath;
          stats.setBuildMs(built.durationMs);
          phase('build', `ok (${formatDuration(built.durationMs)})`);
          if (built.apkNote) phase('build', chalk.yellow(built.apkNote));

          const beforeBuildHash = storeHash;
          const afterBuild = editedConfig.length
            ? null
            : await refingerprintAfterMutation({
                projectRoot: root,
                platform: PLATFORM,
                previousHash: beforeBuildHash,
                fingerprint,
              });
          const changedDuringBuild = afterBuild
            ? inputsChangedDuringBuild({
                platform: PLATFORM,
                lookup: fingerprintSources,
                prebuildRan,
                compiled: storeSources,
                current: afterBuild.sources,
              })
            : editedConfig;
          if (!afterBuild || changedDuringBuild.length) {
            record.fingerprint = null;
            record.cacheKey = null;
            phase(
              'fingerprint',
              chalk.yellow(
                changedDuringBuild.length
                  ? changedDuringBuildLine(changedDuringBuild)
                  : 'unavailable after Gradle; the build will be installed but not cached',
              ),
            );
          } else {
            if (afterBuild.moved) {
              storeHash = afterBuild.hash;
              storeSources = afterBuild.sources;
              storeKey = buildCacheKey(PLATFORM, afterBuild.hash, buildRunOptions);
              record.fingerprint = storeHash;
              record.cacheKey = storeKey;
              phase(
                'fingerprint',
                chalk.dim(`${shortHash(beforeBuildHash)} -> ${shortHash(storeHash)} (after Gradle)`),
              );
            }

            if (cachePolicy.write) {
              const assetManifest = release ? captureAssets(root, { variant }) : null;
              try {
                const stored = await storeTieredBuild({
                  local: filesystemBuildCapability({
                    resolve: resolveCached,
                    store: storeCached,
                    sources: storeSources,
                    assetManifest,
                  }),
                  loadProvider: loadTieredProvider,
                  target: { projectRoot: root, platform: PLATFORM, key: storeKey },
                  sourcePath: apkPath!,
                  overwrite: !useBuildCache || swapFellBack,
                  warn: cacheWarn,
                });
                providerUpload = stored.providerUpload;
                providerName = stored.providerName ?? providerName;
              } catch (err) {
                phase('cache', chalk.yellow(`could not store the build: ${(err as Error)?.message || err}`));
              }
            }

            if (remote) {
              uploadPending = uploadRemoteBuild({
                logWriter: writer,
                provider: remote.provider,
                platform: PLATFORM,
                projectRoot: root,
                fingerprintHash: storeHash,
                buildPath: apkPath!,
                runOptions: remoteRunOptions,
              });
            }
          }
        }
      } catch (error) {
        if (!(error instanceof OffloadRefusal)) throw error;
        const refusal = error;
        phaseFailure = fail(refusal.code, refusal.message, refusal.remedy, { lastBuildStatus: true });
        return false;
      } finally {
        if (openOffload.choice) closeOffload(openOffload.choice);
        releaseHeldLock();
        releaseHeldSlot();
      }
    }
    return true;
  }

  if (!easBuild) {
    await prepareCachedArtifact();
    if (apkPath) lateHit();
    else if (swapFellBack) miss(reasonForMiss([]).reason);
    if (!(await buildArtifact())) return refused();
  }

  return {
    ok: true,
    artifact: {
      apkPath,
      androidPackage,
      swapDir,
      waitedForBuild,
      ccache: ccacheActivity,
      uploadPending,
      providerUpload,
      providerName,
      remote,
      abandonedRemote,
    },
  };
}

function tail(lines: unknown, n = FALLBACK_LINES): string[] {
  return (Array.isArray(lines) ? lines : []).slice(-n);
}
