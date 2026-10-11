import { constants, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadCacheProvider } from '@stim-cli/cache';
import { providerUploadOutcome } from '../../cache/build-cache.ts';
import { phaseLine } from '../../command-output.ts';
import { hostSystemImageArch } from '../../devices/android.ts';
import { acquireBuildLock, releaseBuildLock, waitForBuild } from '../../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot } from '../../engine/build-slots.ts';
import { recordFinishedBuild, startBuildProgress, tapBuildLog } from '../../engine/build-progress.ts';
import type { CcacheActivity } from '../../engine/build-facts.ts';
import { runCancellationSignal, withNativeBuildRun } from '../../engine/native-run.ts';
import { cancelledError, throwIfCancelled } from '../../cancellation.ts';
import { checkEasAuth, resolveRemote, uploadRemote } from '../../engine/remote-cache.ts';
import { createRunRecorder, readRunEstimates, recordRunStats, statsProjectKey } from '../../engine/stats.ts';
import { projectRegistry } from '../../integrations/projects.ts';
import { createNdjsonWriter } from '../../ndjson.ts';
import { resolveBuildPlacement } from '../../offload/selection.ts';
import { setRemoteLogSink } from '../../remote-log.ts';
import { getConcurrencyLimits, getProject, upsertProject } from '../../workspace/config.ts';
import { workspaceDir, workspaceLogsDir } from '../../workspace/paths.ts';
import { resolveProjectSettings } from '../../workspace/settings.ts';
import { recordWorkspaceUse } from '../../workspace/workspace-state.ts';
import { ensureWorkspaceStorageSafely } from '../native-runtime.ts';
import { acquireAndroidArtifact, type PreparedAndroidArtifact } from './artifact.ts';
import { resolveAndroidBuildPlan } from './plan.ts';
import { finishAndroidUpload, persistLastBuild } from './result.ts';
import type { AndroidRecord } from './types.ts';

export interface AndroidBuildOptions {
  variant?: string;
  abi?: 'arm64-v8a' | 'armeabi-v7a' | 'x86' | 'x86_64' | 'all';
  buildCache?: boolean;
  remoteBuild?: string;
}

export interface AndroidBuildFacts {
  /** Owned copy, retained with this workspace until explicitly removed. */
  apkPath: string;
  androidPackage: string | null;
  variant: string;
  abi: string | null;
  cacheKey: string | null;
  cacheHit: string | boolean;
  cacheSkipped: boolean;
  buildMachine: string;
  builtOn: string | null;
  ccache: CcacheActivity;
  durationMs: number;
  logs: { dir: string };
}

const note = (line: string) => console.error(line);

