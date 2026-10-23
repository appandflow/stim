import { type ChildProcess, type SpawnOptions, execSync } from 'child_process';
import spawn from 'cross-spawn';
import which from 'which';
import { basename, delimiter, join, resolve as resolvePath } from 'path';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ambientEnv, ambientContext, type StimContext } from '@stim-cli/core';
import { spawnDeclared } from './engine/spawn-claims.ts';
import { operationState } from './engine/operation-state.ts';
import { WorkspaceProcessCleanupError } from './engine/workspace-process-lock.ts';
import { groupExitBudgetMs, waitForGroupExit } from './process-group-exit.ts';
import { redactArgv, redactCommandLine, trace } from '@stim-cli/core/state';
import { debugLog } from './debug-log.ts';
import { reportSignal, trackReportResource } from './report-runtime.ts';
import { captureProcessIdentity, inspectProcessIdentity } from './process-identity.ts';

export interface ExecOptions {
  /** Milliseconds before the child is killed, or 'unbounded' for a call that may legitimately run as long as it needs, such as a native build. */
  timeoutMs: number | 'unbounded';
  killSignal?: NodeJS.Signals;
  /** runFileAsync only: cancellation for this child; overrides the current report signal for bounded cleanup. */
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  omitEnv?: readonly string[];
  /** Text written to the child's stdin. */
  input?: string;
  /** `runFileAsync` only: called with the child right after it starts; a throw kills the child and rejects the call. */
  onSpawn?: (child: ChildProcess) => void;
  /** runFileAsync only: record this serialized child on the operation's active ownership claims. */
  declareFor?: StimContext;
  /** `runFile` and `runFileAsync`: return stdout as written, without trimming surrounding whitespace. */
  untrimmed?: boolean;
  /**
   * `runFile` and `runFileAsync`: reject nonempty stderr even when the command exits successfully.
   */
  rejectStderr?: boolean;
  /** `runFile` and `runFileAsync`: run in its own session with all stdio ignored and return ''; the child reports through a file, so a background process it leaves behind cannot hold a pipe open. */
  detachedSilent?: boolean;
  /** `runFileAsync` only: put the Windows child tree in a kill-on-close Job Object. */
  containProcessTree?: boolean;
  /** `runFileAsync` with a cancellation signal: begin verified tree cleanup at leader exit, before inherited pipes close. */
  cleanupOnExit?: boolean;
  /**
   * Exact values replaced with `***` in every string field of a thrown error.
   * Async calls that time out or overflow discard captured output when any nonempty redaction value is supplied.
   */
  redact?: readonly string[];
}

export interface Executor {
  run(cmd: string, opts: ExecOptions): string;
  runFile(file: string, args: string[], opts: ExecOptions): string;
  /** `runFile` without blocking the event loop; rejects where `runFile` throws. */
  runFileAsync(file: string, args: string[], opts: ExecOptions): Promise<string>;
  runQuiet(cmd: string, opts: ExecOptions): string | null;
  runFileQuiet(file: string, args: string[], opts: ExecOptions): string | null;
  /** `runFileQuiet` without blocking the event loop. */
  runFileQuietAsync(file: string, args: string[], opts: ExecOptions): Promise<string | null>;
  spawn(cmd: string, args?: readonly string[], opts?: SpawnOptions): ChildProcess;
  /** The cancellation signal of the current bounded report, including while a child is queued. */
  reportSignal?(): AbortSignal | undefined;
  /** Absolute path of `name` on PATH, or null. Options override the operation's cwd/environment; Windows uses PATHEXT. */
  findExecutable(name: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }): string | null;
}

const MAX_BUFFER = 64 * 1024 * 1024;
const REPORT_CHILD_EXIT_CAP_MS = 15_000;

// Windows PowerShell 5.1 took up to 9.5 s to start on a fresh GitHub-hosted runner and 2.2 s to exit after
// its child closed (#4102), so a contained child's budget covers only the child, between these markers.
const REPORT_JOB_PHASE_MS = 30_000;

interface ReportJobMarkers {
  started: string;
  closed: string;
}

function startsInReportJob(file: string, opts: SpawnOptions, containProcessTree: boolean): boolean {
  return (
    process.platform === 'win32' &&
    (containProcessTree || Boolean(reportSignal(ambientContext()))) &&
    Boolean(executableIn(file, opts.env ?? ambientEnv(), opts.cwd ?? process.cwd()))
  );
}

