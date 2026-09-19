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
  describeFingerprintMiss,
  filesystemBuildCapability,
  fingerprintDiffRecord,
  fingerprintDiffSuffix,
  prepareProviderDownloadDir,
  providerDownloadPath,
  refingerprintAfterMutation,
  untrackedMissLine,
  type fingerprintProject,
  type resolveBuild,
  type storeBuild,
  type storedAssetManifest,
  type untrackedNativeFiles,
} from '../../build-cache.ts';
import { formatDuration, phaseLine, shortHash, stepTimer } from '../../command-output.ts';
import {
  takeoverLine,
  WAIT_CEILING_MS,
  type acquireBuildLock,
  type releaseBuildLock,
  type waitForBuild as waitForOtherBuild,
  type BuildLockHandle,
  type WaitForBuildResult,
} from '../../engine/build-lock.ts';
import type { acquireBuildSlot, releaseBuildSlot, BuildSlotHandle } from '../../engine/build-slots.ts';
import { resolveKeystore, type swapApkBundle } from '../../engine/apk-swap.ts';
import type { captureAssetManifest } from '../../engine/asset-manifest.ts';
import { CCACHE_NOT_RUN, CCACHE_UNAVAILABLE, ccacheActivityLine, type resolveCcache } from '../../engine/ccache.ts';
import type { OwnedDeviceRecord } from '../../engine/device.ts';
import type { EasBuildResult } from '../../engine/eas-build.ts';
import { formatDiagnostic } from '../../engine/errors-gradle.ts';
import type { buildAndroid } from '../../engine/gradle.ts';
import type { needsPrebuild, runPrebuild } from '../../engine/prebuild.ts';
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
import { claimFailure } from '../../ownership-claim.ts';
import { workspaceDir } from '../../workspace/paths.ts';
import { detectAndroidPackage } from '../../workspace/project.ts';
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
    stats: Pick<RunRecorder, 'setCacheKey' | 'setBuildMs'>;
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
  needsPrebuildFor: typeof needsPrebuild;
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
    needsPrebuildFor,
    prebuild,
    build,
    ccacheFor,
    swapApk,
    readState,
    now,
  }: AndroidArtifactDeps,
): Promise<AndroidArtifactResult> {
  const { phase, out, estimates, stats } = progress;
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
    const fingerprintTimer = stepTimer(now);
    try {
      const computed = await fingerprint(root, { platform: PLATFORM });
      hash = computed?.hash ?? '';
      fingerprintSources = computed?.sources ?? [];
    } catch (err) {
      phaseFailure = fail(
        NO_FINGERPRINT,
        `@expo/fingerprint could not fingerprint ${root}: ${(err as Error)?.message || err}`,
        'Fix the @expo/fingerprint error above, then retry.',
      );
      return false;
    }
    if (!hash) {
      phaseFailure = fail(
        NO_FINGERPRINT,
        `@expo/fingerprint returned no hash for ${root}, so the build cache cannot be addressed.`,
        'Check the project native inputs and the @expo/fingerprint error above, then retry.',
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
    let missDiff = '';
    let missUntracked: string | null = null;
    if (!cached) {
      const lastBuild = (readState(root)?.lastBuild ?? null) as Record<string, unknown> | null;
      const miss = describeFingerprintMiss({
        platform: PLATFORM,
        current: { hash, sources: fingerprintSources },
        lastBuild,
      });
      if (miss) {
        missDiff = fingerprintDiffSuffix(miss.changed);
        writer.write(fingerprintDiffRecord({ changed: miss.changed, previousHash: miss.previousHash, hash }));
      } else if (useBuildCache) {
        missUntracked = untrackedMissLine(untracked({ projectRoot: root }));
      }
    }
    phase(
      'fingerprint',
      `${shortHash(hash)} ${cached ? 'hit' : 'miss'}${useBuildCache ? '' : !requestedBuildCache ? ' (--no-build-cache)' : ' (cache reuse off in config)'} ${fingerprintTimer()}${missDiff}`,
    );
    if (missUntracked) phase('fingerprint', chalk.dim(missUntracked));
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

  if (!easBuild) await resolveRemoteArtifact();

  let waitedForBuild: WaitedForBuild | null = null;
  let releasedWait: { facts: WaitedForBuild; who: string } | null = null;
  async function waitForSharedBuild(): Promise<boolean> {
    if (!useBuildCache) return true;
    const waitStarted = now();
    let failedHolder: BuildLockHandle['held'];
    while (!apkPath) {
      let attempt: BuildLockHandle | null = null;
      try {
        attempt = acquireLock({ platform: PLATFORM, key: cacheKey, root, logFile: buildLog });
      } catch (err) {
        const refusal = claimFailure(err, 'stim android');
        if (refusal) {
          phaseFailure = fail(refusal.code, refusal.message, refusal.remedy, { lastBuildStatus: true });
          return false;
        }
        phase(
          'build',
          chalk.yellow(`could not take the build lock: ${(err as Error)?.message || err}; building anyway`),
        );
      }

      if (attempt?.acquired) {
        buildLock = attempt;
        const previous = attempt.tookOver ?? failedHolder;
        if (previous) phase('build', chalk.yellow(takeoverLine(previous)));
        break;
      } else if (attempt?.held) {
        releasedWait = null;
        const holder = attempt.held;
        const who = holder.projectRoot || 'another workspace';
        phase(
          'build',
          `${who} is already building ${shortHash(hash)} (pid ${holder.pid})` +
            `${holder.logFile ? ` -- tail ${holder.logFile}` : ''} -- stim guide lifecycle concurrency`,
        );

        let waited: WaitForBuildResult | null = null;
        try {
          const ceilingMs = WAIT_CEILING_MS - (now() - waitStarted);
          if (ceilingMs <= 0) {
            throw Object.assign(
              new Error(
                `Waited ${formatDuration(now() - waitStarted)} for shared builds without an artifact; ${who} (pid ${holder.pid}) holds ${attempt.path}.`,
              ),
              {
                code: 'STIM_BUILD_WAIT_TIMEOUT',
                lockPath: attempt.path,
              },
            );
          }
          waited = await waitForBuild({ platform: PLATFORM, key: cacheKey, out, ceilingMs });
        } catch (err) {
          const refusal = claimFailure(err, 'stim android');
          if (refusal) {
            phaseFailure = fail(refusal.code, refusal.message, refusal.remedy, { lastBuildStatus: true });
            return false;
          }
          const wtErr = err as Error & { code?: string; lockPath?: string };
          if (wtErr?.code !== 'STIM_BUILD_WAIT_TIMEOUT') throw err;
          phaseFailure = fail(
            'STIM_BUILD_WAIT_TIMEOUT',
            wtErr.message,
            `Check pid ${holder.pid}; if it is not really building, remove ${wtErr.lockPath} and run \`stim android\` again.`,
            { lastBuildStatus: true },
          );
          return false;
        }

        if (waited?.hit) {
          apkPath = waited.hit ?? null;
          record.cacheHit = 'local';
          waitedForBuild = { pid: holder.pid, ms: waited.waitedMs };
          phase(
            'build',
            `waited ${formatDuration(waited.waitedMs)} for ${who}'s build -> installed from cache -- stim guide lifecycle concurrency`,
          );
        } else if (waited?.lockReleased) {
          failedHolder = undefined;
          releasedWait = { facts: { pid: holder.pid, ms: waited.waitedMs }, who };
          phase('build', `${who}'s build lock was released; rechecking this workspace before building`);
        } else {
          phase(
            'build',
            chalk.yellow(
              `${who}'s build ended without an artifact (${waited?.builderFailed}); retrying the build lock`,
            ),
          );
          failedHolder = holder;
        }
      } else {
        break;
      }
    }
    return true;
  }

  if (!easBuild && !(await waitForSharedBuild())) return refused();

  let swapDir: string | null = null;
  let swapFellBack = false;
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

  async function buildArtifact(): Promise<boolean> {
    if (!apkPath) {
      try {
        if (maxBuilds) {
          try {
            buildSlot = await acquireSlot({ max: maxBuilds, root, logFile: buildLog, out });
          } catch (err) {
            const refusal = claimFailure(err, 'stim android');
            if (refusal) {
              phaseFailure = fail(refusal.code, refusal.message, refusal.remedy, { lastBuildStatus: true });
              return false;
            }
            phase(
              'build',
              chalk.yellow(`could not take a build slot: ${(err as Error)?.message || err}; building anyway`),
            );
          }
        }

        if (needsPrebuildFor(root, PLATFORM, isExpo)) {
          const pre: PrebuildResultLike = await prebuild(root, PLATFORM, writer, { isExpo });
          if (pre.failed) {
            phaseFailure = fail(pre.code!, pre.reason, pre.remedy, {
              lastBuildStatus: true,
              lines: tail(pre.lastLines),
              logPath: displayPath(root, buildLog),
            });
            return false;
          }
          phase('prebuild', `android/ generated (${formatDuration(pre.durationMs)})`);
          androidPackage = androidPackage || detectAndroidPackage(root);
          record.bundleId = androidPackage;

          const after = await refingerprintAfterMutation({
            projectRoot: root,
            platform: PLATFORM,
            previousHash: hash,
            fingerprint,
          });
          if (after?.moved) {
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

        if (!apkPath) {
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
          const afterBuild = await refingerprintAfterMutation({
            projectRoot: root,
            platform: PLATFORM,
            previousHash: beforeBuildHash,
            fingerprint,
          });
          if (!afterBuild) {
            record.fingerprint = null;
            record.cacheKey = null;
            phase('fingerprint', chalk.yellow('unavailable after Gradle; the build will be installed but not cached'));
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
      } finally {
        releaseHeldLock();
        releaseHeldSlot();
      }
    }
    return true;
  }

  if (!easBuild) {
    await prepareCachedArtifact();
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