export async function buildAndroidOperation(root: string, options: AndroidBuildOptions): Promise<AndroidBuildFacts> {
  const selected = projectRegistry.selectAndroid(root);
  if ('problem' in selected)
    throw Object.assign(new Error(selected.problem.message), {
      code: 'STIM_NO_PROJECT',
      remedy: selected.problem.remedy,
    });
  const { context: settingsContext, settings } = resolveProjectSettings(root);
  const integration = await selected.load({ context: settingsContext, settings });
  const phase = (label: unknown, line: string) => note(phaseLine(label, line));
  const plan = resolveAndroidBuildPlan(
    { settings, settingsContext, variant: options.variant ?? null, buildCache: options.buildCache !== false },
    {
      warn: phase,
      runtimeKind: integration.runtimeKind,
      variantProblem: integration.variantProblem,
      detectExpo: () => integration.isExpo,
    },
  );
  if (!plan.ok) throw Object.assign(new Error(plan.message), plan, { details: { lines: plan.lines } });
  const placement = resolveBuildPlacement(options.remoteBuild);
  if (placement.failure) throw Object.assign(new Error(placement.failure.message), placement.failure);
  if (options.abi !== undefined && !['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64', 'all'].includes(options.abi))
    throw Object.assign(new Error('Android build abi must be arm64-v8a, armeabi-v7a, x86, x86_64 or all.'), {
      code: 'STIM_BAD_ARG',
    });
  const abi =
    options.abi === 'all'
      ? null
      : (options.abi ?? (plan.plan.build.targetAbiOnly && !plan.plan.build.release ? hostSystemImageArch() : null));
  await ensureWorkspaceStorageSafely(root, { note });
  return withNativeBuildRun(
    root,
    { command: 'build', platform: 'android' },
    async (claim) => {
      if (!getProject(root)) upsertProject(root, {});
      recordWorkspaceUse(root);
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      const progress = startBuildProgress({ root, platform: 'android', slot: 'default', claim, note });
      const logs = workspaceLogsDir(root);
      const buildLog = join(logs, 'build-artifact-android.ndjson');
      const writer = tapBuildLog(
        createNdjsonWriter(buildLog, { truncate: true, fields: { platform: 'android' } }),
        progress,
      );
      setRemoteLogSink((entry) => writer.write(entry));
      const projectKey = statsProjectKey({
        root,
        commonDir: settingsContext.gitCommonDir,
        repoRoot: settingsContext.repoRoot,
      });
      const stats = createRunRecorder({
        platform: 'android',
        write: recordRunStats,
        now: Date.now,
        note,
        phases: () => progress.durations(),
        deviceSetup: () => false,
      });
      stats.setProject(projectKey);
      progress.estimate(projectKey);
      const record: AndroidRecord = { buildMachine: placement.selected, configuration: plan.plan.build.variant };
      let artifact: PreparedAndroidArtifact | undefined;
      let directory: string | undefined;
      let succeeded = false;
      const finishRecord = (status: string, errorCode?: string) =>
        persistLastBuild({
          root,
          record,
          startedAt,
          durationMs: Date.now() - started,
          status,
          errorCode,
          out: note,
          recordBuild: (at, entry) => recordFinishedBuild(at, entry, { artifactOnly: true }),
        });
      try {
        const acquired = await acquireAndroidArtifact(
          {
            root,
            buildLog,
            writer,
            recipe: integration.artifact({
              root,
              buildLog,
              writer,
              settings,
              buildPlan: plan.plan.build,
              target: { abi },
              phase,
              out: note,
              step: progress.step,
              estimates: () => readRunEstimates({ projectKey, platform: 'android' }),
            }),
            targetOffloadRefusal: null,
            buildPlan: plan.plan.build,
            cacheProviderConfig: plan.plan.cacheProviderConfig,
            requestedBuildCache: options.buildCache !== false,
            easBuild: null,
            androidPackage: integration.appIds().androidPackage,
            record,
            maxBuilds: getConcurrencyLimits().maxBuilds,
            progress: {
              phase,
              out: note,
              stats,
              step: progress.step,
              miss: progress.miss,
              hit: progress.hit,
              place: progress.place,
              waitingOn: progress.waitingOn,
              waitingFor: progress.waitingFor,
            },
          },
          {
            acquireLock: acquireBuildLock,
            releaseLock: releaseBuildLock,
            waitForBuild,
            easAuth: checkEasAuth,
            resolveRemoteBuild: resolveRemote,
            uploadRemoteBuild: uploadRemote,
            loadCacheProviderModule: loadCacheProvider,
            acquireSlot: acquireBuildSlot,
            releaseSlot: releaseBuildSlot,
            now: Date.now,
          },
        );
        if (!acquired.ok)
          throw Object.assign(new Error(acquired.failure.message ?? 'Android build failed.'), acquired.failure, {
            details: acquired.failure.extra,
          });
        artifact = acquired.artifact;
        throwIfCancelled(runCancellationSignal(), 'Android build');
        if (!artifact.apkPath)
          throw Object.assign(new Error('The Android build produced no APK.'), { code: 'STIM_BUILD_FAILED' });
        const artifacts = join(workspaceDir(root), 'artifacts');
        mkdirSync(artifacts, { recursive: true });
        directory = mkdtempSync(join(artifacts, 'android-'));
        const apkPath = join(directory, 'app.apk');
        copyFileSync(artifact.apkPath, apkPath, constants.COPYFILE_FICLONE);
        await finishAndroidUpload(artifact.uploadPending, artifact.remote, phase);
        const uploaded = providerUploadOutcome(
          artifact.providerUpload ? await artifact.providerUpload : null,
          artifact.providerName,
        );
        if (uploaded) phase('cache', uploaded.line);
        throwIfCancelled(runCancellationSignal(), 'Android build');
        record.appPath = apkPath;
        record.bundleId = artifact.androidPackage;
        finishRecord('ok');
        stats.record({
          failed: false,
          cacheHit: record.cacheHit === 'local' || record.cacheHit === 'remote' ? record.cacheHit : false,
          durationMs: Date.now() - started,
          offloadedTo: record.offloadedTo,
          waited: artifact.waitedForBuild,
        });
        succeeded = true;
        return {
          apkPath,
          androidPackage: artifact.androidPackage,
          variant: plan.plan.build.variant ?? 'debug',
          abi,
          cacheKey: record.cacheKey ?? null,
          cacheHit: record.cacheHit ?? false,
          cacheSkipped: record.cacheSkipped ?? false,
          buildMachine: placement.selected,
          builtOn: record.builtOn ?? null,
          ccache: artifact.ccache,
          durationMs: Date.now() - started,
          logs: { dir: logs },
        };
      } catch (error) {
        const failure = runCancellationSignal()?.aborted ? cancelledError('Android build', error) : error;
        finishRecord('failed', (failure as { code?: string }).code);
        stats.record({ failed: true, durationMs: Date.now() - started });
        throw failure;
      } finally {
        artifact?.release();
        if (!succeeded && directory) rmSync(directory, { recursive: true, force: true });
        writer.close();
        progress.clear();
      }
    },
    { write: (line) => phase('lock', line) },
  );
}