function spawnReportProbe(
  file: string,
  args: readonly string[],
  opts: SpawnOptions,
  containProcessTree = false,
): ChildProcess {
  return startsInReportJob(file, opts, containProcessTree) ? spawnReportJob(file, args, opts) : spawn(file, args, opts);
}

function spawnReportJob(
  file: string,
  args: readonly string[],
  opts: SpawnOptions,
  markers?: ReportJobMarkers,
): ChildProcess {
  const env = opts.env ?? ambientEnv();
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error('SystemRoot is required to contain Windows report probes.');
  return spawn(
    resolvePath(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('../dist/windows-report.ps1', import.meta.url)),
    ],
    {
      ...opts,
      windowsHide: true,
      env: {
        ...env,
        STIM_REPORT_CHILD: JSON.stringify({
          file,
          args,
          node: process.execPath,
          entry: fileURLToPath(new URL('../dist/windows-report.mjs', import.meta.url)),
          ...markers,
        }),
      },
    },
  );
}

function reportChild(
  child: ChildProcess,
  signal?: AbortSignal,
  failed?: (error: Error) => Error,
): { cancel: () => Promise<void>; closed: Promise<void> } | undefined {
  const context = ambientContext();
  const report = reportSignal(context);
  signal ??= report;
  if (!signal) return;
  let rejectClosed: (error: unknown) => void;
  let ended = false;
  let finishNativeClose: () => void;
  const nativeClosed = new Promise<void>((resolve) => {
    finishNativeClose = resolve;
  });
  const closed = new Promise<void>((resolve, reject) => {
    rejectClosed = reject;
    child.once('close', () => {
      ended = true;
      finishNativeClose();
      void cancel().then(resolve, reject);
    });
  });
  const pid = child.pid;
  const captured = pid === undefined ? null : captureProcessIdentity(pid);
  const observe = () => {
    if (pid === undefined) return 'gone';
    if (captured?.ok) return inspectProcessIdentity({ pid, processToken: captured.token });
    if (process.platform === 'win32') return ended ? 'gone' : 'unknown';
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return 'gone';
    }
    return 'unknown';
  };
  const refuse = (message: string): never => {
    const failure = Object.assign(new Error(message), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
      remedy: `Check whether the report child${pid === undefined ? '' : ` ${pid}${process.platform === 'win32' ? '' : ` (\`ps -p ${pid}\`)`}`} and its descendants are still running and stop them if they are`,
    });
    const error = failed?.(failure) ?? failure;
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    rejectClosed(error);
    throw error;
  };
  let cancelled: Promise<void> | undefined;
  const cancel = () =>
    (cancelled ??= (async () => {
      let identity = observe();
      if (pid !== undefined) {
        const deadline = performance.now() + 1000;
        while (identity === 'unknown' && performance.now() < deadline) {
          await delay(50);
          identity = observe();
        }
        if (identity === 'unknown') {
          refuse(`Cannot verify cleanup for report child ${pid}; its process or descendants were left untouched.`);
        }
      }
      if (
        pid !== undefined &&
        captured?.ok &&
        (identity === 'same' || (process.platform !== 'win32' && identity === 'gone'))
      ) {
        if (process.platform === 'win32') {
          if (report) {
            child.kill('SIGKILL');
          } else {
            // Windows taskkill /T reaches launcher children: https://learn.microsoft.com/windows-server/administration/windows-commands/taskkill
            const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
            const timer = setTimeout(() => killer.kill('SIGKILL'), 5000);
            await new Promise<void>((resolve) => {
              killer.once('error', () => child.kill('SIGKILL'));
              killer.once('close', (status) => {
                if (status !== 0) child.kill('SIGKILL');
                resolve();
              });
            });
            clearTimeout(timer);
          }
        } else {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (!ended) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          nativeClosed,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, groupExitBudgetMs(REPORT_CHILD_EXIT_CAP_MS));
          }),
        ]);
        clearTimeout(timer);
        if (!ended) await new Promise<void>((resolve) => setImmediate(resolve));
        if (!ended) refuse(`Report child ${pid} did not close within the cleanup budget.`);
      }
      if (
        pid !== undefined &&
        process.platform !== 'win32' &&
        !(await waitForGroupExit(pid, groupExitBudgetMs(REPORT_CHILD_EXIT_CAP_MS)))
      )
        refuse(`Report child ${pid} still has descendants after cleanup.`);
    })());
  if (report) trackReportResource(context, closed, cancel, signal);
  else {
    const abort = () => {
      void cancel().catch(() => {});
    };
    const callerSignal = signal;
    callerSignal.addEventListener('abort', abort, { once: true });
    const settled = () => callerSignal.removeEventListener('abort', abort);
    void closed.then(settled, settled);
    if (callerSignal.aborted) abort();
  }
  return { cancel, closed };
}

