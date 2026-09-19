import { rmSync } from 'node:fs';
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
  describeFingerprintMiss,
  filesystemBuildCapability,
  fingerprintDiffRecord,
  fingerprintDiffSuffix,
  prepareProviderDownloadDir,
  providerDownloadPath,
  providerUploadOutcome,
  refingerprintAfterMutation,
  untrackedMissLine,
} from '../../cache/build-cache.ts';
import { formatDuration, phaseLine, shortHash, stepTimer } from '../../command-output.ts';
import {
  takeoverLine,
  WAIT_CEILING_MS,
  type BuildLockHandle,
  type WaitForBuildResult,
} from '../../engine/build-lock.ts';
import type { BuildSlotHandle } from '../../engine/build-slots.ts';
import { easDeviceBuildRemedy, type EasBuildResult } from '../../engine/eas-build.ts';
import { copyAppAside, writeIpTxt } from '../../engine/ios-lan.ts';
import {
  RESOLVE_TIMEOUT_MS,
  easAuthNote,
  isEasAuthFailureText,
  type LoadProjectProviderResult,
} from '../../engine/remote-cache.ts';
import type { RunRecorder, RunEstimates } from '../../engine/stats.ts';
import { COMPILATION_CACHE_NOT_RUN, compilationCacheActivityLine } from '../../engine/xcode.ts';
import type { NdjsonWriter } from '../../ndjson.ts';
import { artifactCachePolicy, type Optimizations } from '../../optimizations.ts';
import { claimFailure } from '../../ownership-claim.ts';
import { workspaceDir } from '../../workspace/paths.ts';
import type { CacheHitLevel, CompilationCacheActivity } from '../../engine/build-facts.ts';
import type { IosDeps } from './dependencies.ts';
import { finishIosUpload } from './result.ts';
import { PLATFORM, isReleaseConfiguration, podAction, printDiagnostics, xcodeFailureReport } from './support.ts';
import type { BuildFailureFields, FailArgs, RemoteUploadLike, WaitedForBuild } from './types.ts';

// xcodebuild cannot target a remote simulator UDID, so remote builds use the generic destination.
const GENERIC_SIM_DESTINATION = 'generic/platform=iOS Simulator';
const IPHONEOS_SDK = 'iphoneos';
const PROVIDER_SKIPPED_ON_DEVICE =
  'a device build is local-tier only: its cache key names the iphoneos slice, and a remote or provider entry is keyed for the simulator';

interface IosArtifactRequest {
  root: string;
  logFile: string;
  udid: string;
  remoteDestination: boolean;
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
    stats: Pick<RunRecorder, 'setCacheKey' | 'setBuildMs' | 'setPodsMs'>;
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
  | 'needsPrebuild'
  | 'runPrebuild'
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
    readEnabled: boolean;
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
    device,
    configuration,
    buildScheme,
    buildProfile,
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
  const { phase, note, logWriter, estimates, stats } = progress;
  const physical = device !== null;
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
    const fingerprintTimer = stepTimer(d.now);
    let computedFingerprint: string | null;
    try {
      const computed = await d.fingerprintProject(root, { platform: PLATFORM });
      computedFingerprint = computed?.hash ?? null;
      fingerprintSources = computed?.sources ?? [];
    } catch (e) {
      computedFingerprint = null;
      note(chalk.dim(`Fingerprinting failed: ${(e as Error)?.message || e}`));
    }
    if (!computedFingerprint) {
      fail({
        code: 'STIM_NO_FINGERPRINT',
        message: `Could not fingerprint ${root}: @expo/fingerprint produced no hash for it.`,
        remedy: 'Check the project native inputs and the @expo/fingerprint error above, then retry.',
      });
    }
    fingerprint = computedFingerprint;
    cacheKey = buildCacheKey(PLATFORM, fingerprint, {
      scheme: buildScheme,
      ...(configuration ? { configuration } : {}),
      isSimulator: !physical,
      ...(buildProfile ? { buildProfile } : {}),
    });
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
    let missDiff = '';
    let missUntracked: string | null = null;
    if (!cached) {
      const lastBuild = (d.readWorkspaceState(root)?.lastBuild ?? null) as Record<string, unknown> | null;
      const miss = describeFingerprintMiss({
        platform: PLATFORM,
        current: { hash: fingerprint, sources: fingerprintSources },
        lastBuild,
      });
      if (miss) {
        missDiff = fingerprintDiffSuffix(miss.changed);
        logWriter().write(
          fingerprintDiffRecord({ changed: miss.changed, previousHash: miss.previousHash, hash: fingerprint }),
        );
      } else if (useBuildCache) {
        missUntracked = untrackedMissLine(d.untrackedNativeFiles({ projectRoot: root }));
      }
    }
    phase(
      'fingerprint',
      `${shortHash(fingerprint)} ${cached ? 'hit' : 'miss'}${useBuildCache ? '' : cache.disabledByFlag ? ' (--no-build-cache)' : ' (cache reuse off in config)'} ${fingerprintTimer()}${missDiff}`,
    );
    if (missUntracked) note(chalk.dim(phaseLine('fingerprint', missUntracked)));
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
        runOptions: configuration ? { configuration } : null,
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

