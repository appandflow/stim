import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './shell.mjs';

export function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const last = text.split('\n').findLast(Boolean);
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

export function stimEnvironment(home, extra = {}, parent = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(parent)) {
    if (key.startsWith('STIM_') || key === 'CI') continue;
    env[key] = value;
  }
  return { ...env, NO_COLOR: '1', FORCE_COLOR: '0', ...extra, STIM_HOME: home };
}

export function createStim({ cli, home, outDir, extraEnv = {}, signal }) {
  const env = stimEnvironment(home, extraEnv);
  const runsDir = join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  let seq = 0;

  async function exec(label, cwd, args, { timeoutMs = 30 * 60_000, uninterruptible = false } = {}) {
    const id = String(++seq).padStart(3, '0');
    const result = await run(process.execPath, [cli, ...args], {
      cwd,
      env,
      timeoutMs,
      signal: uninterruptible ? undefined : signal,
    });
    writeFileSync(join(runsDir, `${id}-${label}.out`), result.stdout);
    writeFileSync(join(runsDir, `${id}-${label}.err`), result.stderr);
    const json = parseJsonOutput(result.stdout);
    appendFileSync(
      join(runsDir, 'index.ndjson'),
      `${JSON.stringify({
        id,
        label,
        cwd,
        args,
        code: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        ms: result.ms,
        errorCode: json?.code ?? null,
      })}\n`,
    );
    return { ...result, id, label, args, cwd, json, ok: result.code === 0 };
  }

  async function status() {
    const result = await exec('status', outDir, ['status', '--json'], { timeoutMs: 180_000 });
    return { payload: result.ok ? result.json : null, startedAt: result.startedAt, endedAt: result.endedAt };
  }

  return { cli, home, env, exec, status };
}
