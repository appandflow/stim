import { spawn, type ChildProcess } from 'node:child_process';

export type CommandOutcome = { ok: true; stdout: string } | { ok: false; message: string; stdout?: string };

export interface CommandLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

const STDERR_TAIL = 2000;
const KILL_GRACE_MS = 1000;

export function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
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

export function runStim(
  stimCli: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  cwd: string,
  limits: CommandLimits,
): { outcome: Promise<CommandOutcome>; cancel: () => Promise<void> } {
  const child = spawn(process.execPath, [stimCli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const label = `stim ${args[0]}`;
  let cancelled = false;
  const chunks: Buffer[] = [];
  let size = 0;
  let stderr = '';
  let resolveOutcome!: (result: CommandOutcome) => void;
  const outcome = new Promise<CommandOutcome>((resolve) => (resolveOutcome = resolve));
  const settle = (result: CommandOutcome) => {
    clearTimeout(timer);
    if (!cancelled) resolveOutcome(result);
  };
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (code === 0) return settle({ ok: true, stdout: Buffer.concat(chunks).toString('utf8') });
    const detail = stderr.trim();
    settle({
      ok: false,
      message: `${label} exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ''}`,
      stdout: Buffer.concat(chunks).toString('utf8'),
    });
  };
  const release = () => {
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const fail = (message: string) => {
    release();
    settle({ ok: false, message });
    void terminate(child);
  };
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      release();
      return finish(child.exitCode, child.signalCode);
    }
    fail(`${label} did not finish within ${limits.timeoutMs / 1000} s.`);
  }, limits.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limits.maxOutputBytes) return fail(`${label} printed more than ${limits.maxOutputBytes} bytes.`);
    chunks.push(chunk);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  child.on('error', (error) => settle({ ok: false, message: `${label} could not start (${error.message}).` }));
  child.on('close', finish);
  return {
    outcome,
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
      return terminate(child);
    },
  };
}
