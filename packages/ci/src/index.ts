import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStim, type StimOptions, type StimRunOptions, type StimRunResult, type StimStopResult } from 'stim';
import { runCommand, type CommandResult } from './command.ts';
import { copyDiagnosticLogs } from './artifacts.ts';

type WithoutSignal<T> = T extends unknown ? Omit<T, 'signal'> : never;

export interface CIOptions {
  projectRoot: string;
  run: WithoutSignal<StimRunOptions>;
  command: readonly [string, ...string[]];
  artifactsDir?: string;
  home?: string;
  buildCache?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: StimOptions['onProgress'];
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
  artifactsDir: string;
  resultPath: string;
  runPath: string;
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

function failure(error: unknown, code: string): CIFailure {
  const caught = error as { code?: unknown; message?: unknown; remedy?: unknown } | null;
  return {
    code: typeof caught?.code === 'string' ? caught.code : code,
    message: typeof caught?.message === 'string' ? caught.message : String(error),
    ...(typeof caught?.remedy === 'string' ? { remedy: caught.remedy } : {}),
  };
}

function writeJson(path: string, value: unknown): void {
  const pending = `${path}.tmp`;
  writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(pending, path);
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
    STIM_CI_ARTIFACTS_DIR: result.artifactsDir,
    STIM_CI_RUN_RESULT: result.runPath,
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
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive integer.');
  }
  if (
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    process.env.RUNNER_TEMP &&
    !options.home &&
    !process.env.STIM_HOME
  ) {
    const directory = join(resolve(process.env.RUNNER_TEMP), 'stim-ci');
    options = {
      ...options,
      home: join(directory, 'home'),
      buildCache: options.buildCache || (process.env.STIM_BUILD_CACHE ? undefined : join(directory, 'build-cache')),
    };
  }
  const projectRoot = realpathSync(options.projectRoot);
  const artifactsDir = options.artifactsDir ? resolve(options.artifactsDir) : mkdtempSync(join(tmpdir(), 'stim-ci-'));
  mkdirSync(artifactsDir, { recursive: true });
  if (readdirSync(artifactsDir).length > 0) {
    throw new Error(`Artifacts directory must be empty: ${artifactsDir}. Choose a new directory for this run.`);
  }
  const timeout = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
  const signals = [options.signal, timeout].filter((value): value is AbortSignal => value !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const started = Date.now();
  const result: CIResult = {
    version: 1,
    projectRoot,
    platform: options.run.platform,
    artifactsDir,
    resultPath: join(artifactsDir, 'result.json'),
    runPath: join(artifactsDir, 'run.json'),
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
    result.run = await stim.run({ ...options.run, signal });
    signal?.throwIfAborted();
    writeJson(result.runPath, result.run);
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
      try {
        const diagnostics = await stim.diagnostics({ tail: 1000, signal: AbortSignal.timeout(10_000) });
        const path = join(artifactsDir, 'diagnostics.json');
        writeJson(path, diagnostics);
        result.diagnostics.path = path;
        result.diagnostics.files = await copyDiagnosticLogs(diagnostics.directory, artifactsDir);
      } catch (error) {
        result.diagnostics.error = failure(error, 'STIM_CI_DIAGNOSTICS_FAILED');
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

export type { CommandResult } from './command.ts';
