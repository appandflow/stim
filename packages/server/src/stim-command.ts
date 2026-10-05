import { spawn, type ChildProcess } from 'node:child_process';

export type CommandOutcome =
  | { ok: true; stdout: string }
  | { ok: false; message: string; stdout?: string; exitCode?: number | null };

export interface CommandLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

const STDERR_TAIL = 2000;
const KILL_GRACE_MS = 1000;

export function terminate(child: ChildProcess, cooperative = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (cooperative && child.connected) child.send('cancel', () => {});
  else child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', done);
    child.once('close', done);
  });
}

/** Work that may still run a child process after nothing else references it, so `close()` can wait for it. */
export class Pending {
  private readonly promises = new Set<Promise<unknown>>();

  track<T>(promise: Promise<T>): Promise<T> {
    this.promises.add(promise);
    const forget = () => this.promises.delete(promise);
    promise.then(forget, forget);
    return promise;
  }

  async settled(): Promise<void> {
    while (this.promises.size) await Promise.allSettled(this.promises);
  }
}

export function runFileCommand(
  file: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  cwd: string,
  limits: CommandLimits,
  label: string,
  cooperative = false,
): { outcome: Promise<CommandOutcome>; cancel: () => Promise<void> } {
  const child = spawn(file, args, {
    cwd,
    env,
    stdio: cooperative ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  let cancelled = false;
  let failure: string | null = null;
  const chunks: Buffer[] = [];
  let size = 0;
  let stderr = '';
  const release = () => {
    child.stdout!.destroy();
    child.stderr!.destroy();
  };
  const fail = (message: string) => {
    if (failure) return;
    failure = message;
    release();
    void terminate(child, cooperative);
  };
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return release();
    fail(`${label} did not finish within ${limits.timeoutMs / 1000} s.`);
  }, limits.timeoutMs);
  child.stdout!.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limits.maxOutputBytes) return fail(`${label} printed more than ${limits.maxOutputBytes} bytes.`);
    chunks.push(chunk);
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  const outcome = new Promise<CommandOutcome>((resolve) => {
    const settle = (result: CommandOutcome) => {
      clearTimeout(timer);
      if (!cancelled) resolve(result);
    };
    child.on('error', (error) => settle({ ok: false, message: `${label} could not start (${error.message}).` }));
    child.on('close', (code, signal) => {
      if (failure) return settle({ ok: false, message: failure });
      if (code === 0) return settle({ ok: true, stdout: Buffer.concat(chunks).toString('utf8') });
      const detail = stderr.trim();
      settle({
        ok: false,
        message: `${label} exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ''}`,
        exitCode: code,
        stdout: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });
  return {
    outcome,
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
      return terminate(child, cooperative);
    },
  };
}

export function runNodeCommand(
  entry: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  cwd: string,
  limits: CommandLimits,
  label: string,
  cooperative = false,
): ReturnType<typeof runFileCommand> {
  return runFileCommand(process.execPath, env, [entry, ...args], cwd, limits, label, cooperative);
}

export function runStim(
  stimCli: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  cwd: string,
  limits: CommandLimits,
): ReturnType<typeof runNodeCommand> {
  return runNodeCommand(stimCli, env, args, cwd, limits, `stim ${args[0]}`);
}
