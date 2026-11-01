import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createStim, type StimBuildOptions, type StimBuildResult } from 'stim';
import { runCommand } from './command.ts';
import { failure, prepareCI, writeJson, type CIContextOptions } from './context.ts';
import type { CIFailure } from './index.ts';

type WithoutKeys<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface CIBuildOptions extends CIContextOptions {
  /** Always compiles on this machine; `remoteBuild` is not accepted. */
  build: WithoutKeys<StimBuildOptions, 'signal' | 'remoteBuild'>;
  /** Also writes the app here as a portable APK (Android) or tar.gz (iOS, macOS); without it the build is only recorded for `run`. */
  exportPath?: string;
}

export interface CIBuildResult {
  version: 1;
  stage: 'build';
  projectRoot: string;
  platform: StimBuildOptions['platform'];
  artifactsDir: string | null;
  resultPath: string | null;
  buildPath: string | null;
  /** The exported APK or tar.gz bundle preserving executable permissions and symlinks; null unless an export was requested. */
  artifactPath: string | null;
  startedAt: string;
  durationMs: number;
  exitCode: number;
  build: StimBuildResult | null;
  failure?: CIFailure;
  reportingError?: CIFailure;
  diagnostics: { path: string | null; error?: CIFailure };
}

/** Builds the app and records it for `runCI` without starting or stopping a workspace runtime. */
export async function buildCI(input: CIBuildOptions): Promise<CIBuildResult> {
  const { options, projectRoot, artifactsDir, timeout, signal } = prepareCI(input);
  const started = Date.now();
  const result: CIBuildResult = {
    version: 1,
    stage: 'build',
    projectRoot,
    platform: options.build.platform,
    artifactsDir,
    resultPath: artifactsDir ? join(artifactsDir, 'result.json') : null,
    buildPath: artifactsDir ? join(artifactsDir, 'build.json') : null,
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
    result.build = await stim.build({ ...options.build, remoteBuild: 'local', signal });
    signal?.throwIfAborted();
    if (result.buildPath) writeJson(result.buildPath, result.build);
    if (input.exportPath) exporting = resolve(input.exportPath);
    if (exporting) mkdirSync(dirname(exporting), { recursive: true });
    if (exporting && result.build.platform === 'android') {
      copyFileSync(result.build.facts.apkPath, exporting);
    } else if (exporting && result.build.platform !== 'android') {
      const bundle = result.build.platform === 'ios' ? result.build.facts.appPath : result.build.facts.bundle;
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
    result.artifactPath = exporting ?? null;
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
    if (attempted && artifactsDir) {
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
    if (result.resultPath) {
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
  }
  return result;
}
