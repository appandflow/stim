import { retainFailedTranscript } from '../../engine/failed-transcript.ts';
import { withDrainingCancellation } from '../../engine/operation-state.ts';
import { throwIfCancelled } from '../../cancellation.ts';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import {
  createWarnOnce,
  timeoutFromEnv,
  PROVIDER_LOAD_TIMEOUT_ENV,
  PROVIDER_LOAD_TIMEOUT_MS,
  buildResolveTimeoutMs,
  buildUploadTimeoutMs,
  resolveTieredBuild,
  storeTieredBuild,
  type loadCacheProvider,
  type LoadCacheProviderResult,
  type ProviderCallResult,
} from '@stim-cli/cache';
import { prepareProviderDownloadDir, providerDownloadPath, type storedAppId } from '../../cache/build-cache.ts';
import type { RecordedBuild } from '../../engine/recorded-build.ts';
import type { FingerprintCheck } from '../../cache/fingerprint-memo.ts';
import { skippedMissReason } from '../../cache/miss-reason.ts';
import { buildPlacementRecord, type PlacementCandidate } from '../../placement-log.ts';
import { formatDuration, phaseLine, shortHash, stepTimer } from '../../command-output.ts';
import type { acquireBuildLock, releaseBuildLock, waitForBuild as waitForOtherBuild } from '../../engine/build-lock.ts';
import type { acquireBuildSlot, releaseBuildSlot } from '../../engine/build-slots.ts';
import { acquireArtifact, settleArtifactUploads, type ArtifactRun } from '../../engine/acquire-artifact.ts';
import type { ReadyArtifact } from '../../engine/artifact-lifecycle.ts';
import { CCACHE_NOT_RUN, CCACHE_UNAVAILABLE, ccacheActivityLine } from '../../engine/ccache.ts';
import type { EasBuildResult } from '../../engine/eas-build.ts';
import { formatDiagnostic } from '../../engine/errors-gradle.ts';

import {
  easAuthNote,
  isEasAuthFailureText,
  RESOLVE_TIMEOUT_MS,
  type checkEasAuth,
  type resolveRemote,
  type uploadRemote,
  type LoadProjectProviderResult,
} from '../../engine/remote-cache.ts';
import type { RunRecorder } from '../../engine/stats.ts';
import type { BuildPhase, BuildProgress } from '../../engine/build-progress.ts';
import { machineCapacity, type BuildMissReason, type MachineCapacity } from '@stim-cli/core/state';
import { claimFailure } from '../../ownership-claim.ts';
import { predictedRefusal, type pairedMachines } from '../../offload/build-machines.ts';
import {
  closeOffload,
  chooseBuildMachine,
  offloadBuild,
  buildPlacementCandidates,
  offloadPlacement,
  offloadCheck,
  placementLoad,
  remotePhaseText,
  type OffloadChoice,
  type BuildHandoff,
} from '../../offload/client.ts';
import {
  fingerprintMismatchRemedy,
  missingPackageManagerRemedy,
  automaticBuild,
  namedBuildMachine,
  OffloadRefusal,
  requireLocalBuild,
} from '../../offload/selection.ts';
import { workspaceDir } from '../../workspace/paths.ts';
import type { CcacheActivity, WaitedForBuild } from '../../engine/build-facts.ts';
import type { AndroidBuildPlan } from './plan.ts';
import { displayPath, PLATFORM } from './support.ts';
import type { AndroidRecord, AndroidWriter, FailExtra, RemoteUploadLike } from './types.ts';

import {
  AndroidRecipeRefusal as ArtifactRefusal,
  type AndroidArtifactFailure,
  type AndroidArtifactRecipe,
  type AndroidSourcePreparation,
} from '../../integrations/android-project.ts';
import { cancelledFailure, runCancellationSignal } from '../../engine/native-run.ts';
import type { StimContext } from '@stim-cli/core';

const FALLBACK_LINES = 5;

