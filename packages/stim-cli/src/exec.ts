import { type ChildProcess, type SpawnOptions, execSync } from 'child_process';
import spawn from 'cross-spawn';
import which from 'which';

interface ExecOptions {
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
  cwd?: string;
  env?: Record<string, string>;
  omitEnv?: readonly string[];
  /** Text written to the child's stdin; `runFile` only. */
  input?: string;
  /** `runFile` only: return stdout as written, without trimming surrounding whitespace. */
  untrimmed?: boolean;
}

export interface Executor {
  run(cmd: string, opts?: ExecOptions): string;
  runFile(file: string, args?: string[], opts?: ExecOptions): string;
  /** `runFile` without blocking the event loop; rejects where `runFile` throws. */
  runFileAsync(file: string, args?: string[], opts?: ExecOptions): Promise<string>;
  runQuiet(cmd: string, opts?: ExecOptions): string | null;
  runFileQuiet(file: string, args?: string[], opts?: ExecOptions): string | null;
  spawn(cmd: string, args?: readonly string[], opts?: SpawnOptions): ChildProcess;
  /** Absolute path of `name` on PATH, or null. Windows resolves PATH through PATHEXT. */
  findExecutable(name: string): string | null;
}

const MAX_BUFFER = 64 * 1024 * 1024;

function nameTimeout(error: unknown, command: string, timeoutMs: number | undefined): unknown {
  if ((error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT' && error instanceof Error) {
    error.message = `Command timed out after ${timeoutMs}ms: ${command}`;
  }
  return error;
}

const defaultExecutor: Executor = {
  run(cmd, { timeoutMs, killSignal, cwd } = {}) {
    const opts: Parameters<typeof execSync>[1] = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    if (killSignal) opts.killSignal = killSignal;
    if (cwd) opts.cwd = cwd;
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
  runFile(file, args = [], { timeoutMs, killSignal, cwd, env, omitEnv, input, untrimmed } = {}) {
    const opts: Parameters<typeof spawn.sync>[2] = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_BUFFER,
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    if (killSignal) opts.killSignal = killSignal;
    if (cwd) opts.cwd = cwd;
    if (input !== undefined) opts.input = input;
    if (env || omitEnv?.length) {
      const childEnv = { ...process.env, ...env };
      for (const key of omitEnv ?? []) delete childEnv[key];
      opts.env = childEnv;
    }
    const result = spawn.sync(file, args, opts);
    if (result.error) throw nameTimeout(Object.assign(result.error, result), [file, ...args].join(' '), timeoutMs);
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? '');
      const message = `Command failed: ${[file, ...args].join(' ')}${stderr ? `\n${stderr}` : ''}`;
      throw Object.assign(new Error(message), result);
    }
    return untrimmed ? String(result.stdout) : String(result.stdout).trim();
  },
  runFileAsync(file, args = [], { timeoutMs, killSignal, cwd, env, omitEnv } = {}) {
    const command = [file, ...args].join(' ');
    return new Promise((resolve, reject) => {
      const opts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] };
      if (cwd) opts.cwd = cwd;
      if (env || omitEnv?.length) {
        const childEnv = { ...process.env, ...env };
        for (const key of omitEnv ?? []) delete childEnv[key];
        opts.env = childEnv;
      }
      const child = spawn(file, args, opts);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill(killSignal ?? 'SIGTERM');
          }, timeoutMs)
        : undefined;
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        const out = Buffer.concat(stdout).toString('utf-8');
        const err = Buffer.concat(stderr).toString('utf-8');
        const result = { status, signal, stdout: out, stderr: err };
        if (timedOut) {
          reject(nameTimeout(Object.assign(new Error(command), result, { code: 'ETIMEDOUT' }), command, timeoutMs));
        } else if (status !== 0) {
          reject(Object.assign(new Error(`Command failed: ${command}${err ? `\n${err}` : ''}`), result));
        } else {
          resolve(out.trim());
        }
      });
    });
  },
  runQuiet(cmd, opts) {
    try {
      return this.run(cmd, opts);
    } catch {
      return null;
    }
  },
  runFileQuiet(file, args, opts) {
    try {
      return this.runFile(file, args, opts);
    } catch {
      return null;
    }
  },
  spawn(cmd, args = [], opts = {}) {
    return spawn(cmd, args, opts);
  },
  findExecutable(name) {
    return which.sync(name, { nothrow: true });
  },
};

// oxlint-disable-next-line typescript/no-explicit-any
export type MockExecutor = { [K in keyof Executor]?: (...args: any[]) => any };

let active: Executor = defaultExecutor;

export function setExecutor(e: MockExecutor): void {
  active = e as Executor;
}

export function resetExecutor(): void {
  active = defaultExecutor;
}

export function getExecutor(): Executor {
  return active;
}