  async function waitForSharedBuild(): Promise<void> {
    if (!useBuildCache) return;
    const waitStarted = d.now();
    let failedHolder: BuildLockHandle['held'];
    while (!appPath) {
      let attempt: BuildLockHandle | null = null;
      try {
        attempt = d.acquireBuildLock({ platform: PLATFORM, key: cacheKey, root, logFile });
      } catch (e) {
        const refusal = claimFailure(e, 'stim ios');
        if (refusal) {
          fail({
            code: refusal.code,
            message: refusal.message,
            remedy: refusal.remedy,
            build: { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache },
          });
        }
        note(
          chalk.yellow(
            phaseLine('build', `could not take the build lock: ${(e as Error)?.message || e}; building anyway`),
          ),
        );
      }

      if (attempt?.acquired) {
        buildLock = attempt;
        const previous = attempt.tookOver ?? failedHolder;
        if (previous) note(chalk.yellow(phaseLine('build', takeoverLine(previous))));
        break;
      } else if (attempt?.held) {
        releasedWait = null;
        const held = attempt.held;
        const who = held.projectRoot || 'another workspace';
        phase(
          'build',
          `${who} is already building ${shortHash(fingerprint)} (pid ${held.pid})` +
            `${held.logFile ? ` -- tail ${held.logFile}` : ''} -- stim guide lifecycle concurrency`,
        );

        let waited: WaitForBuildResult | null = null;
        try {
          const ceilingMs = WAIT_CEILING_MS - (d.now() - waitStarted);
          if (ceilingMs <= 0) {
            throw Object.assign(
              new Error(
                `Waited ${formatDuration(d.now() - waitStarted)} for shared builds without an artifact; ${who} (pid ${held.pid}) holds ${attempt.path}.`,
              ),
              {
                code: 'STIM_BUILD_WAIT_TIMEOUT',
                lockPath: attempt.path,
              },
            );
          }
          waited = await d.waitForBuild({ platform: PLATFORM, key: cacheKey, out: note, ceilingMs });
        } catch (e) {
          const refusal = claimFailure(e, 'stim ios');
          if (refusal) {
            fail({
              code: refusal.code,
              message: refusal.message,
              remedy: refusal.remedy,
              build: { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache },
            });
          }
          const err = e as Error & { code?: string; lockPath?: string };
          if (err?.code !== 'STIM_BUILD_WAIT_TIMEOUT') throw e;
          fail({
            code: 'STIM_BUILD_WAIT_TIMEOUT',
            message: err.message,
            remedy: `Check pid ${held.pid}; if it is not really building, remove ${err.lockPath} and run \`stim ios\` again.`,
            build: { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache },
          });
        }

        if (waited?.hit) {
          appPath = waited.hit ?? null;
          cacheHit = 'local';
          waitedForBuild = { pid: held.pid, ms: waited.waitedMs };
          phase(
            'build',
            `waited ${formatDuration(waited.waitedMs)} for ${who}'s build -> installed from cache -- stim guide lifecycle concurrency`,
          );
        } else if (waited?.lockReleased) {
          failedHolder = undefined;
          releasedWait = { facts: { pid: held.pid, ms: waited.waitedMs }, who };
          phase('build', `${who}'s build lock was released; rechecking this workspace before building`);
        } else {
          note(
            chalk.yellow(
              phaseLine(
                'build',
                `${who}'s build ended without an artifact (${waited?.builderFailed}); retrying the build lock`,
              ),
            ),
          );
          failedHolder = held;
        }
      } else {
        break;
      }
    }
    return;
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

  async function buildArtifact(): Promise<void> {
    buildFailure = { fingerprint, cacheKey, cacheHit, cacheSkipped: !useBuildCache };
    if (!appPath) {
      if (maxBuilds) {
        try {
          buildSlot = await d.acquireBuildSlot({ max: maxBuilds, root, logFile, out: note });
        } catch (e) {
          const refusal = claimFailure(e, 'stim ios');
          if (refusal) {
            fail({ code: refusal.code, message: refusal.message, remedy: refusal.remedy, build: buildFailure });
          }
          note(
            chalk.yellow(
              phaseLine('build', `could not take a build slot: ${(e as Error)?.message || e}; building anyway`),
            ),
          );
        }
      }

      const mutatingSteps: string[] = [];

      if (d.needsPrebuild(root, PLATFORM, isExpo)) {
        const result = await d.runPrebuild(root, PLATFORM, logWriter());
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
        phase('prebuild', `ios/ absent -> generated (${formatDuration(result?.durationMs ?? 0)})`);
        mutatingSteps.push('prebuild');
      }

      const podState = d.readPodState(root);
      const verdict = d.podsAreStale(podState.lockText, podState.manifestText);
      const action = podAction(podState, verdict);
      if (action.install) {
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
        if (!after) {
          storeHash = null;
          storeKey = null;
          buildFailure = { ...buildFailure, fingerprint: null, cacheKey: null };
          note(
            chalk.yellow(
              phaseLine(
                'fingerprint',
                `unavailable after ${mutatingSteps.join(', ')}; the build will be installed but not cached`,
              ),
            ),
          );
        } else if (after.moved) {
          storeHash = after.hash;
          storeSources = after.sources;
          storeKey = buildCacheKey(PLATFORM, after.hash, {
            scheme: buildScheme,
            ...(configuration ? { configuration } : {}),
            isSimulator: !physical,
            ...(buildProfile ? { buildProfile } : {}),
          });
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

      if (!appPath) {
        phase('build', `compiling ${configuration || 'Debug'} with xcodebuild`);
        const result = await d.buildIos({
          root,
          scheme: buildScheme,
          udid,
          destination: remoteDestination ? GENERIC_SIM_DESTINATION : null,
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
            build: buildFailure,
          });
        }
        stats.setBuildMs(result.durationMs);
        phase('build', `ok (${formatDuration(result.durationMs)})`);
        appPath = result.appPath;
        bundleId = result.bundleId;

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
            runOptions: configuration ? { configuration } : null,
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
      await waitForSharedBuild();
      await prepareCachedArtifact();
      await buildArtifact();
    }
    const artifact: PreparedIosArtifact = {
      path: appPath!,
      bundleId,
      cache: {
        identity: storeHash && storeKey ? { fingerprint: storeHash, key: storeKey } : null,
        hit: cacheHit,
        providerName: remote?.name ?? providerName,
        readEnabled: useBuildCache,
        waitedForBuild,
        compilation: compilationCache,
      },
      failureFields: buildFailure,
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
    if (error instanceof ArtifactRefusal) return { ok: false, failure: error.failure, compilationCache };
    throw error;
  } finally {
    releaseLock();
    releaseSlot();
    if (!transferred) releaseArtifact();
  }
}
