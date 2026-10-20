import { copyFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createStim, type StimBuildOptions, type StimBuildResult } from 'stim';
import { runCommand } from './command.ts';
import { failure, prepareCI, writeJson, type CIContextOptions } from './context.ts';
import type { CIFailure } from './index.ts';

type WithoutSignal<T> = T extends unknown ? Omit<T, 'signal'> : never;

export interface CIBuildOptions extends CIContextOptions {
  build: WithoutSignal<StimBuildOptions>;
}

export interface CIBuildResult {
  version: 1;
  stage: 'build';
  projectRoot: string;
  platform: StimBuildOptions['platform'];
  artifactsDir: string;
  resultPath: string;
  buildPath: string;
  /** Portable APK or tar.gz bundle preserving executable permissions and symlinks. */
  artifactPath: string | null;
  startedAt: string;
  durationMs: number;
  exitCode: number;
  build: StimBuildResult | null;
  failure?: CIFailure;
  reportingError?: CIFailure;
  diagnostics: { path: string | null; error?: CIFailure };
}

/** Builds and exports an artifact without starting or stopping a workspace runtime. */
export async function buildCI(input: CIBuildOptions): Promise<CIBuildResult> {
  const { options, projectRoot, artifactsDir, timeout, signal } = prepareCI(input);
  const started = Date.now();
  const result: CIBuildResult = {
    version: 1,
    stage: 'build',
    projectRoot,
    platform: options.build.platform,
    artifactsDir,
    resultPath: join(artifactsDir, 'result.json'),
    buildPath: join(artifactsDir, 'build.json'),
    artifactPath: null,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    exitCode: 1,
    build: null,
    diagnostics: { path: null },
  };
  let reporting = false;
  const onProgress: CIContextOptions['onProgress'] = options.onProgress
    ? (event) => {
        try {
          options.onProgress!(event);
        } catch (error) {
          result.reportingError ??= failure(error, 'STIM_CI_REPORT_FAILED');
          if (!reporting) throw error;
        }
      }
    : undefined;
  const stim = createStim({
    projectRoot,
    home: options.home ? resolve(options.home) : undefined,
    buildCache: options.buildCache ? resolve(options.buildCache) : undefined,
    onProgress,
  });
  let attempted = false;
  let exporting: string | undefined;
  try {
    signal?.throwIfAborted();
    attempted = true;
    result.build = await stim.build({ ...options.build, signal });
    signal?.throwIfAborted();
    writeJson(result.buildPath, result.build);
    if (result.build.platform === 'android') {
      exporting = join(artifactsDir, 'app.apk');
      copyFileSync(result.build.facts.apkPath, exporting);
    } else {
      const bundle = result.build.platform === 'ios' ? result.build.facts.appPath : result.build.facts.bundle;
      exporting = join(artifactsDir, 'app.tar.gz');
      const packed = await runCommand({
        command: ['tar', '-czf', exporting, '-C', dirname(bundle), '--', basename(bundle)],
        cwd: projectRoot,
        // macOS bsdtar stores extended attributes as AppleDouble ._* entries unless COPYFILE_DISABLE is set.
        env: { ...process.env, COPYFILE_DISABLE: '1' },
        artifactsDir,
        logName: 'artifact',
        signal,
        onOutput: onProgress,
      });
      if (packed.exitCode !== 0 || packed.error)
        throw Object.assign(new Error(packed.error ?? `Artifact export exited with ${packed.exitCode}.`), {
          code: 'STIM_CI_ARTIFACT_FAILED',
        });
    }
    signal?.throwIfAborted();
    result.artifactPath = exporting;
    result.exitCode = 0;
  } catch (error) {
    result.failure = failure(error, result.build ? 'STIM_CI_ARTIFACT_FAILED' : 'STIM_CI_BUILD_FAILED');
    if (result.build && !result.failure.code.startsWith('STIM_')) result.failure.code = 'STIM_CI_ARTIFACT_FAILED';
  } finally {
    reporting = true;
    if (signal?.aborted) {
      const timedOut = timeout?.aborted && !options.signal?.aborted;
      result.exitCode = timedOut ? 124 : 130;
      result.failure = {
        code: timedOut ? 'STIM_CI_TIMEOUT' : 'STIM_CI_CANCELLED',
        message: timedOut ? `CI build exceeded ${options.timeoutMs}ms.` : 'CI build was cancelled.',
      };
    }
    if (exporting && !result.artifactPath) {
      try {
        rmSync(exporting, { force: true });
      } catch (error) {
        result.reportingError ??= failure(error, 'STIM_CI_REPORT_FAILED');
      }
    }
    if (attempted) {
      try {
        const diagnostics = await stim.diagnostics({ tail: 1000, signal: AbortSignal.timeout(10_000) });
        result.diagnostics.path = join(artifactsDir, 'diagnostics.json');
        writeJson(result.diagnostics.path, diagnostics);
      } catch (error) {
        result.diagnostics.error = failure(error, 'STIM_CI_DIAGNOSTICS_FAILED');
      }
    }
    if (result.reportingError && result.exitCode === 0) {
      result.exitCode = 1;
      result.failure = result.reportingError;
    }
    result.durationMs = Date.now() - started;
    try {
      writeJson(result.resultPath, result);
    } catch (error) {
      result.reportingError = failure(error, 'STIM_CI_REPORT_FAILED');
      if (result.exitCode === 0) {
        result.exitCode = 1;
        result.failure = result.reportingError;
      }
    }
  }
  return result;
}