function budgetMs(timeoutMs: ExecOptions['timeoutMs']): number | undefined {
  if (timeoutMs === 'unbounded') return undefined;
  if (!(timeoutMs > 0))
    throw new RangeError(`timeoutMs must be a positive number of milliseconds or 'unbounded', got ${timeoutMs}`);
  return timeoutMs;
}

/** Whether an exec error is a child killed for exceeding its `timeoutMs`. */
export function isTimeoutError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ETIMEDOUT';
}

function nameTimeout(error: unknown, command: string, timeoutMs: ExecOptions['timeoutMs']): unknown {
  if ((error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT' && error instanceof Error) {
    error.message = `Command timed out after ${timeoutMs}ms: ${command}`;
  }
  return error;
}

const WINDOWS_BATCH_FILE = /\.(?:bat|cmd)$/i;
const BATCH_UNSAFE_ARGUMENT = /["\r\n]/;

// cross-spawn runs a .bat/.cmd target through `cmd.exe /d /s /c` with escaping the batch file's own
// %* expansion undoes (moxystudio/node-cross-spawn#171). A quote or line break lets `&`/`|` escape it;
// `%` is left through because cross-spawn already escapes it as `^%` and URL-encoded arguments need it.
export function isUnsafeBatchSpawn(
  target: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && WINDOWS_BATCH_FILE.test(target) && args.some((arg) => BATCH_UNSAFE_ARGUMENT.test(arg));
}

function executableIn(file: string, env: NodeJS.ProcessEnv, cwd: string | URL): string | null {
  const windows = process.platform === 'win32';
  const value = (name: string) =>
    env[name] ??
    (windows
      ? Object.entries(env).find(([key, field]) => field !== undefined && key.toUpperCase() === name)?.[1]
      : undefined);
  const directory = typeof cwd === 'string' ? cwd : fileURLToPath(cwd);
  const path = file.includes('/') || (windows && file.includes('\\'));
  const directories = path ? [''] : (value('PATH') ?? '').split(delimiter);
  if (windows && !path) directories.unshift(directory);
  // node-which#6 prepends process.cwd() on Windows; absolute candidates preserve the client's directory.
  // https://github.com/npm/node-which/issues/6
  for (const entry of directories) {
    const candidate = resolvePath(directory, entry.replace(/^"(.*)"$/, '$1'), file);
    const found = which.sync(candidate, { nothrow: true, path: '', pathExt: value('PATHEXT') ?? '' });
    if (found) return found;
  }
  return null;
}

function refuseUnsafeBatchArguments(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = ambientEnv(),
  cwd: string | URL = ambientContext()?.cwd ?? process.cwd(),
): void {
  if (process.platform !== 'win32') return;
  const target = executableIn(file, env, cwd) ?? file;
  if (isUnsafeBatchSpawn(target, args)) {
    throw new Error(
      `Refusing to run ${basename(target)}: an argument contains a character cmd.exe could misinterpret (a double quote or a line break).`,
    );
  }
}

function redactError<T>(error: T, values: readonly string[] | undefined): T {
  const secrets = values?.filter(Boolean) ?? [];
  if (secrets.length === 0 || !error || typeof error !== 'object') return error;
  const scrub = (text: string) => secrets.reduce((acc, secret) => acc.split(secret).join('***'), text);
  const fields = error as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(error)) {
    const value = fields[key];
    if (typeof value === 'string') fields[key] = scrub(value);
    else if (Array.isArray(value))
      fields[key] = value.map((item: unknown) => (typeof item === 'string' ? scrub(item) : item));
  }
  return error;
}

const defaultExecutor: Executor = {
  reportSignal: () => reportSignal(ambientContext()),
  run(cmd, { timeoutMs, killSignal, cwd, env }) {
    const opts: Parameters<typeof execSync>[1] = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    };
    const timeout = budgetMs(timeoutMs);
    if (timeout !== undefined) opts.timeout = timeout;
    if (killSignal) opts.killSignal = killSignal;
    const childCwd = cwd ?? ambientContext()?.cwd;
    if (childCwd) opts.cwd = childCwd;
    if (env || ambientContext()) opts.env = { ...ambientEnv(), ...env };
    try {
      return String(execSync(cmd, opts)).trim();
    } catch (error) {
      throw nameTimeout(error, cmd, timeoutMs);
    }
  },
  // spawnSync through cross-spawn rather than execFileSync: on Windows Node
  // refuses .cmd/.bat files and shebang scripts without a shell, and every
  // package bin (eas, agent-device) is one of those. The throw matches
  // execFileSync's, so callers keep reading status, stdout and stderr off it.
  runFile(
    file,
    args = [],
    { timeoutMs, killSignal, cwd, env, omitEnv, input, untrimmed, rejectStderr, detachedSilent, redact },
  ) {
    const opts: NonNullable<Parameters<typeof spawn.sync>[2]> & { detached?: boolean } = {
      encoding: 'utf-8',
      stdio: detachedSilent ? 'ignore' : ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    };
    if (detachedSilent) opts.detached = true;
    const timeout = budgetMs(timeoutMs);
    if (timeout !== undefined) opts.timeout = timeout;
    if (killSignal) opts.killSignal = killSignal;
    const childCwd = cwd ?? ambientContext()?.cwd;
    if (childCwd) opts.cwd = childCwd;
    if (input !== undefined) opts.input = input;
    if (env || omitEnv?.length || ambientContext()) {
      const childEnv = { ...ambientEnv(), ...env };
      for (const key of omitEnv ?? []) delete childEnv[key];
      opts.env = childEnv;
    }
    refuseUnsafeBatchArguments(file, args, opts.env, opts.cwd);
    const result = spawn.sync(file, args, opts);
    if (result.error) {
      throw redactError(nameTimeout(Object.assign(result.error, result), [file, ...args].join(' '), timeoutMs), redact);
    }
    if (result.status !== 0 || (rejectStderr && String(result.stderr ?? '').trim())) {
      const stderr = String(result.stderr ?? '');
      const message = `Command failed: ${[file, ...args].join(' ')}${stderr ? `\n${stderr}` : ''}`;
      throw redactError(Object.assign(new Error(message), result), redact);
    }
    if (detachedSilent) return '';
    return untrimmed ? String(result.stdout) : String(result.stdout).trim();
  },
  runFileAsync(
    file,
    args = [],
    {
      timeoutMs,
      killSignal,
      cwd,
      env,
      omitEnv,
      input,
      untrimmed,
      rejectStderr,
      onSpawn,
      declareFor,
      detachedSilent,
      containProcessTree,
      cleanupOnExit,
      redact,
      signal: callSignal,
    },
  ) {
    const command = [file, ...args].join(' ');
    return new Promise((resolve, reject) => {
      const report = callSignal ?? reportSignal(ambientContext());
      report?.throwIfAborted();
      const timeout = budgetMs(timeoutMs);
      const opts: SpawnOptions = detachedSilent
        ? { stdio: 'ignore', detached: true }
        : { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] };
      if (report && process.platform !== 'win32') opts.detached = true;
      const childCwd = cwd ?? ambientContext()?.cwd;
      if (childCwd) opts.cwd = childCwd;
      if (env || omitEnv?.length || ambientContext()) {
        const childEnv = { ...ambientEnv(), ...env };
        for (const key of omitEnv ?? []) delete childEnv[key];
        opts.env = childEnv;
      }
      refuseUnsafeBatchArguments(file, args, opts.env, opts.cwd);
      const claims = declareFor ? [...operationState(declareFor).declaring] : [];
      let clearDeclaration: (() => void) | undefined;
      let retainDeclaration: ((error: unknown) => void) | undefined;
      const declaration =
        claims.length > 0 && report
          ? new Promise<void>((resolveDeclaration, rejectDeclaration) => {
              clearDeclaration = resolveDeclaration;
              retainDeclaration = rejectDeclaration;
            })
          : undefined;
      const contained = startsInReportJob(file, opts, containProcessTree || Boolean(report));
      const base =
        contained && timeout !== undefined ? join(tmpdir(), `stim-report-${process.pid}-${randomUUID()}`) : null;
      const markers = base ? { started: `${base}.started`, closed: `${base}.closed` } : undefined;
      const start = () => (contained ? spawnReportJob(file, args, opts, markers) : spawn(file, args, opts));
      const child = declareFor ? spawnDeclared(declareFor, start, declaration ? { until: declaration } : {}) : start();
      let lifetime: ReturnType<typeof reportChild>;
      let cancel: (() => Promise<void>) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      let phase: 'starting' | 'running' | 'closing' = markers ? 'starting' : 'running';
      const stopTimers = () => {
        clearTimeout(timer);
        clearInterval(poll);
        for (const marker of Object.values(markers ?? {})) {
          try {
            rmSync(marker, { force: true });
          } catch {}
        }
      };
      try {
        lifetime = reportChild(child, report, (error) => {
          const failure = claims.length
            ? Object.assign(
                new WorkspaceProcessCleanupError(
                  claims,
                  error.message,
                  'Verify the child and its descendants have stopped.',
                ),
                { reportCleanup: true },
              )
            : error;
          stopTimers();
          return failure;
        });
        cancel = lifetime?.cancel;
        if (cleanupOnExit && cancel)
          child.once('exit', () => {
            stopTimers();
            void cancel?.().catch(reject);
          });
        void lifetime?.closed.catch(reject);
        if (declaration) void lifetime?.closed.then(clearDeclaration, retainDeclaration);
        onSpawn?.(child);
      } catch (error) {
        stopTimers();
        if (cancel)
          void cancel()
            .then(() => lifetime?.closed)
            .then(() => reject(error), reject);
        else {
          if (!report) child.kill('SIGKILL');
          reject(error);
        }
        return;
      }
      if (input !== undefined) {
        child.stdin?.on('error', () => {});
        child.stdin?.end(input);
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let overflowed = false;
      let bufferedBytes = 0;
      const capture = (chunks: Buffer[], chunk: Buffer) => {
        if (overflowed) return;
        const remaining = MAX_BUFFER - bufferedBytes;
        if (chunk.length <= remaining) {
          chunks.push(chunk);
          bufferedBytes += chunk.length;
        } else {
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          bufferedBytes = MAX_BUFFER;
          overflowed = true;
          if (cancel) void cancel().catch(reject);
          else {
            child.kill('SIGKILL');
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
          }
        }
      };
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          clearInterval(poll);
          if (cancel) void cancel().catch(reject);
          else {
            child.kill(killSignal ?? 'SIGTERM');
            child.stdin?.destroy();
            child.stdout?.destroy();
            child.stderr?.destroy();
          }
        }, ms);
      };
      if (timeout !== undefined && markers) {
        arm(REPORT_JOB_PHASE_MS);
        poll = setInterval(() => {
          if (phase === 'starting' && existsSync(markers.started)) {
            phase = 'running';
            arm(timeout);
          }
          if (phase === 'running' && existsSync(markers.closed)) {
            phase = 'closing';
            arm(REPORT_JOB_PHASE_MS);
            clearInterval(poll);
          }
        }, 50);
      } else if (timeout !== undefined) arm(timeout);
      child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
      child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));
      child.on('error', (error) => {
        stopTimers();
        reject(redactError(error, redact));
      });
      const finish = async (status: number | null, signal: NodeJS.Signals | null): Promise<void> => {
        stopTimers();
        await lifetime?.closed;
        const discardOutput = (timedOut || overflowed || report?.aborted) && redact?.some(Boolean);
        const out = discardOutput ? '' : Buffer.concat(stdout).toString('utf-8');
        const err = discardOutput ? '' : Buffer.concat(stderr).toString('utf-8');
        const result = { status, signal, stdout: out, stderr: err };
        if (report?.aborted) reject(report.reason);
        else if (timedOut && phase !== 'running') {
          const message = `The Windows report job did not ${phase === 'starting' ? 'start' : 'exit'} within ${REPORT_JOB_PHASE_MS}ms: ${command}`;
          reject(redactError(Object.assign(new Error(message), result, { code: 'ETIMEDOUT' }), redact));
        } else if (timedOut) {
          reject(
            redactError(
              nameTimeout(Object.assign(new Error(command), result, { code: 'ETIMEDOUT' }), command, timeoutMs),
              redact,
            ),
          );
        } else if (overflowed) {
          reject(
            redactError(
              Object.assign(new Error(`Command output exceeded ${MAX_BUFFER} bytes: ${command}`), result, {
                code: 'ENOBUFS',
              }),
              redact,
            ),
          );
        } else if (status !== 0 || (rejectStderr && err.trim())) {
          reject(
            redactError(Object.assign(new Error(`Command failed: ${command}${err ? `\n${err}` : ''}`), result), redact),
          );
        } else {
          resolve(detachedSilent ? '' : untrimmed ? out : out.trim());
        }
      };
      child.on('close', (status, signal) => {
        void finish(status, signal).catch(reject);
      });
    });
  },
  runQuiet(cmd, opts) {
    budgetMs(opts.timeoutMs);
    try {
      return this.run(cmd, opts);
    } catch {
      return null;
    }
  },
  runFileQuiet(file, args, opts) {
    budgetMs(opts.timeoutMs);
    try {
      return this.runFile(file, args, opts);
    } catch {
      return null;
    }
  },
  runFileQuietAsync(file, args, opts) {
    budgetMs(opts.timeoutMs);
    return this.runFileAsync(file, args, opts).catch(() => null);
  },
  spawn(cmd, args = [], opts = {}) {
    const report = reportSignal(ambientContext());
    report?.throwIfAborted();
    const context = ambientContext();
    const childOpts = context ? { ...opts, cwd: opts.cwd ?? context.cwd, env: opts.env ?? context.env } : opts;
    if (report && process.platform !== 'win32') childOpts.detached = true;
    refuseUnsafeBatchArguments(cmd, args, childOpts.env ?? ambientEnv(), childOpts.cwd);
    const claims = report ? [...operationState(context).declaring] : [];
    const child = spawnReportProbe(cmd, args, childOpts);
    reportChild(child, undefined, (error) =>
      claims.length
        ? Object.assign(
            new WorkspaceProcessCleanupError(
              claims,
              error.message,
              'Verify the child and its descendants have stopped.',
            ),
            { reportCleanup: true },
          )
        : error,
    );
    return child;
  },
  findExecutable(name, options = {}) {
    return executableIn(name, options.env ?? ambientEnv(), options.cwd ?? ambientContext()?.cwd ?? process.cwd());
  },
};

