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
import { prepareProviderDownloadDir, providerDownloadPath } from '../../cache/build-cache.ts';
import { skippedMissReason } from '../../cache/miss-reason.ts';
import { formatDuration, phaseLine, shortHash, stepTimer } from '../../command-output.ts';
import {
  waitForSharedBuild,
  type acquireBuildLock,
  type releaseBuildLock,
  type waitForBuild as waitForOtherBuild,
  type BuildLockHandle,
} from '../../engine/build-lock.ts';
import type { acquireBuildSlot, releaseBuildSlot, BuildSlotHandle } from '../../engine/build-slots.ts';
import { runArtifactLifecycle, type ReadyArtifact } from '../../engine/artifact-lifecycle.ts';
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
  type BuildHandoff,
} from '../../offload/client.ts';
import { namedBuildMachine, OffloadRefusal } from '../../offload/selection.ts';
import { workspaceDir } from '../../workspace/paths.ts';
import type { CcacheActivity, WaitedForBuild } from '../../engine/build-facts.ts';
import type { AndroidRunPlan } from './plan.ts';
import { displayPath, PLATFORM } from './support.ts';
import type { AndroidRecord, AndroidWriter, FailExtra, RemoteUploadLike } from './types.ts';

import {
  AndroidRecipeRefusal as ArtifactRefusal,
  type AndroidArtifactFailure,
  type AndroidArtifactRecipe,
  type AndroidSourcePreparation,
} from '../../integrations/android-project.ts';
import { runCancellationSignal } from '../../engine/native-run.ts';

const FALLBACK_LINES = 5;

interface AndroidArtifactRequest {
  root: string;
  buildLog: string;
  writer: AndroidWriter;
  recipe: AndroidArtifactRecipe;
  targetOffloadRefusal: string | null;
  buildPlan: Pick<AndroidRunPlan['build'], 'variant' | 'cache'>;
  cacheProviderConfig: AndroidRunPlan['cacheProviderConfig'];
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
  acquireSlot: typeof acquireBuildSlot;
  releaseSlot: typeof releaseBuildSlot;
  now: () => number;
}