interface AndroidArtifactRequest {
  context: StimContext;
  root: string;
  buildLog: string;
  writer: AndroidWriter;
  recipe: AndroidArtifactRecipe;
  targetOffloadRefusal: string | null;
  buildPlan: Pick<AndroidBuildPlan['build'], 'variant' | 'cache'>;
  cacheProviderConfig: AndroidBuildPlan['cacheProviderConfig'];
  requestedBuildCache: boolean;
  easBuild: Extract<EasBuildResult, { ok: true }> | null;
  androidPackage: string | null;
  record: AndroidRecord;
  maxBuilds: number | null | undefined;
  progress: {
    phase: (label: unknown, text: string) => void;
    out: (line: string) => void;
    stats: Pick<RunRecorder, 'setCacheKey' | 'setBuildMs' | 'setPlacement' | 'deviceSlotWaitMs'>;
    step: (phase: BuildPhase) => void;
    miss: (reason: BuildMissReason, provisional?: boolean) => void;
    hit: () => void;
    place: (remote: { host: string; phase: string } | null) => void;
    waitingOn: (root: string | null) => void;
    waitingFor?: BuildProgress['waitingFor'];
  };
}

interface AndroidArtifactDeps {
  acquireLock: typeof acquireBuildLock;
  releaseLock: typeof releaseBuildLock;
  waitForBuild: typeof waitForOtherBuild;
  easAuth: typeof checkEasAuth;
  resolveRemoteBuild: typeof resolveRemote;
  uploadRemoteBuild: typeof uploadRemote;
  loadCacheProviderModule: typeof loadCacheProvider;
  storedAppId: typeof storedAppId;
  acquireSlot: typeof acquireBuildSlot;
  releaseSlot: typeof releaseBuildSlot;
  now: () => number;
}

