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
import { prepareProviderDownloadDir, providerDownloadPath, providerUploadOutcome } from '../../cache/build-cache.ts';
import { skippedMissReason } from '../../cache/miss-reason.ts';
import { buildPlacementRecord, type PlacementCandidate } from '../../placement-log.ts';
import { formatDuration, phaseLine, shortHash, stepTimer } from '../../command-output.ts';
import { waitForSharedBuild, type BuildLockHandle } from '../../engine/build-lock.ts';
import { runArtifactLifecycle, type ReadyArtifact } from '../../engine/artifact-lifecycle.ts';
import type { BuildSlotHandle } from '../../engine/build-slots.ts';
import type { EasBuildResult } from '../../engine/eas-build.ts';
import {
  RESOLVE_TIMEOUT_MS,
  easAuthNote,
  isEasAuthFailureText,
  type LoadProjectProviderResult,
} from '../../engine/remote-cache.ts';
import type { RunRecorder } from '../../engine/stats.ts';
import type { BuildPhase, BuildProgress } from '../../engine/build-progress.ts';
import { COMPILATION_CACHE_NOT_RUN, compilationCacheActivityLine } from '../../engine/xcode.ts';
import type { NdjsonWriter } from '../../ndjson.ts';
import { artifactCachePolicy } from '../../optimizations.ts';
import { claimFailure } from '../../ownership-claim.ts';
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
import type { pairedMachines } from '../../offload/build-machines.ts';
import { namedBuildMachine, OffloadRefusal, requireLocalBuild } from '../../offload/selection.ts';
import { workspaceDir } from '../../workspace/paths.ts';
import type { CacheHitLevel, CompilationCacheActivity } from '../../engine/build-facts.ts';
import { machineCapacity, type BuildMissReason, type MachineCapacity, type OffloadMode } from '@stim-cli/core/state';
import type { IosDeps } from './dependencies.ts';
import { finishIosUpload } from './result.ts';
import { PLATFORM, printDiagnostics, xcodeFailureReport } from './support.ts';
import {
  IosRecipeRefusal as ArtifactRefusal,
  type IosArtifactRecipe,
  type IosSourcePreparation,
} from '../../integrations/ios-project.ts';
import { runCancellationSignal } from '../../engine/native-run.ts';
import type { BuildFailureFields, FailArgs, RemoteUploadLike, WaitedForBuild } from './types.ts';

const PROVIDER_SKIPPED_ON_DEVICE =
  'a device build is local-tier only: its cache key names the iphoneos slice, and a remote or provider entry is keyed for the simulator';

interface IosArtifactRequest {
  buildMachine?: string;
  root: string;
  logFile: string;
  recipe: IosArtifactRecipe;
  physical: boolean;
  configuration: string | null;
  cache: {
    policy: ReturnType<typeof artifactCachePolicy>;
    providerConfig: ReturnType<IosDeps['resolveCacheProviderConfig']>;
    disabledByFlag: boolean;
  };
  easBuild: Extract<EasBuildResult, { ok: true }> | null;
  maxBuilds: number | null | undefined;
  progress: {
    phase: (name: unknown, text: string) => void;
    note: (line: string) => void;
    logWriter: () => NdjsonWriter;
    stats: Pick<RunRecorder, 'setCacheKey' | 'setBuildMs' | 'setPodsMs' | 'setPlacement' | 'deviceSlotWaitMs'>;
    step: (phase: BuildPhase) => void;
    miss: (reason: BuildMissReason, provisional?: boolean) => void;
    hit: () => void;
    place: (remote: { host: string; phase: string } | null) => void;
    waitingOn: (root: string | null) => void;
    waitingFor?: BuildProgress['waitingFor'];
  };
}

type IosArtifactDeps = Pick<
  IosDeps,
  | 'loadCacheProvider'
  | 'checkEasAuth'
  | 'resolveRemote'
  | 'uploadRemote'
  | 'acquireBuildLock'
  | 'releaseBuildLock'
  | 'waitForBuild'
  | 'acquireBuildSlot'
  | 'releaseBuildSlot'
  | 'now'
