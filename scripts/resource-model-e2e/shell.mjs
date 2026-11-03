import { spawn } from 'node:child_process';

export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export const C_LOCALE = () => ({ ...process.env, LC_ALL: 'C' });

export const shq = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

export function run(cmd, args = [], { cwd, env, timeoutMs = 0, input, signal } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal: sig,
        stdout,
        stderr,
        startedAt,
        endedAt: Date.now(),
        ms: Date.now() - startedAt,
        timedOut,
      });
    };
    const stop = () => {
      if (!child?.pid) return;
      killGroup(child.pid, 'SIGTERM');
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref();
    };
    const onAbort = () => stop();
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs)
      : undefined;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        detached: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      stderr = String(error?.message ?? error);
      return finish(-1, null);
    }
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      stderr += String(error?.message ?? error);
      finish(-1, null);
    });
    child.on('close', (code, sig) => finish(code ?? -1, sig));
    if (input !== undefined) child.stdin.end(input);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pool(items, limit, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}