/** The installable APK plus the cache work this run still owes the caller. */
export interface PreparedAndroidArtifact {
  apkPath: string | null;
  handoff?: BuildHandoff | null;
  androidPackage: string | null;
  /** The package read from the APK when its cache entry was stored, for an APK that entry provided. */
  apkPackage: string | null;
  /** The background check of a memoized fingerprint this artifact was looked up with. */
  fingerprintCheck: FingerprintCheck | null;
  /** Waits for cache uploads that read temporary copies before removing them; repeated calls are safe. */
  release(): void | Promise<void>;
  waitedForBuild: WaitedForBuild | null;
  ccache: CcacheActivity;
  uploadPending: Promise<RemoteUploadLike> | null;
  providerUpload: Promise<ProviderCallResult<void>> | null;
  providerName: string | null;
  remote: LoadProjectProviderResult | null;
  abandonedRemote: boolean;
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
    context,
    root,
    buildLog,
    writer,
    recipe,
    targetOffloadRefusal,
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
    acquireLock,
    releaseLock,
    waitForBuild,
    easAuth,
    resolveRemoteBuild,
    uploadRemoteBuild,
    loadCacheProviderModule,
    storedAppId: entryAppId,
    acquireSlot,
    releaseSlot,
    now,
  }: AndroidArtifactDeps,
): Promise<AndroidArtifactResult> {
  const { phase, out, stats, step, miss, hit: lateHit, place, waitingOn, waitingFor } = progress;
  let fallbackMachine: string | null = null;
  let hereReason = 'no remote machine is paired';
  let slotWaitMs: number | undefined;
  const buildMachine = record.buildMachine ?? 'auto';
  const fallBack = (
    reason: string,
    line: string = reason,
    info: { code?: string; machine?: string; candidates?: PlacementCandidate[]; remedy?: string } = {},
  ) => {
    writer.write(
      buildPlacementRecord({
        platform: PLATFORM,
        buildMachine,
        candidates: info.candidates,
        event: 'placement_fallback',
        fallback: { code: info.code ?? 'fallback', reason, machine: info.machine },
      }),
    );
    if (namedBuildMachine(buildMachine)) throw new OffloadRefusal(buildMachine, reason, info.remedy);
    requireLocalBuild(buildMachine, reason);
    record.offloadFallback = reason;
    phase('build', `${line} -> building here`);
  };
  const { variant, cache: cachePolicy } = buildPlan;
  const signal = runCancellationSignal(context) ?? context.signal;
  const cacheTarget = (key: string) => ({ projectRoot: root, platform: 'android' as const, key, signal });
  let useBuildCache = cachePolicy.read;
  let cacheIneligible: string | null = null;
  let androidPackage = initialPackage;
  let ccacheActivity: CcacheActivity = CCACHE_NOT_RUN;
  let phaseFailure: AndroidArtifactFailure | null = null;
  let run!: ArtifactRun;

  let hash = '';
  let providerUpload: Promise<ProviderCallResult<void>> | null = null;
  let providerName: string | null = null;
  let providerLoad: Promise<LoadCacheProviderResult> | null = null;
  const cacheWarn = createWarnOnce((line) => phase('cache', chalk.yellow(line)));
  const loadTieredProvider =
    cachePolicy.remote && cacheProviderConfig
      ? () =>
          (providerLoad ??= loadCacheProviderModule({
            projectRoot: root,
            config: cacheProviderConfig,
            env: context.env,
            timeoutMs: timeoutFromEnv(PROVIDER_LOAD_TIMEOUT_ENV, PROVIDER_LOAD_TIMEOUT_MS, context.env),
          }).then((loaded) => {
            if (!loaded.provider || !recipe.providerCache) return loaded;
            const builds = recipe.providerCache(loaded.provider);
            return { ...loaded, provider: builds ? { builds } : {} };
          }))
      : null;
  let cacheKey = '';
  let storeHash = '';
  let storeKey = '';
  let apkPath: string | null = null;
  let handoff: BuildHandoff | null = null;
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
    if (useBuildCache) step('cache-lookup');
    const fingerprintTimer = stepTimer(now);
    let computed;
    try {
      computed = await recipe.identity();
    } catch (error) {
      record.cacheSkipped = !useBuildCache;
      if (error instanceof ArtifactRefusal && error.missReason) record.missReason = error.missReason;
      throw error;
    }
    if ('cacheIneligible' in computed) {
      cacheIneligible = computed.cacheIneligible;
      useBuildCache = false;
      record.fingerprint = null;
      record.cacheKey = null;
      record.cacheHit = false;
      record.cacheSkipped = true;
      phase('fingerprint', `unavailable: ${cacheIneligible}`);
      return true;
    }
    hash = computed.hash;
    record.fingerprint = hash;
    cacheKey = computed.key;
    stats.setCacheKey(cacheKey);
    record.cacheKey = cacheKey;
    storeHash = hash;
    storeKey = cacheKey;

    const found = await withDrainingCancellation(context, signal, () =>
      resolveTieredBuild({
        timeoutMs: buildResolveTimeoutMs(context.env),
        local: recipe.cache(),
        loadProvider: loadTieredProvider,
        target: { projectRoot: root, platform: PLATFORM, key: cacheKey },
        destinationDir: providerDownloadPath(workspaceDir(root)),
        ensureDestination: (dir) => prepareProviderDownloadDir(dir, root),
        skipRead: !useBuildCache,
        warn: cacheWarn,
        signal,
      }),
    );
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

  let remote: LoadProjectProviderResult | null = null;
  let abandonedRemote = false;
  let uploadPending: Promise<RemoteUploadLike> | null = null;

  async function resolveRemoteArtifact(): Promise<void> {
    if (cacheIneligible || !recipe.expoCache) return;

    if (!apkPath) {
      const loaded: LoadProjectProviderResult = await recipe.expoCache.load();
      if (loaded?.unavailable) {
        phase('cache', chalk.yellow(`provider not usable: ${loaded.unavailable}`));
      } else if (loaded?.provider) {
        remote = loaded;
      }
      if (remote?.name === 'eas') {
        const auth = await easAuth({ context, projectRoot: root, owner: loaded?.owner || null });
        const authNote = easAuthNote(auth as Parameters<typeof easAuthNote>[0]);
        if (authNote) phase('cache', chalk.yellow(authNote));
        if (auth?.code === 'logged-out') remote = null;
      }
    }

    if (remote && useBuildCache) {
      const remoteTimer = stepTimer(now);
      const hit = await resolveRemoteBuild({
        context,
        logWriter: writer,
        provider: remote.provider,
        platform: PLATFORM,
        projectRoot: root,
        fingerprintHash: hash,
        runOptions: recipe.expoCache?.runOptions ?? null,
      });
      if (hit?.appPath) {
        let stored = null;
        try {
          stored =
            (await recipe.cache().store({ ...cacheTarget(cacheKey), sourcePath: hit.appPath, overwrite: false })) ??
            null;
        } catch (err) {
          throwIfCancelled(signal, 'build cache backfill');
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

  let waitedForBuild: WaitedForBuild | null = null;
  let releasedWait: { facts: WaitedForBuild; who: string } | null = null;
  async function awaitSharedBuild(): Promise<string | null> {
    if (!useBuildCache) return null;
    const shared = await run.claimSharedBuild({
      key: cacheKey,
      fingerprint: hash,
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
      throw new ArtifactRefusal(phaseFailure);
    }
    releasedWait = shared.released;
    if (shared.hit) {
      apkPath = shared.hit.path;
      record.cacheHit = 'local';
      waitedForBuild = shared.hit.waited;
    }
    return apkPath;
  }

  const installableCachedApk = async (key: string, cachedPath: string): Promise<string | null> => {
    const prepared = await recipe.materialize(key, cachedPath);
    if (!prepared) {
      swapFellBack = true;
      return null;
    }
    if (prepared.directory) run.own(prepared.directory);
    if (prepared.androidPackage) {
      androidPackage = prepared.androidPackage;
      record.bundleId = androidPackage;
    }
    return prepared.apkPath;
  };

  async function prepareCachedArtifact(cachedPath: string): Promise<string | null> {
    const prepared = await installableCachedApk(cacheKey, cachedPath);
    if (!prepared) {
      record.cacheHit = false;
      waitedForBuild = null;
    }
    return prepared;
  }

  function reasonForMiss(rekeyedBy: string[]): { reason: BuildMissReason; diff: Record<string, unknown> | null } {
    if (swapFellBack) {
      return {
        reason: skippedMissReason('the cached APK could not be reused, so this run built it fresh'),
        diff: null,
      };
    }
    if (cacheIneligible) return { reason: skippedMissReason(cacheIneligible), diff: null };
    if (!useBuildCache) {
      return {
        reason: skippedMissReason(
          requestedBuildCache ? 'cache reuse off in config' : 'cache reuse turned off by --no-build-cache',
        ),
        diff: null,
      };
    }
    return recipe.explain(rekeyedBy);
  }

  function explainMiss(rekeyedBy: string[]): void {
    const explained = reasonForMiss(rekeyedBy);
    record.missReason = explained.reason;
    if (explained.diff) writer.write(explained.diff);
    miss(record.missReason);
    phase('cache', `miss: ${record.missReason.summary}`);
    if (record.missReason.kind === 'no-baseline') {
      const line = recipe.untrackedLine();
      if (line) phase('fingerprint', chalk.dim(line));
    }
  }

  async function takeBuildSlot(): Promise<boolean> {
    requireLocalBuild(buildMachine);
    if (!maxBuilds) return true;
    try {
      const buildSlot = await run.takeBuildSlot({
        signal,
        automatic: automaticBuild(buildMachine),
        max: maxBuilds,
        out,
        waitingFor: (info) => waitingFor?.(info, 'build-slot'),
      });
      slotWaitMs = buildSlot.slotWaitMs;
    } catch (err) {
      throwIfCancelled(signal, 'Android build');
      requireLocalBuild(buildMachine);
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
    cacheOnly: boolean;
    here: MachineCapacity;
    code: string;
    reason: string;
    machines: ReturnType<typeof pairedMachines>;
  }

  async function placeBuild(): Promise<Candidate | null> {
    if (cacheIneligible && !recipe.offload?.supportsUncachedArtifacts) {
      if (namedBuildMachine(buildMachine)) throw new OffloadRefusal(buildMachine, cacheIneligible);
      hereReason = cacheIneligible;
      return null;
    }
    const { machines, localEnabled } = buildPlacementCandidates(buildMachine);
    if (localEnabled && machines.length === 0 && !namedBuildMachine(buildMachine) && buildMachine !== 'local')
      return null;
    const unsupported =
      targetOffloadRefusal ??
      (recipe.offload ? recipe.offload.unsupported : 'this project integration does not support offloaded builds');
    const here = machineCapacity();
    const placement = offloadPlacement({
      localEnabled,
      machines: machines.length,
      here,
      unsupported,
      selected: buildMachine,
    });
    if (!placement.offload) {
      hereReason = placement.reason;
      if (
        placement.code === 'this-mac-free' &&
        cachePolicy.read &&
        cachePolicy.remote &&
        (recipe.offload?.uncachedArtifacts || (recipe.offload && !recipe.offload.request.native))
      )
        return { cacheOnly: true, here, code: placement.code, reason: placement.reason, machines };
      writer.write(
        buildPlacementRecord({
          platform: PLATFORM,
          buildMachine,
          stays: { code: placement.code, reason: placement.reason },
        }),
      );
      if (buildMachine !== 'local') phase('build', `placement: here (${placement.reason})`);
      return null;
    }
    const named = machines.find((each) => each.machine === buildMachine);
    const offload = recipe.offload;
    if (placement.code === 'named' && named && offload) {
      const check = await offloadCheck(root, async () => [await offload.target()])(named).catch((error: unknown) => {
        throwIfCancelled(signal, 'Android build');
        fallBack(error instanceof Error ? error.message : String(error));
        return null;
      });
      if (!check) return null;
      const predicted = predictedRefusal(buildMachine, check.problems);
      if (predicted)
        fallBack(predicted.reason, predicted.reason, {
          machine: buildMachine,
          remedy: predicted.remedy,
        });
    }
    return { cacheOnly: false, here, code: placement.code, reason: placement.reason, machines };
  }

  /** Asks the paired machines once the post-mutation key is known; null builds here. */
  async function chooseMachine(candidate: Candidate): Promise<OffloadChoice | null> {
    const offload = recipe.offload!;
    let asked: PlacementCandidate[] = [];
    let target: Awaited<ReturnType<NonNullable<AndroidArtifactRecipe['offload']>['target']>>;
    try {
      target = await offload.target();
    } catch (error) {
      if (candidate.cacheOnly) return null;
      fallBack((error as Error).message);
      return null;
    }
    const request = offload.request;
    const choice = await chooseBuildMachine({
      projectRoot: root,
      target,
      here: candidate.here,
      note: (line) => phase('build', chalk.dim(`offload: ${line}`)),
      machines: candidate.machines,
      selected: buildMachine,
      onCandidates: (each) => (asked = each),
      cacheOnly: candidate.cacheOnly,
      ...(cachePolicy.read && cachePolicy.remote && storeHash && !request.native
        ? { reactNativeArtifact: { fingerprint: storeHash, request } }
        : {}),
      ...(cachePolicy.read && cachePolicy.remote && request.native?.provider === 'gradle' && request.android.variant
        ? {
            gradleArtifact: {
              sourceDigest: request.native.transfer.digest,
              inputs: request.native.transfer.declaration,
              android: { ...request.android, variant: request.android.variant },
            },
          }
        : {}),
    });
    if (typeof choice === 'string') {
      if (candidate.cacheOnly) return null;
      const only = candidate.machines.length === 1 ? candidate.machines[0]!.machine : null;
      if (only && choice.startsWith(`${only}: `)) fallbackMachine = only;
      fallBack(choice, choice, { code: 'no-remote-mac-took-it', candidates: asked });
      return null;
    }
    run.openOffload(() => closeOffload(choice));
    writer.write(
      buildPlacementRecord({
        platform: PLATFORM,
        buildMachine,
        candidates: asked,
        chose: { machine: choice.machine, reason: `${candidate.reason}${placementLoad(choice)}` },
      }),
    );
    phase('build', `placement: ${choice.machine} (${candidate.reason}${placementLoad(choice)})`);
    return choice;
  }

  /** Builds on the chosen machine and stores the APK under the post-mutation key; false builds here instead unless a machine was named. */
  async function compileElsewhere(choice: OffloadChoice, candidate: Candidate): Promise<boolean> {
    const uncached = Boolean(
      recipe.offload?.uncachedArtifacts || (cacheIneligible && recipe.offload?.supportsUncachedArtifacts),
    );
    if ((!storeKey || !storeHash) && !uncached) {
      const reason = 'the build fingerprint or cache key is unavailable';
      if (namedBuildMachine(buildMachine)) fallBack(reason, reason, { machine: choice.machine });
      else
        writer.write(
          buildPlacementRecord({
            platform: PLATFORM,
            buildMachine,
            event: 'placement_fallback',
            fallback: { code: 'fallback', reason, machine: choice.machine },
          }),
        );
      return false;
    }
    const stagingDir = join(workspaceDir(root), 'offload', PLATFORM);
    const disownStaging = uncached ? run.own(stagingDir) : null;
    const outcome = await offloadBuild({
      choice,
      expectedFingerprint: uncached ? null : storeHash,
      request: recipe.offload!.request,
      fingerprintInputs: recipe.offload!.fingerprintInputs,
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
      let unchanged = false;
      try {
        unchanged = await recipe.offload!.unchanged();
      } catch (error) {
        reason = (error as Error).message;
      }
      if (!unchanged) {
        reason ??= 'the checkout here changed while it built';
      } else if (uncached) {
        if (!outcome.androidPackage) reason = 'the worker returned no verified APK package';
        else {
          stored = outcome.artifactPath;
          androidPackage = outcome.androidPackage;
        }
      } else {
        try {
          stored =
            (await recipe
              .cache()
              .store({ ...cacheTarget(storeKey!), sourcePath: outcome.artifactPath, overwrite: !useBuildCache })) ??
            null;
        } catch (err) {
          reason = `could not store the APK: ${(err as Error)?.message || err}`;
        }
      }
    }
    if (!uncached || !stored) {
      disownStaging?.();
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
    throwIfCancelled(signal, 'offloaded build cache copy');
    step('compile');
    if (!outcome.ok || !stored) {
      if (candidate.cacheOnly) return false;
      const why = reason ?? 'the APK was not stored';
      fallbackMachine = choice.machine;
      fallBack(`${choice.machine}: ${why}`, `offload failed: ${why}`, {
        code: 'offload-failed',
        machine: choice.machine,
        remedy: outcome.ok
          ? undefined
          : (fingerprintMismatchRemedy(outcome.reason) ?? missingPackageManagerRemedy(choice.machine, outcome.reason)),
      });
      writer.write({ src: 'build', level: 'warn', event: 'offload_failed', msg: reason, machine: choice.machine });
      return false;
    }
    const { timings } = outcome;
    if (uncached) {
      record.fingerprint = null;
      record.cacheKey = null;
      record.cacheHit = outcome.cacheHit ? 'remote' : false;
      record.cacheSkipped = !outcome.cacheHit;
    }
    if (outcome.cacheHit) lateHit();
    apkPath = stored;
    handoff = outcome.handoff ?? null;
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
      `${outcome.cacheHit ? 'reused from' : 'built on'} ${outcome.machine} in ${formatDuration(timings.totalMs)}: offer ${formatDuration(timings.offerMs)}, ` +
        `sync ${formatDuration(timings.syncMs)}, build ${formatDuration(timings.workerMs)}, fetch ${formatDuration(timings.fetchMs)}`,
    );
    phase('cache', `compilation cache on ${outcome.machine} ${ccacheActivityLine(ccacheActivity)}`);
    writer.write({
      src: 'build',
      level: 'info',
      event: 'offload_done',
      msg: `${outcome.cacheHit ? 'reused from' : 'built on'} ${outcome.machine}`,
      timings,
    });
    return true;
  }

  async function prepareSource(): Promise<AndroidSourcePreparation> {
    await recipe.prepare(() => miss(reasonForMiss([]).reason, true));
    return recipe.reconcile();
  }

  async function revalidateSource(preparation: AndroidSourcePreparation): Promise<ReadyArtifact<string> | null> {
    const { identity, rekeyedBy } = preparation;
    if (preparation.androidPackage) {
      androidPackage = preparation.androidPackage;
      record.bundleId = androidPackage;
    }
    if (cacheIneligible || !identity) {
      storeHash = '';
      storeKey = '';
      record.fingerprint = null;
      record.cacheKey = null;
      return null;
    }
    if (identity.key !== storeKey) {
      storeHash = identity.hash;
      storeKey = identity.key;
      record.fingerprint = storeHash;
      record.cacheKey = storeKey;
      const late = useBuildCache
        ? await recipe
            .cache()
            .resolve({ ...cacheTarget(storeKey), destinationDir: providerDownloadPath(workspaceDir(root)) })
        : null;
      if (late) {
        const prepared = await installableCachedApk(storeKey, late);
        if (prepared) {
          apkPath = prepared;
          record.cacheHit = 'local';
          lateHit();
          phase('cache', `hit ${shortHash(storeHash)} (post-${rekeyedBy.join('/')} key)`);
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
    return apkPath ? { ready: apkPath } : null;
  }

  async function acquireRemoteArtifact(
    offload: Candidate,
    { rekeyedBy, cacheRefusal }: AndroidSourcePreparation,
  ): Promise<ReadyArtifact<string> | null> {
    explainMiss(rekeyedBy);
    step('compile');
    if (cacheRefusal) {
      fallBack(cacheRefusal, `offload failed: ${cacheRefusal}`);
    } else {
      const choice = await chooseMachine(offload);
      if (choice) await compileElsewhere(choice, offload);
    }
    return apkPath ? { ready: apkPath } : null;
  }

  async function compileHere(offload: Candidate | null, { rekeyedBy }: AndroidSourcePreparation): Promise<string> {
    if (!offload) {
      explainMiss(rekeyedBy);
      step('compile');
    }
    if (offload && !offload.cacheOnly) {
      stats.setPlacement({
        decision: 'fell-back',
        slotWaitMs,
        deviceSlotWaitMs: stats.deviceSlotWaitMs(),
        reason: record.offloadFallback ?? 'offload failed',
        ...(fallbackMachine ? { machine: fallbackMachine } : {}),
      });
    } else {
      stats.setPlacement({
        decision: 'here',
        reason: hereReason,
        slotWaitMs,
        deviceSlotWaitMs: stats.deviceSlotWaitMs(),
      });
    }
    requireLocalBuild(buildMachine);
    record.builtOn = 'here';
    phase('build', `compiling ${variant || 'debug'} with Gradle`);
    const built = await recipe.compile();
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
      phaseFailure = fail(built.code, built.reason, diagnostics.find((d) => d.remedy)?.remedy || built.remedy || null, {
        lastBuildStatus: true,
        diagnostics: extracted,
        buildDiagnostics: diagnostics,
        lines: extracted.length ? [] : tail(built.lastLines),
        logPath: displayPath(root, retainFailedTranscript(buildLog)),
      });
      throw new ArtifactRefusal(phaseFailure);
    }
    apkPath = built.apkPath;
    if (built.androidPackage) {
      androidPackage = built.androidPackage;
      record.bundleId = androidPackage;
    }
    stats.setBuildMs(built.durationMs);
    phase('build', `ok (${formatDuration(built.durationMs)})`);
    if (built.apkNote) phase('build', chalk.yellow(built.apkNote));

    return apkPath!;
  }

  async function validateCompiled(): Promise<'cacheable' | 'uncacheable'> {
    if (cacheIneligible) return 'uncacheable';
    const identity = await recipe.validate();
    if (!identity) {
      record.fingerprint = null;
      record.cacheKey = null;
      return 'uncacheable';
    }
    storeHash = identity.hash;
    storeKey = identity.key;
    record.fingerprint = storeHash;
    record.cacheKey = storeKey;
    return 'cacheable';
  }

  async function storeArtifact(artifactPath: string): Promise<void> {
    if (cachePolicy.write) {
      const local = recipe.cache(true);
      try {
        const stored = await withDrainingCancellation(context, signal, () =>
          storeTieredBuild({
            timeoutMs: buildUploadTimeoutMs(context.env),
            local,
            loadProvider: loadTieredProvider,
            target: { projectRoot: root, platform: PLATFORM, key: storeKey },
            sourcePath: artifactPath,
            overwrite: !useBuildCache || swapFellBack,
            warn: cacheWarn,
            signal,
          }),
        );
        const pending = stored.providerUpload;
        providerUpload = pending ? withDrainingCancellation(context, signal, () => pending) : null;
        void providerUpload?.catch(() => {});
        providerName = stored.providerName ?? providerName;
      } catch (err) {
        throwIfCancelled(signal, 'build cache storage');
        phase('cache', chalk.yellow(`could not store the build: ${(err as Error)?.message || err}`));
      }
    }

    if (remote) {
      uploadPending = uploadRemoteBuild({
        context,
        logWriter: writer,
        provider: remote.provider,
        platform: PLATFORM,
        projectRoot: root,
        fingerprintHash: storeHash,
        buildPath: artifactPath,
        runOptions: recipe.expoCache?.runOptions ?? null,
      });
      void uploadPending.catch(() => {});
    }
  }

  const acquired = await acquireArtifact<string, AndroidSourcePreparation, Candidate, AndroidArtifactFailure>(
    {
      platform: PLATFORM,
      command: 'stim android',
      lifecycle: (driver) => {
        run = driver;
        return {
          resolve: async () => {
            if (!(await resolveInitialFingerprint())) throw new ArtifactRefusal(phaseFailure!);
            if (easBuild) return { kind: 'ready', artifact: apkPath! };
            await resolveRemoteArtifact();
            if (apkPath) return { kind: 'cached', artifact: apkPath };
            miss(reasonForMiss([]).reason);
            return { kind: 'miss' };
          },
          claim: useBuildCache ? awaitSharedBuild : undefined,
          reuse: async (cached) => {
            apkPath = await prepareCachedArtifact(cached);
            if (apkPath) lateHit();
            else if (swapFellBack) miss(reasonForMiss([]).reason);
            return apkPath;
          },
          build: {
            placement: { select: placeBuild, acquire: acquireRemoteArtifact },
            admit: async () => {
              if (!(await takeBuildSlot())) throw new ArtifactRefusal(phaseFailure!);
            },
            prepare: prepareSource,
            revalidate: revalidateSource,
            compile: compileHere,
            validate: validateCompiled,
            store: storeArtifact,
          },
        };
      },
      settleFailed: async () => {
        await settleArtifactUploads(uploadPending, providerUpload);
      },
      refuse: (error) => {
        if (error instanceof OffloadRefusal) {
          const { code, message, remedy } = error;
          return fail(code, message, remedy, { lastBuildStatus: true });
        }
        if (error instanceof ArtifactRefusal) return error.failure;
        const cancelled = cancelledFailure(context, PLATFORM, {
          code: 'STIM_CANCELLED',
          message: 'during app preparation',
        });
        return cancelled ? fail(cancelled.code, cancelled.message, cancelled.remedy, { lastBuildStatus: true }) : null;
      },
      releaseFailed: (subject, err) =>
        out(phaseLine('build', chalk.dim(`could not release ${subject}: ${(err as Error)?.message || err}`))),
      temporaryReleaseFailed: (error) =>
        out(phaseLine('cleanup', chalk.yellow(`could not remove the temporary APK: ${(error as Error).message}`))),
    },
    {
      root,
      logFile: buildLog,
      deps: {
        acquireBuildLock: acquireLock,
        releaseBuildLock: releaseLock,
        waitForBuild,
        acquireBuildSlot: acquireSlot,
        releaseBuildSlot: releaseSlot,
        now,
      },
    },
  );
  if (!acquired.ok) {
    recipe.fingerprintCheck?.()?.cancel();
    return { ok: false, failure: acquired.failure, ccache: ccacheActivity };
  }

  return {
    ok: true,
    artifact: {
      apkPath: acquired.artifact,
      handoff,
      androidPackage,
      apkPackage: record.cacheHit && storeKey ? entryAppId(PLATFORM, storeKey) : null,
      fingerprintCheck: recipe.fingerprintCheck?.() ?? null,
      release: async () => {
        recipe.fingerprintCheck?.()?.cancel();
        await settleArtifactUploads(providerUpload, uploadPending);
        acquired.release();
      },
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

export async function acquireAndroidArtifactOrRecorded(
  recorded: RecordedBuild | null,
  request: AndroidArtifactRequest,
  deps: AndroidArtifactDeps,
): Promise<AndroidArtifactResult> {
  return recorded ? recordedAndroidArtifact(recorded) : acquireAndroidArtifact(request, deps);
}

function recordedAndroidArtifact(recorded: RecordedBuild): { ok: true; artifact: PreparedAndroidArtifact } {
  return {
    ok: true,
    artifact: {
      apkPath: recorded.appPath,
      androidPackage: recorded.bundleId,
      apkPackage: recorded.bundleId,
      fingerprintCheck: null,
      release: () => {},
      waitedForBuild: null,
      ccache: CCACHE_NOT_RUN,
      uploadPending: null,
      providerUpload: null,
      providerName: null,
      remote: null,
      abandonedRemote: false,
    },
  };
}