/** The program a call runs, without its arguments: those can carry tokens. */
const programOf = (command: string): string => basename(command.trim().split(/\s+/)[0] ?? '');

function outcomeOf(error: unknown): Record<string, unknown> {
  const { status, signal, code } = (error ?? {}) as { status?: number | null; signal?: string | null; code?: string };
  return {
    ok: false,
    ...(typeof status === 'number' ? { exit: status } : {}),
    ...(signal ? { signal } : {}),
    ...(code ? { code } : {}),
  };
}

let executionId = 0;

interface ChildSpan {
  name: string;
  args: Record<string, unknown>;
}

function fileSpan(file: string, args: readonly string[] | undefined, opts: ExecOptions): ChildSpan {
  const program = basename(file);
  const argv = redactArgv(args ?? [], opts.redact);
  const first = argv[0];
  return {
    name: first && /^[a-z][a-z0-9-]{1,23}$/.test(first) ? `${program} ${first}` : program,
    args: {
      argv: [file, ...argv],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    },
  };
}

function commandSpan(cmd: string, opts: ExecOptions): ChildSpan {
  return {
    name: programOf(cmd.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')).replace(/["']/g, ''),
    args: { command: redactCommandLine(cmd, opts.redact), ...(opts.cwd ? { cwd: opts.cwd } : {}) },
  };
}