>;

/** The caller owns this installable app's temporary copies until release(). */
export interface PreparedIosArtifact {
  handoff?: BuildHandoff | null;
  path: string;
  bundleId: string | null;
  cache: {
    identity: { fingerprint: string; key: string } | null;
    hit: CacheHitLevel;
    providerName: string | null;
    buildMachine: string;
    builtOn?: string;
    /** The remote Mac that compiled the app, when the build was offloaded. */
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

function fail(failure: FailArgs): never {
  throw new ArtifactRefusal(failure);
}

export async function acquireIosArtifact(
  {
    root,
    logFile,
    recipe,
    physical,
    configuration,
    buildMachine = 'auto',
    cache,
    easBuild,
    maxBuilds,
    progress,
  }: IosArtifactRequest,
  d: IosArtifactDeps,
): Promise<IosArtifactResult> {
  const { phase, note, logWriter, stats, step, miss, hit: lateHit, place, waitingOn, waitingFor } = progress;
  const cachePolicy = cache.policy;
  const signal = runCancellationSignal() ?? new AbortController().signal;
  const cacheTarget = (key: string) => ({ projectRoot: root, platform: 'ios' as const, key, signal });
  let useBuildCache = cachePolicy.read;
  let cacheIneligible: string | null = null;
  const cacheProviderConfig = cache.providerConfig;
  let compilationCache: CompilationCacheActivity = COMPILATION_CACHE_NOT_RUN;
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
  let cacheKey = '';
  let storeHash: string | null = null;
  let storeKey: string | null = null;
  let appPath: string | null = null;
  let bundleId: string | null = null;
  let cacheHit: CacheHitLevel = false;
  let offloadedTo: string | null = null;
  let handoff: BuildHandoff | null = null;
  let offloadFallback: string | null = null;
  let fallbackMachine: string | null = null;
  let hereReason = 'no remote Mac is paired';
  let slotWaitMs: number | undefined;
  let builtOn: string | undefined;
  const fallBack = (
    reason: string,
    line: string = reason,
    info: { code?: string; machine?: string; candidates?: PlacementCandidate[] } = {},
  ) => {
    logWriter().write(
      buildPlacementRecord({
        platform: PLATFORM,
        buildMachine,
        candidates: info.candidates,
        event: 'placement_fallback',
        fallback: { code: info.code ?? 'fallback', reason, machine: info.machine },
      }),
    );
    if (namedBuildMachine(buildMachine)) throw new OffloadRefusal(buildMachine, reason);
    requireLocalBuild(buildMachine);
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
      recipe.validateExternal(appPath);
      return;
    }
    if (useBuildCache) step('cache-lookup');
    const fingerprintTimer = stepTimer(d.now);
    const identity = await recipe.identity();
    if ('cacheIneligible' in identity) {
      cacheIneligible = identity.cacheIneligible;
      useBuildCache = false;
      phase('fingerprint', `unavailable: ${cacheIneligible}`);
      return;
    }
    fingerprint = identity.hash;
    cacheKey = identity.key;
    stats.setCacheKey(cacheKey);
    storeHash = fingerprint;
    storeKey = cacheKey;

    const found = await resolveTieredBuild({
      local: recipe.cache(),
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
    if (cacheIneligible || !recipe.legacyCache) return null;
    if (!appPath) {
      const loaded: LoadProjectProviderResult = await recipe.legacyCache.load();
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
        runOptions: recipe.legacyCache?.runOptions ?? null,
      });
      if (hit?.appPath) {
        let stored = null;
        try {
          stored =
            (await recipe.cache().store({ ...cacheTarget(cacheKey), sourcePath: hit.appPath, overwrite: false })) ??
            null;
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

  const installableCachedApp = async (path: string) => {
    const prepared = await recipe.materialize(path, {
      fresh: false,
      ownTemporary: (directory) => temporaryDirs.add(directory),
    });
    if (!prepared) swapFellBack = true;
    return prepared;
  };

  async function prepareCachedArtifact(cachedPath: string): Promise<string | null> {
    const prepared = await installableCachedApp(cachedPath);
    if (!prepared) {
      cacheHit = false;
      waitedForBuild = null;
    }
    return prepared;
  }

  function reasonForMiss(rekeyedBy: string[]): { reason: BuildMissReason; diff: Record<string, unknown> | null } {
    if (swapFellBack) {
      return {
        reason: skippedMissReason('the cached app could not be reused, so this run built it fresh'),
        diff: null,
      };
    }
    if (cacheIneligible) return { reason: skippedMissReason(cacheIneligible), diff: null };
    if (!useBuildCache) {
      return {
        reason: skippedMissReason(
          cache.disabledByFlag ? 'cache reuse turned off by --no-build-cache' : 'cache reuse off in config',
        ),
        diff: null,
      };
    }
    return recipe.explain(rekeyedBy);
  }

  function explainMiss(rekeyedBy: string[]): void {
    const explained = reasonForMiss(rekeyedBy);
    missReason = explained.reason;
    if (explained.diff) logWriter().write(explained.diff);
    buildFailure = { ...buildFailure, missReason };
    miss(missReason);
    phase('cache', `miss: ${missReason.summary}`);
    if (missReason.kind === 'no-baseline') {
      const untracked = recipe.untrackedLine();
      if (untracked) note(chalk.dim(phaseLine('fingerprint', untracked)));
    }
  }

  async function settleStoreKeyAfterCompile(): Promise<void> {
    if (!storeHash || !storeKey) return;
    const identity = await recipe.validate();
    storeHash = identity?.hash ?? null;
    storeKey = identity?.key ?? null;
    buildFailure = { ...buildFailure, fingerprint: storeHash, cacheKey: storeKey };
  }

  async function takeBuildSlot(): Promise<void> {
    requireLocalBuild(buildMachine);
    if (!maxBuilds) return;
    try {
      buildSlot = await d.acquireBuildSlot({
        automatic: buildMachine === 'auto',
        max: maxBuilds,
        root,
        logFile,
        out: note,
        waitingFor: (info) => waitingFor?.(info, 'build-slot'),
      });
      slotWaitMs = buildSlot.slotWaitMs;
    } catch (e) {
      requireLocalBuild(buildMachine);
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
    code: string;
    reason: string;
    runtime: string;
    machines: ReturnType<typeof pairedMachines>;
  }

  /** Whether this build should leave this Mac, before any machine is asked; null builds here. */
  function placeBuild(): Candidate | null {
    if (cacheIneligible) {
      if (namedBuildMachine(buildMachine)) throw new OffloadRefusal(buildMachine, cacheIneligible);
      hereReason = cacheIneligible;
      return null;
    }
    const { mode, machines, localEnabled } = buildPlacementCandidates(buildMachine);
    if (localEnabled && machines.length === 0 && !namedBuildMachine(buildMachine) && buildMachine !== 'local')
      return null;
    const { runtime, unsupported } = recipe.offload?.context() ?? {
      runtime: null,
      unsupported: 'this project integration does not support offloaded builds',
    };
    const here = machineCapacity();
    const placement = offloadPlacement({
      mode,
      localEnabled,
      machines: machines.length,
      here,
      unsupported,
      selected: buildMachine,
    });
    if (!placement.offload) {
      hereReason = placement.reason;
      logWriter().write(
        buildPlacementRecord({
          platform: PLATFORM,
          buildMachine,
          stays: { code: placement.code, reason: placement.reason },
        }),
      );
      if (mode !== 'off') phase('build', `placement: here (${placement.reason})`);
      return null;
    }
    return { mode, here, code: placement.code, reason: placement.reason, runtime: runtime!, machines };
  }

  /** Asks the paired machines once the post-mutation key is known; null builds here. */
  async function chooseMachine(candidate: Candidate): Promise<OffloadChoice | null> {
    let asked: PlacementCandidate[] = [];
    const choice = await chooseBuildMachine({
      projectRoot: root,
      target: recipe.offload!.target(candidate.runtime),
      mode: candidate.mode,
      here: candidate.here,
      note: (line) => note(chalk.dim(phaseLine('build', `offload: ${line}`))),
      machines: candidate.machines,
      selected: buildMachine,
      onCandidates: (each) => (asked = each),
    });
    if (typeof choice === 'string') {
      const only = candidate.machines.length === 1 ? candidate.machines[0]!.machine : null;
      if (only && choice.startsWith(`${only}: `)) fallbackMachine = only;
      fallBack(choice, choice, { code: 'no-remote-mac-took-it', candidates: asked });
      return null;
    }
    openOffload.choice = choice;
    logWriter().write(
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
      request: recipe.offload!.request(runtime),
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
      if (!(await recipe.offload!.unchanged())) {
        reason = 'the checkout here changed while it built';
      } else {
        try {
          stored =
            (await recipe
              .cache()
              .store({ ...cacheTarget(storeKey), sourcePath: outcome.artifactPath, overwrite: !useBuildCache })) ??
            null;
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
      fallBack(`${choice.machine}: ${why}`, `offload failed: ${why}`, {
        code: 'offload-failed',
        machine: choice.machine,
      });
      logWriter().write({ src: 'build', level: 'warn', event: 'offload_failed', msg: reason, machine: choice.machine });
      return false;
    }
    const { timings } = outcome;
    appPath = prepared;
    builtOn = outcome.machine;
    offloadedTo = outcome.machine;
    handoff = outcome.handoff ?? null;
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

  async function prepareSource(): Promise<IosSourcePreparation> {
    await recipe.prepare(() => miss(reasonForMiss([]).reason, true));
    return recipe.reconcile();
  }

  async function revalidateSource({
    identity,
    mutationLabel,
  }: IosSourcePreparation): Promise<ReadyArtifact<string> | null> {
    if (cacheIneligible || !identity) {
      storeHash = null;
      storeKey = null;
      buildFailure = { ...buildFailure, fingerprint: null, cacheKey: null };
    } else if (identity.key !== storeKey) {
      storeHash = identity.hash;
      storeKey = identity.key;
      buildFailure = { ...buildFailure, fingerprint: storeHash, cacheKey: storeKey };
      const late = useBuildCache
        ? await recipe
            .cache()
            .resolve({ ...cacheTarget(storeKey), destinationDir: providerDownloadPath(workspaceDir(root)) })
        : null;
      if (late) {
        const prepared = await installableCachedApp(late);
        if (prepared) {
          appPath = prepared;
          cacheHit = 'local';
          lateHit();
          phase('cache', `hit ${shortHash(storeHash)} (post-${mutationLabel} key)`);
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
    return appPath ? { ready: appPath } : null;
  }

  async function acquireRemoteArtifact(
    offload: Candidate,
    { rekeyedBy }: IosSourcePreparation,
  ): Promise<ReadyArtifact<string> | null> {
    explainMiss(rekeyedBy);
    step('compile');
    if (!storeKey)
      fallBack('no cache key to store the app under', 'offload failed: no cache key to store the app under');
    const choice = storeKey ? await chooseMachine(offload) : null;
    if (choice) await compileElsewhere({ choice, candidate: offload });
    return appPath ? { ready: appPath } : null;
  }

  async function compileHere(offload: Candidate | null, { rekeyedBy }: IosSourcePreparation): Promise<string> {
    if (!offload) explainMiss(rekeyedBy);
    step('compile');
    if (offload) {
      stats.setPlacement({
        decision: 'fell-back',
        slotWaitMs,
        deviceSlotWaitMs: stats.deviceSlotWaitMs(),
        reason: offloadFallback ?? 'offload failed',
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
    builtOn = 'here';
    buildFailure = { ...buildFailure, builtOn };
    phase('build', `compiling ${configuration || 'Debug'} with xcodebuild`);
    const result = await recipe.compile();
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

    return appPath;
  }

  async function storeArtifact(artifactPath: string): Promise<void> {
    if (storeKey && cachePolicy.write) {
      try {
        const stored = await storeTieredBuild({
          local: recipe.cache(),
          loadProvider,
          target: { projectRoot: root, platform: PLATFORM, key: storeKey },
          sourcePath: artifactPath,
          overwrite: !useBuildCache || swapFellBack,
          warn: cacheWarn,
        });
        providerUpload = stored.providerUpload;
        providerName = stored.providerName ?? providerName;
      } catch (e) {
        note(chalk.yellow(`Could not store the build in the shared cache: ${(e as Error)?.message || e}`));
      }
    }
  }

  async function finishArtifact(artifactPath: string): Promise<string> {
    let installPath = artifactPath;
    const prepared = await recipe.materialize(installPath, {
      fresh: true,
      ownTemporary: (directory) => temporaryDirs.add(directory),
    });
    if (!prepared)
      fail({
        code: 'STIM_INSTALL_FAILED',
        message: 'The project integration could not prepare the built app for installation.',
        remedy: 'Check the artifact preparation details above, then retry.',
        build: { ...buildFailure, appPath: installPath },
      });
    installPath = prepared;

    if (remote && !physical && storeHash) {
      uploadPending = d.uploadRemote({
        logWriter: logWriter(),
        provider: remote.provider,
        platform: PLATFORM,
        projectRoot: root,
        fingerprintHash: storeHash,
        buildPath: installPath,
        runOptions: recipe.legacyCache?.runOptions ?? null,
      });
    }

    return installPath;
  }

  let transferred = false;
  try {
    appPath = await runArtifactLifecycle<string, IosSourcePreparation, Candidate>({
      resolve: async () => {
        await resolveInitialFingerprint();
        if (easBuild) return { kind: 'ready', artifact: appPath! };
        remote = await resolveRemoteArtifact();
        if (appPath) return { kind: 'cached', artifact: appPath };
        miss(reasonForMiss([]).reason);
        return { kind: 'miss' };
      },
      claim: useBuildCache
        ? async () => {
            await awaitSharedBuild();
            return appPath;
          }
        : undefined,
      reuse: async (cached) => {
        appPath = await prepareCachedArtifact(cached);
        if (appPath) lateHit();
        else if (swapFellBack) miss(reasonForMiss([]).reason);
        return appPath;
      },
      build: {
        placement: {
          select: () => {
            buildFailure = { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache, buildMachine };
            return placeBuild();
          },
          acquire: acquireRemoteArtifact,
        },
        admit: takeBuildSlot,
        prepare: prepareSource,
        revalidate: revalidateSource,
        compile: compileHere,
        validate: async () => {
          await settleStoreKeyAfterCompile();
          return storeKey ? 'cacheable' : 'uncacheable';
        },
        store: storeArtifact,
        finish: finishArtifact,
      },
      release: () => {
        if (openOffload.choice) closeOffload(openOffload.choice);
        releaseLock();
        releaseSlot();
      },
    });
    const artifact: PreparedIosArtifact = {
      handoff,
      path: appPath!,
      bundleId,
      cache: {
        identity: storeHash && storeKey ? { fingerprint: storeHash, key: storeKey } : null,
        hit: cacheHit,
        providerName: (remote as LoadProjectProviderResult | null)?.name ?? providerName,
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
    if (error instanceof ArtifactRefusal)
      return {
        ok: false,
        failure: { ...error.failure, build: { ...buildFailure, ...error.failure.build } },
        compilationCache,
      };
    throw error;
  } finally {
    if (!transferred) releaseArtifact();
  }
}
