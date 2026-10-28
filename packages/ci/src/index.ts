import { failure, prepareCI, writeJson, type CIContextOptions } from './context.ts';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createStim, type StimRunOptions, type StimRunResult, type StimStopResult } from 'stim';
import { runCommand, type CommandResult } from './command.ts';
import { copyDiagnosticLogs } from './artifacts.ts';

type WithoutKeys<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface CIOptions extends CIContextOptions {
  /** Selectors of the recorded build to run. `run` never builds, so build-time options such as `easProfile` belong to `buildCI`. */
  run: WithoutKeys<StimRunOptions, 'signal' | 'recordedBuild' | 'easProfile'>;
  command: readonly [string, ...string[]];
}

export interface CIFailure {
  code: string;
  message: string;
  remedy?: string;
}

export interface CIResult {
  version: 1;
  projectRoot: string;
  platform: StimRunOptions['platform'];
  artifactsDir: string | null;
  resultPath: string | null;
  runPath: string | null;
  startedAt: string;
  durationMs: number;
  exitCode: number;
  run: StimRunResult | null;
  test: CommandResult | null;
  failure?: CIFailure;
  reportingError?: CIFailure;
  diagnostics: { path: string | null; files?: string[]; error?: CIFailure };
  cleanup: { result: StimStopResult | null; error?: CIFailure };
}

function commandEnvironment(result: CIResult, options: CIOptions): NodeJS.ProcessEnv {
  const facts = result.run!.facts;
  return {
    ...process.env,
    ...(options.home ? { STIM_HOME: resolve(options.home) } : {}),
    ...(options.buildCache ? { STIM_BUILD_CACHE: resolve(options.buildCache) } : {}),
    STIM_CI_PLATFORM: result.platform,
    STIM_CI_DEVICE_ID: String('udid' in facts ? facts.udid : 'serial' in facts ? (facts.serial ?? '') : ''),
    STIM_CI_APP_ID: String('bundleId' in facts ? (facts.bundleId ?? '') : ''),
    STIM_CI_METRO_PORT: String('metroPort' in facts ? (facts.metroPort ?? '') : ''),
    STIM_CI_ARTIFACTS_DIR: result.artifactsDir ?? '',
    STIM_CI_RUN_RESULT: result.runPath ?? '',
  };
}

