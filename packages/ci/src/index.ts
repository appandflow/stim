import { failure, prepareCI, writeJson, type CIContextOptions } from './context.ts';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createStim, type StimRunOptions, type StimRunResult, type StimStopResult } from 'stim';
import { bindCIEngine, type AttachedHost } from 'stim/attached-stimd';
import { runCommand, type CommandResult } from './command.ts';
import { copyDiagnosticLogs } from './artifacts.ts';

type WithoutKeys<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface CIOptions extends CIContextOptions {
  /** Selectors of the recorded build to run. `run` never builds, so build-time options such as `easProfile` belong to `buildCI`. */
  run: WithoutKeys<StimRunOptions, 'signal' | 'recordedBuild' | 'cleanAppState' | 'easProfile'>;
  /** Test command argv. Without it, `runCI` installs and launches the app, then stops it as after a passing test. */
  command?: readonly [string, ...string[]];
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

function stimEnvironment(options: CIOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(options.home ? { STIM_HOME: resolve(options.home) } : {}),
    ...(options.buildCache ? { STIM_BUILD_CACHE: resolve(options.buildCache) } : {}),
  };
}

function commandEnvironment(result: CIResult, options: CIOptions, ownedHost: boolean): NodeJS.ProcessEnv {
  const facts = result.run!.facts;
  return {
    ...stimEnvironment(options),
    ...(ownedHost ? { STIM_POOL_BOOTED_GRACE_MINUTES: '0' } : {}),
    STIM_CI_PLATFORM: result.platform,
    STIM_CI_DEVICE_ID: String('udid' in facts ? (facts.udid ?? '') : 'serial' in facts ? (facts.serial ?? '') : ''),
    STIM_CI_APP_ID: String('bundleId' in facts ? (facts.bundleId ?? '') : ''),
    STIM_CI_METRO_PORT: String('metroPort' in facts ? (facts.metroPort ?? '') : ''),
    STIM_CI_ARTIFACTS_DIR: result.artifactsDir ?? '',
    STIM_CI_RUN_RESULT: result.runPath ?? '',
  };
}

/**
 * Runs an app and an optional argv-based test command, stops its workspace or explicit slot, and retains diagnostics.
 * Unless a stimd already serves the home, the run hosts one as its own child for the whole job, which the test
 * command's Stim commands share and which ends with the run, so the job leaves no stimd behind.
 */
export async function runCI(options: CIOptions): Promise<CIResult> {
  if (options.command && !options.command[0]) throw new Error('A non-empty test command is required.');
  for (const argument of options.command ?? []) {
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
  let stim = createStim({
    projectRoot,
    home: options.home ? resolve(options.home) : undefined,
    buildCache: options.buildCache ? resolve(options.buildCache) : undefined,
    onProgress,
  });
  let attempted = false;
  let host: AttachedHost | null = null;
  let releaseEngine: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    const binding = await bindCIEngine(stimEnvironment(options));
    releaseEngine = binding.release;
    const hosted = await binding.host(
      { ...stimEnvironment(options), STIM_POOL_BOOTED_GRACE_MINUTES: '0' },
      { handover: false },
    );
    if (hosted === 'blocked' || hosted === 'blocked-lock')
      throw Object.assign(new Error('The sandbox denied the Stim daemon socket.'), {
        code: 'STIM_SANDBOX_BLOCKED',
        remedy: 'Run outside the sandbox; `stim guide errors sandbox` explains the available allowances.',
      });
    if (hosted && typeof hosted === 'object' && 'switched' in hosted)
      throw Object.assign(new Error(`Stim updated to ${hosted.switched}; rerun`), {
        code: 'STIM_ENGINE_SWITCHED',
        remedy: 'Rerun the CI job with the selected engine.',
      });
    if (hosted === 'engine-unavailable')
      throw Object.assign(new Error('The selected Stim engine cannot be verified.'), {
        code: 'STIM_ENGINE_UNAVAILABLE',
        remedy: 'Run stim engine rollback or stim engine use to restore the engine pointer.',
      });
    if (hosted === 'held-attached')
      throw Object.assign(new Error('Another command owns the attached Stim daemon for this home.'), {
        code: 'STIM_CI_ATTACHED_HOME',
        remedy: 'Use a separate STIM_HOME for each concurrent CI job.',
      });
    if (hosted === null) throw new Error('Could not start the Stim daemon for this CI job.');
    if (hosted && typeof hosted === 'object' && 'end' in hosted) {
      host = hosted;
      stim = createStim({
        projectRoot,
        home: options.home ? resolve(options.home) : undefined,
        buildCache: options.buildCache ? resolve(options.buildCache) : undefined,
        env: { ...process.env, STIM_POOL_BOOTED_GRACE_MINUTES: '0' },
        onProgress,
      });
    }
    const context = {
      projectRoot,
      home: options.home ? resolve(options.home) : undefined,
      buildCache: options.buildCache ? resolve(options.buildCache) : undefined,
      env: host ? { ...process.env, STIM_POOL_BOOTED_GRACE_MINUTES: '0' } : { ...process.env },
      onProgress,
    };
    stim = new Proxy(stim, {
      get(target, name) {
        const value: unknown = Reflect.get(target, name);
        if (typeof name !== 'string' || typeof value !== 'function') return value;
        return (...args: unknown[]) => binding.runOp(name, args, context);
      },
    });
    attempted = true;
    result.run = await stim.run({ ...options.run, recordedBuild: true, cleanAppState: true, signal });
    signal?.throwIfAborted();
    if (result.runPath) writeJson(result.runPath, result.run);
    if (!options.command) {
      result.exitCode = 0;
    } else {
      result.test = await runCommand({
        command: options.command,
        cwd: projectRoot,
        env: commandEnvironment(result, options, host !== null),
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
    }
  } catch (error) {
    result.failure = failure(error, result.run && options.command ? 'STIM_CI_TEST_FAILED' : 'STIM_CI_SETUP_FAILED');
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
    try {
      await host?.end();
    } catch (error) {
      result.cleanup.error ??= failure(error, 'STIM_CI_CLEANUP_FAILED');
    } finally {
      try {
        releaseEngine?.();
      } catch (error) {
        result.cleanup.error ??= failure(error, 'STIM_CI_CLEANUP_FAILED');
      }
    }
    if (result.cleanup.error && result.exitCode === 0) {
      result.exitCode = 1;
      result.failure = result.cleanup.error;
    }
    if (options.signal?.aborted && result.exitCode === 0) {
      result.exitCode = 130;
      result.failure = { code: 'STIM_CI_CANCELLED', message: 'CI run was cancelled.' };
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
  return `stim ci build ${flags.join(' ')}`;
}

export type { CommandResult } from './command.ts';

export { buildCI, type CIBuildOptions, type CIBuildResult } from './build.ts';

/** F3's per-op entry, the same function `stim` exports: runs one operation of `createStim(ctx)` in this build. */
export { runOp } from 'stim';
