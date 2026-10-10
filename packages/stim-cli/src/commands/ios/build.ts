import { constants, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadCacheProvider } from '@stim-cli/cache';
import { hostSimulatorArch } from '@stim-cli/core';
import { phaseLine } from '../../command-output.ts';
import { listIosRuntimes } from '../../devices/ios.ts';
import { acquireBuildLock, releaseBuildLock, waitForBuild } from '../../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot } from '../../engine/build-slots.ts';
import { recordFinishedBuild, startBuildProgress, tapBuildLog } from '../../engine/build-progress.ts';
import type { CompilationCacheActivity } from '../../engine/build-facts.ts';
import { readBundleId } from '../../engine/xcode.ts';
import { runCancellationSignal, withNativeBuildRun } from '../../engine/native-run.ts';
import { checkEasAuth, resolveRemote, uploadRemote } from '../../engine/remote-cache.ts';
import { createRunRecorder, readRunEstimates, recordRunStats, statsProjectKey } from '../../engine/stats.ts';
import { projectRegistry } from '../../integrations/projects.ts';
import { createNdjsonWriter } from '../../ndjson.ts';
import { artifactCachePolicy, optimizationBuildProfile } from '../../optimizations.ts';
import { setRemoteLogSink } from '../../remote-log.ts';
import { getConcurrencyLimits, getProject, upsertProject } from '../../workspace/config.ts';
import { workspaceDir, workspaceLogsDir } from '../../workspace/paths.ts';
import { resolveCacheProviderConfig, resolveProjectSettings } from '../../workspace/settings.ts';
import { recordWorkspaceUse } from '../../workspace/workspace-state.ts';
import { ensureWorkspaceStorageSafely } from '../native-runtime.ts';
import { acquireIosArtifact, type PreparedIosArtifact } from './artifact.ts';
import { lastBuildRecord } from './result.ts';
import {
  iosProjectPathError,
  resolveConfiguration,
  resolveIosBuildSetup,
  resolveSchemeSelection,
  simulatorBuildArch,
} from './support.ts';
import { detectIsExpo } from '../../workspace/project-files.ts';

export interface IosBuildOptions {
  configuration?: string;
  scheme?: string;
  /** Simulator architecture. Defaults to the host for Debug, or all architectures otherwise. */
  arch?: 'arm64' | 'x86_64' | 'all';
  buildCache?: boolean;
  remoteBuild?: string;
}

export interface IosBuildFacts {
  /** Owned simulator app, retained with this workspace until explicitly removed. */
  appPath: string;
  bundleId: string | null;
  configuration: string;
  scheme: string | null;
  arch: 'arm64' | 'x86_64' | null;
  cacheKey: string | null;
  cacheHit: string | boolean;
  cacheSkipped: boolean;
  buildMachine: string;
  builtOn: string | null;
  compilationCache: CompilationCacheActivity;
  durationMs: number;
  logs: { dir: string };
}

const note = (line: string) => console.error(line);