/** Runs an app and argv-based test command, stops its workspace or explicit slot, and retains diagnostics. */
export async function runCI(options: CIOptions): Promise<CIResult> {
  if (!options.command[0]) throw new Error('A non-empty test command is required.');
  for (const argument of options.command) {
    if (typeof argument !== 'string' || argument.includes('\0')) {
      throw new Error('Test command arguments must be strings without null bytes.');
    }
  }
  const prepared = prepareCI(options);
  options = prepared.options;
  const { projectRoot, artifactsDir, timeout, signal } = prepared;
  const started = Date.now();
  const result: CIResult = {
    version: 1,
    projectRoot,
    platform: options.run.platform,
    artifactsDir,
    resultPath: artifactsDir ? join(artifactsDir, 'result.json') : null,
    runPath: artifactsDir ? join(artifactsDir, 'run.json') : null,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    exitCode: 1,
    run: null,
    test: null,
    diagnostics: { path: null },
    cleanup: { result: null },
  };
  let cleaningUp = false;
  const onProgress: CIOptions['onProgress'] = options.onProgress
    ? (event) => {
        try {
          options.onProgress!(event);
        } catch (error) {
          result.reportingError ??= failure(error, 'STIM_CI_REPORT_FAILED');
          if (!cleaningUp) throw error;
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
  try {
    signal?.throwIfAborted();
    attempted = true;
    result.run = await stim.run({ ...options.run, recordedBuild: true, signal });
    signal?.throwIfAborted();
    if (result.runPath) writeJson(result.runPath, result.run);
    result.test = await runCommand({
      command: options.command,
      cwd: projectRoot,
      env: commandEnvironment(result, options),
      artifactsDir,
      signal,
      onOutput: onProgress,
    });
    result.exitCode = result.test.exitCode ?? 1;
    if (result.exitCode < 0 || (result.exitCode === 0 && result.test.error)) result.exitCode = 1;
    if (result.exitCode !== 0) {
      result.failure = {
        code: 'STIM_CI_TEST_FAILED',
        message:
          result.test.error ??
          `Test command ${result.test.signal ? `was terminated by ${result.test.signal}` : `exited with ${result.exitCode}`}.`,
      };
    }
  } catch (error) {
    result.failure = failure(error, result.run ? 'STIM_CI_TEST_FAILED' : 'STIM_CI_SETUP_FAILED');
    if (result.failure.code === 'STIM_NO_RECORDED_BUILD')
      result.failure.remedy = `Run ${buildCommand(options, projectRoot)} first.`;
  } finally {
    cleaningUp = true;
    if (signal?.aborted) {
      const timedOut = timeout?.aborted && !options.signal?.aborted;
      result.exitCode = timedOut ? 124 : 130;
      result.failure = {
        code: timedOut ? 'STIM_CI_TIMEOUT' : 'STIM_CI_CANCELLED',
        message: timedOut ? `CI run exceeded ${options.timeoutMs}ms.` : 'CI run was cancelled.',
      };
    }
    if (attempted) {
      try {
        result.cleanup.result = await stim.stop({
          ...('slot' in options.run ? { slot: options.run.slot } : {}),
          signal: AbortSignal.timeout(60_000),
        });
        if (!result.cleanup.result.ok) {
          result.cleanup.error = { code: 'STIM_CI_CLEANUP_FAILED', message: 'Stim could not stop the workspace.' };
        }
      } catch (error) {
        result.cleanup.error = failure(error, 'STIM_CI_CLEANUP_FAILED');
      }
      if (artifactsDir) {
        try {
          const diagnostics = await stim.diagnostics({ tail: 1000, signal: AbortSignal.timeout(10_000) });
          const path = join(artifactsDir, 'diagnostics.json');
          writeJson(path, diagnostics);
          result.diagnostics.path = path;
          result.diagnostics.files = await copyDiagnosticLogs(diagnostics.directory, artifactsDir);
        } catch (error) {
          result.diagnostics.error = failure(error, 'STIM_CI_DIAGNOSTICS_FAILED');
        }
      }
      if (options.signal?.aborted && result.exitCode === 0) {
        result.exitCode = 130;
        result.failure = { code: 'STIM_CI_CANCELLED', message: 'CI run was cancelled.' };
      }
      if (result.cleanup.error && result.exitCode === 0) {
        result.exitCode = 1;
        result.failure = result.cleanup.error;
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

/** The `stim-ci build` invocation that records the app a `run` with these selectors installs. */
function buildCommand({ run, home, buildCache }: CIOptions, projectRoot: string): string {
  const flags = [`--platform ${run.platform}`];
  if (projectRoot !== realpathSync(process.cwd())) flags.push(`--project ${JSON.stringify(projectRoot)}`);
  if (home) flags.push(`--home ${JSON.stringify(resolve(home))}`);
  if (buildCache) flags.push(`--build-cache ${JSON.stringify(resolve(buildCache))}`);
  if (run.platform === 'ios') {
    if (run.scheme !== undefined) flags.push(`--scheme ${JSON.stringify(run.scheme)}`);
    if (run.configuration !== undefined) flags.push(`--configuration ${JSON.stringify(run.configuration)}`);
  } else if (run.platform === 'android' && run.variant !== undefined) {
    flags.push(`--variant ${JSON.stringify(run.variant)}`);
  }
  return `stim-ci build ${flags.join(' ')}`;
}

export type { CommandResult } from './command.ts';

export { buildCI, type CIBuildOptions, type CIBuildResult } from './build.ts';
