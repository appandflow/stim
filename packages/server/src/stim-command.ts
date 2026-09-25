import { spawn } from 'node:child_process';

export type CommandOutcome = { ok: true; stdout: string } | { ok: false; message: string };

export interface CommandLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

const STDERR_TAIL = 2000;

/** Runs one `stim` command to completion. `cancel` kills it, and the outcome then never settles. */
export function runStim(
  stimCli: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  cwd: string,
  limits: CommandLimits,
): { outcome: Promise<CommandOutcome>; cancel: () => void } {
  const child = spawn(process.execPath, [stimCli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const label = `stim ${args[0]}`;
  let cancelled = false;
  let failure: string | null = null;
  const chunks: Buffer[] = [];
  let size = 0;
  let stderr = '';
  const fail = (message: string) => {
    failure ??= message;
    child.kill('SIGTERM');
  };
  const timer = setTimeout(
    () => fail(`${label} did not finish within ${limits.timeoutMs / 1000} s.`),
    limits.timeoutMs,
  );
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limits.maxOutputBytes) return fail(`${label} printed more than ${limits.maxOutputBytes} bytes.`);
    chunks.push(chunk);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
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
      settle({ ok: false, message: `${label} exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ''}` });
    });
  });
  return {
    outcome,
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
    },
  };
}