function timedSync<A extends unknown[]>(
  fn: (...args: A) => string,
  program: (...args: A) => string,
  span: (...args: A) => ChildSpan,
): (...args: A) => string {
  return (...args) => {
    const logging = debugLog.enabled();
    const tracing = trace.enabled();
    if (!logging && !tracing) return fn(...args);
    const id = ++executionId;
    const name = program(...args);
    const started = performance.now();
    const traced = tracing ? span(...args) : null;
    const end = traced ? trace.beginExec(traced.name, traced.args) : null;
    debugLog.log('exec.start', { program: name, executionId: id });
    try {
      const out = fn(...args);
      debugLog.log('exec', { program: name, executionId: id, ms: Math.round(performance.now() - started), ok: true });
      end?.({ ok: true });
      return out;
    } catch (error) {
      debugLog.log('exec', {
        program: name,
        executionId: id,
        ms: Math.round(performance.now() - started),
        ...outcomeOf(error),
      });
      end?.(outcomeOf(error));
      throw error;
    }
  };
}

const debugExecutor: Executor = {
  ...defaultExecutor,
  run: timedSync(
    (cmd: string, opts: ExecOptions) => defaultExecutor.run(cmd, opts),
    programOf,
    (cmd, opts) => commandSpan(cmd, opts),
  ),
  runFile: timedSync(
    (file: string, args: string[], opts: ExecOptions) => defaultExecutor.runFile(file, args, opts),
    (file) => basename(file),
    (file, args, opts) => fileSpan(file, args, opts),
  ),
  async runFileAsync(file, args, opts) {
    const logging = debugLog.enabled();
    const tracing = trace.enabled();
    if (!logging && !tracing) return defaultExecutor.runFileAsync(file, args, opts);
    const id = ++executionId;
    const name = basename(file);
    const started = performance.now();
    const traced = tracing ? fileSpan(file, args, opts) : null;
    const end = traced ? trace.beginExec(traced.name, traced.args) : null;
    debugLog.log('exec.start', { program: name, executionId: id });
    try {
      const out = await defaultExecutor.runFileAsync(file, args, opts);
      debugLog.log('exec', { program: name, executionId: id, ms: Math.round(performance.now() - started), ok: true });
      end?.({ ok: true });
      return out;
    } catch (error) {
      debugLog.log('exec', {
        program: name,
        executionId: id,
        ms: Math.round(performance.now() - started),
        ...outcomeOf(error),
      });
      end?.(outcomeOf(error));
      throw error;
    }
  },
  spawn(cmd, args, opts) {
    const child = defaultExecutor.spawn(cmd, args, opts);
    if (!trace.enabled()) return child;
    const { name, args: spanArgs } = fileSpan(cmd, args, {
      timeoutMs: 'unbounded',
      ...(typeof opts?.cwd === 'string' ? { cwd: opts.cwd } : {}),
    });
    const end = trace.beginExec(name, { ...spanArgs, spawned: true });
    child.once('close', (exit, signal) =>
      end({ ok: exit === 0, ...(exit !== null ? { exit } : {}), ...(signal ? { signal } : {}) }),
    );
    return child;
  },
};