export async function buildIosOperation(root: string, options: IosBuildOptions): Promise<IosBuildFacts> {
  const selected = projectRegistry.selectIos(root);
  if ('problem' in selected)
    throw Object.assign(new Error(selected.problem.message), {
      code: 'STIM_NO_PROJECT',
      remedy: selected.problem.remedy,
    });
  const { context, settings } = resolveProjectSettings(root);
  const projectPathError = iosProjectPathError(settings, root, () => detectIsExpo(root));
  if (projectPathError) throw Object.assign(new Error(projectPathError), { code: 'STIM_BAD_ARG' });
  const integration = await selected.load(settings);
  const setup = resolveIosBuildSetup(options.remoteBuild, settings, (label, message) =>
    note(phaseLine(label, message)),
  );
  if (!setup.ok) {
    const { failure } = setup;
    throw Object.assign(new Error(failure.message ?? failure.code), failure, { details: failure });
  }
  const { buildMachine, optimizations } = setup;
  const configuration = resolveConfiguration(options.configuration, settings);
  const buildScheme = resolveSchemeSelection(options, settings);
  const problem = integration.schemeProblem(buildScheme, configuration);
  if (problem) throw Object.assign(new Error(problem.message ?? problem.code), problem);
  if (options.arch !== undefined && !['arm64', 'x86_64', 'all'].includes(options.arch))
    throw Object.assign(new Error('iOS build arch must be arm64, x86_64 or all.'), { code: 'STIM_BAD_ARG' });
  const arch =
    options.arch === 'all'
      ? null
      : (options.arch ??
        simulatorBuildArch({ physical: false, remoteArch: null, hostArch: hostSimulatorArch(), configuration }));
  const cache = artifactCachePolicy(
    optimizations,
    options.buildCache !== false,
    integration.runtimeKind(configuration) === 'embedded-js',
  );
  const phase = (label: unknown, line: string) => note(phaseLine(label, line));
  await ensureWorkspaceStorageSafely(root, { note });
  return withNativeBuildRun(
    root,
    { command: 'build', platform: 'ios' },
    async (claim) => {
      if (!getProject(root)) upsertProject(root, {});
      recordWorkspaceUse(root);
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      const progress = startBuildProgress({ root, platform: 'ios', slot: 'default', claim, note });
      const logs = workspaceLogsDir(root);
      const logFile = join(logs, 'build-artifact-ios.ndjson');
      const writer = tapBuildLog(
        createNdjsonWriter(logFile, { truncate: true, fields: { platform: 'ios' } }),
        progress,
      );
      setRemoteLogSink((entry) => writer.write(entry));
      const projectKey = statsProjectKey({ root, commonDir: context.gitCommonDir, repoRoot: context.repoRoot });
      const stats = createRunRecorder({
        platform: 'ios',
        write: recordRunStats,
        now: Date.now,
        note,
        phases: () => progress.durations(),
        deviceSetup: () => false,
      });
      stats.setProject(projectKey);
      progress.estimate(projectKey);
      let artifact: PreparedIosArtifact | undefined;
      let directory: string | undefined;
      let succeeded = false;
      const finish = (status: string, appPath?: string, errorCode?: string) => {
        try {
          recordFinishedBuild(
            root,
            lastBuildRecord({
              startedAt,
              status,
              appPath,
              errorCode,
              configuration,
              durationMs: Date.now() - started,
              fingerprint: artifact?.cache.identity?.fingerprint,
              cacheKey: artifact?.cache.identity?.key,
              cacheHit: artifact?.cache.hit,
              cacheSkipped: artifact ? !artifact.cache.readEnabled : !cache.read,
              bundleId: artifact?.bundleId,
              buildMachine,
              builtOn: artifact?.cache.builtOn,
              offloadedTo: artifact?.cache.offloadedTo,
              offloadFallback: artifact?.cache.offloadFallback,
            }),
            { artifactOnly: true },
          );
        } catch (error) {
          note(phaseLine('state', `could not record the build: ${(error as Error)?.message || error}`));
        }
      };
      try {
        const acquired = await acquireIosArtifact(
          {
            root,
            logFile,
            configuration,
            buildMachine,
            physical: false,
            recipe: integration.artifact({
              root,
              logFile,
              configuration,
              buildScheme,
              buildProfile: optimizationBuildProfile('ios', optimizations),
              target: {
                udid: null,
                destination: 'generic/platform=iOS Simulator',
                sdk: 'iphonesimulator',
                arch,
                keyArch: arch,
                offloadRuntime: () =>
                  listIosRuntimes().toSorted((a, b) =>
                    b.version.localeCompare(a.version, undefined, { numeric: true }),
                  )[0]?.identifier ?? null,
                ...(arch ? { hostedArchitecture: arch } : {}),
                offloadRefusal: null,
              },
              device: null,
              optimizations: optimizations.ios,
              cache,
              phase,
              note,
              logWriter: () => writer,
              estimates: () => readRunEstimates({ projectKey, platform: 'ios' }),
              step: progress.step,
              setPodsMs: (ms) => stats.setPodsMs(ms),
            }),
            cache: {
              policy: cache,
              providerConfig: resolveCacheProviderConfig(context),
              disabledByFlag: options.buildCache === false,
            },
            easBuild: null,
            maxBuilds: getConcurrencyLimits().maxBuilds,
            progress: {
              phase,
              note,
              logWriter: () => writer,
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
            loadCacheProvider,
            checkEasAuth,
            resolveRemote,
            uploadRemote,
            acquireBuildLock,
            releaseBuildLock,
            waitForBuild,
            acquireBuildSlot,
            releaseBuildSlot,
            now: Date.now,
          },
        );
        if (!acquired.ok)
          throw Object.assign(new Error(acquired.failure.message ?? 'The iOS build failed.'), acquired.failure);
        artifact = acquired.artifact;
        artifact.bundleId ??= readBundleId(artifact.path) ?? integration.bundleId();
        if (runCancellationSignal()?.aborted)
          throw Object.assign(new Error('The iOS build was cancelled.'), { code: 'STIM_CANCELLED' });
        const artifacts = join(workspaceDir(root), 'artifacts');
        mkdirSync(artifacts, { recursive: true });
        directory = mkdtempSync(join(artifacts, 'ios-'));
        const appPath = join(directory, basename(artifact.path));
        cpSync(artifact.path, appPath, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
        await artifact.completeUploads();
        if (runCancellationSignal()?.aborted)
          throw Object.assign(new Error('The iOS build was cancelled.'), { code: 'STIM_CANCELLED' });
        finish('ok', appPath);
        stats.record({
          failed: false,
          durationMs: Date.now() - started,
          cacheHit: artifact.cache.hit === 'local' || artifact.cache.hit === 'remote' ? artifact.cache.hit : false,
          offloadedTo: artifact.cache.offloadedTo,
          waited: artifact.cache.waitedForBuild,
        });
        succeeded = true;
        return {
          appPath,
          bundleId: artifact.bundleId,
          configuration: configuration ?? 'Debug',
          scheme: buildScheme ?? null,
          arch,
          cacheKey: artifact.cache.identity?.key ?? null,
          cacheHit: artifact.cache.hit,
          cacheSkipped: !artifact.cache.readEnabled,
          buildMachine,
          builtOn: artifact.cache.builtOn ?? null,
          compilationCache: artifact.cache.compilation,
          durationMs: Date.now() - started,
          logs: { dir: logs },
        };
      } catch (error) {
        const failure = runCancellationSignal()?.aborted
          ? Object.assign(new Error('The iOS build was cancelled.'), { code: 'STIM_CANCELLED', cause: error })
          : error;
        finish('failed', undefined, (failure as { code?: string }).code);
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