/** The installable APK plus the cache work this run still owes the caller. */
export interface PreparedAndroidArtifact {
  apkPath: string | null;
  handoff?: BuildHandoff | null;
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
    acquireSlot,
    releaseSlot,
    now,
  }: AndroidArtifactDeps,
): Promise<AndroidArtifactResult> {
  const { phase, out, stats, step, miss, hit: lateHit, place, waitingOn, waitingFor } = progress;
  let fallbackMachine: string | null = null;
  let hereReason = 'no remote Mac is paired';
  let slotWaitMs: number | undefined;
  const buildMachine = record.buildMachine ?? 'auto';
  const fallBack = (reason: string, line: string = reason) => {
    if (namedBuildMachine(buildMachine)) throw new OffloadRefusal(buildMachine, reason);
    record.offloadFallback = reason;
    phase('build', `${line} -> building here`);
  };
  const { variant, cache: cachePolicy } = buildPlan;
  const signal = runCancellationSignal() ?? new AbortController().signal;
  const cacheTarget = (key: string) => ({ projectRoot: root, platform: 'android' as const, key, signal });
  const useBuildCache = cachePolicy.read;
  let androidPackage = initialPackage;
  let ccacheActivity: CcacheActivity = CCACHE_NOT_RUN;
  let phaseFailure: AndroidArtifactFailure | null = null;

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

  let hash = '';
  let providerUpload: Promise<ProviderCallResult<void>> | null = null;
  let providerName: string | null = null;
  let providerLoad: Promise<LoadCacheProviderResult> | null = null;
  const cacheWarn = createWarnOnce((line) => phase('cache', chalk.yellow(line)));
  const loadTieredProvider =
    cachePolicy.remote && cacheProviderConfig
      ? () => (providerLoad ??= loadCacheProviderModule({ projectRoot: root, config: cacheProviderConfig }))
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
    hash = computed.hash;
    record.fingerprint = hash;
    cacheKey = computed.key;
    stats.setCacheKey(cacheKey);
    record.cacheKey = cacheKey;
    storeHash = hash;
    storeKey = cacheKey;

    const found = await resolveTieredBuild({
      local: recipe.cache(),
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

  let remote: LoadProjectProviderResult | null = null;
  let abandonedRemote = false;
  let uploadPending: Promise<RemoteUploadLike> | null = null;

  async function resolveRemoteArtifact(): Promise<void> {
    if (!recipe.legacyCache) return;

    if (!apkPath) {
      const loaded: LoadProjectProviderResult = await recipe.legacyCache.load();
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
        runOptions: recipe.legacyCache?.runOptions ?? null,
      });
      if (hit?.appPath) {
        let stored = null;
        try {
          stored =
            (await recipe.cache().store({ ...cacheTarget(cacheKey), sourcePath: hit.appPath, overwrite: false })) ??
            null;
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

  let waitedForBuild: WaitedForBuild | null = null;
  let releasedWait: { facts: WaitedForBuild; who: string } | null = null;
  async function awaitSharedBuild(): Promise<string | null> {
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
      throw new ArtifactRefusal(phaseFailure);
    }
    buildLock = shared.lock;
    releasedWait = shared.released;
    if (shared.hit) {
      apkPath = shared.hit.path;
      record.cacheHit = 'local';
      waitedForBuild = shared.hit.waited;
    }
    return apkPath;
  }

  let swapDir: string | null = null;
  const installableCachedApk = async (key: string, cachedPath: string): Promise<string | null> => {
    const prepared = await recipe.materialize(key, cachedPath);
    if (!prepared) {
      swapFellBack = true;
      return null;
    }
    swapDir = prepared.directory;
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
    if (!maxBuilds) return true;
    try {
      buildSlot = await acquireSlot({
        max: maxBuilds,
        root,
        logFile: buildLog,
        out,
        waitingFor: (info) => waitingFor?.(info, 'build-slot'),
      });
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
    const unsupported =
      targetOffloadRefusal ??
      (recipe.offload ? recipe.offload.unsupported : 'this project integration does not support offloaded builds');
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
      target: recipe.offload!.target(),
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
      request: recipe.offload!.request,
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
      if (!(await recipe.offload!.unchanged())) {
        reason = 'the checkout here changed while it built';
      } else {
        try {
          stored =
            (await recipe
              .cache()
              .store({ ...cacheTarget(storeKey), sourcePath: outcome.artifactPath, overwrite: !useBuildCache })) ??
            null;
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
      `built on ${outcome.machine} in ${formatDuration(timings.totalMs)}: offer ${formatDuration(timings.offerMs)}, ` +
        `sync ${formatDuration(timings.syncMs)}, build ${formatDuration(timings.workerMs)}, fetch ${formatDuration(timings.fetchMs)}`,
    );
    phase('cache', `compilation cache on ${outcome.machine} ${ccacheActivityLine(ccacheActivity)}`);
    writer.write({ src: 'build', level: 'info', event: 'offload_done', msg: `built on ${outcome.machine}`, timings });
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
    if (offload) {
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
        logPath: displayPath(root, buildLog),
      });
      throw new ArtifactRefusal(phaseFailure);
    }
    apkPath = built.apkPath;
    stats.setBuildMs(built.durationMs);
    phase('build', `ok (${formatDuration(built.durationMs)})`);
    if (built.apkNote) phase('build', chalk.yellow(built.apkNote));

    return apkPath!;
  }

  async function validateCompiled(): Promise<'cacheable' | 'uncacheable'> {
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
        const stored = await storeTieredBuild({
          local,
          loadProvider: loadTieredProvider,
          target: { projectRoot: root, platform: PLATFORM, key: storeKey },
          sourcePath: artifactPath,
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
        buildPath: artifactPath,
        runOptions: recipe.legacyCache?.runOptions ?? null,
      });
    }
  }

  try {
    apkPath = await runArtifactLifecycle<string, AndroidSourcePreparation, Candidate>({
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
      release: () => {
        if (openOffload.choice) closeOffload(openOffload.choice);
        releaseHeldLock();
        releaseHeldSlot();
      },
    });
  } catch (error) {
    if (error instanceof OffloadRefusal) {
      const { code, message, remedy } = error;
      return { ok: false, failure: fail(code, message, remedy, { lastBuildStatus: true }), ccache: ccacheActivity };
    }
    if (error instanceof ArtifactRefusal) return { ok: false, failure: error.failure, ccache: ccacheActivity };
    throw error;
  }

  return {
    ok: true,
    artifact: {
      apkPath,
      handoff,
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