// oxlint-disable-next-line typescript/no-explicit-any
export type MockExecutor = { [K in keyof Executor]?: (...args: any[]) => any };

let active: Executor = debugExecutor;

const derivedAsync = new WeakSet<object>();

/**
 * @internal Test seam that swaps the process executor. A mock without the async methods, or one spread from another
 * mock, answers `runFileAsync` from its own `runFile` and `runFileQuietAsync` from its own `runFileQuiet`.
 */
export function setExecutor(e: MockExecutor): void {
  if (e.runFile && (!e.runFileAsync || derivedAsync.has(e.runFileAsync))) {
    e.runFileAsync = async (...args: Parameters<Executor['runFile']>) => {
      if (!e.runFile) throw new Error('the mock executor has no runFile');
      return e.runFile(...args);
    };
    derivedAsync.add(e.runFileAsync);
  }
  if (e.runFileQuiet && (!e.runFileQuietAsync || derivedAsync.has(e.runFileQuietAsync))) {
    e.runFileQuietAsync = async (...args: Parameters<Executor['runFileQuiet']>) => {
      if (!e.runFileQuiet) throw new Error('the mock executor has no runFileQuiet');
      return e.runFileQuiet(...args);
    };
    derivedAsync.add(e.runFileQuietAsync);
  }
  active = e as Executor;
}

/** @internal Test seam that restores the process executor. */
export function resetExecutor(): void {
  active = debugExecutor;
}

export function getExecutor(): Executor {
  return active;
}
