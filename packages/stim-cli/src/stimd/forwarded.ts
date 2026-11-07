import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { configDir, withAmbientContext } from '@stim-cli/core';
import { dirname, isAbsolute } from 'node:path';
import { coerceSettingText, SETTINGS, settingValueError } from '@stim-cli/core/state';

const ENV_LIMIT = 512 * 1024;
const secretNames = new Set(
  SETTINGS.filter((setting) => setting.sensitive && setting.env).map((setting) => setting.env),
);

export type Forwarded = { cwd: string; env: Record<string, string> };
export type Override = { value: unknown; raw: string; error?: string };
export type Invocation = { forwarded: Forwarded; overrides: Record<string, Override> };

export function invocation(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Invocation | { code: string; message: string; remedy: string } {
  if (!isAbsolute(cwd))
    return {
      code: 'STIM_BAD_ARG',
      message: 'The invocation cwd must be absolute.',
      remedy: 'Use an absolute working directory.',
    };
  const forwarded: Forwarded = { cwd, env: Object.create(null) };
  for (const [name, value] of Object.entries(env)) {
    const checkedName = process.platform === 'win32' ? name.toUpperCase() : name;
    if (
      value === undefined ||
      secretNames.has(checkedName) ||
      checkedName.startsWith('STIM_PARENT_') ||
      checkedName.startsWith('STIM_LOCAL_KEY')
    )
      continue;
    forwarded.env[name] = value;
  }
  if (Buffer.byteLength(JSON.stringify(forwarded.env)) > ENV_LIMIT) {
    const largest = Object.entries(forwarded.env)
      .toSorted((a, b) => Buffer.byteLength(b[1]) - Buffer.byteLength(a[1]))
      .slice(0, 5)
      .map(([name]) => name);
    return {
      code: 'STIM_ENV_TOO_LARGE',
      message: `The forwarded environment exceeds 512 KB. Largest variables: ${largest.join(', ')}.`,
      remedy: 'Reduce the environment and rerun the command.',
    };
  }
  const overrides: Record<string, Override> = {};
  const envByName =
    process.platform === 'win32'
      ? Object.fromEntries(Object.entries(env).map(([name, value]) => [name.toUpperCase(), value]))
      : env;
  for (const setting of SETTINGS) {
    if (!setting.env || setting.sensitive) continue;
    const raw = envByName[setting.env];
    if (raw === undefined || raw === '') continue;
    const value = coerceSettingText(setting, raw.trim());
    const error = settingValueError(setting, value);
    overrides[setting.key] = { value, raw, ...(error ? { error } : {}) };
  }
  if (envByName.STIM_TRACE) {
    if (!isAbsolute(envByName.STIM_TRACE))
      return {
        code: 'STIM_BAD_ARG',
        message: 'STIM_TRACE must be an absolute path.',
        remedy: 'Set STIM_TRACE to an absolute path.',
      };
    overrides.STIM_TRACE = { value: envByName.STIM_TRACE, raw: envByName.STIM_TRACE };
  }
  if (envByName.STIM_RUN_ID) overrides.STIM_RUN_ID = { value: envByName.STIM_RUN_ID, raw: envByName.STIM_RUN_ID };
  return { forwarded, overrides };
}

export function withInvocation<T>(context: Invocation & { workspace: string }, signal: AbortSignal, work: () => T): T {
  const env =
    process.platform === 'win32'
      ? Object.fromEntries(Object.entries(context.forwarded.env).map(([name, value]) => [name.toUpperCase(), value]))
      : context.forwarded.env;
  return withAmbientContext(
    {
      home: configDir(),
      buildCache: env.STIM_BUILD_CACHE ?? null,
      projectRoot: context.workspace,
      env,
      cwd: context.forwarded.cwd,
      runId: context.overrides.STIM_RUN_ID?.raw ?? '',
      signal,
      output: () => {},
    },
    work,
  );
}

function appendTrace(path: string, name: string, started: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, '[\n', { flag: 'wx' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const ended = Math.round((performance.timeOrigin + performance.now()) * 1000);
    appendFileSync(
      path,
      `${JSON.stringify({ name, cat: 'stimd', ph: 'X', ts: started, dur: ended - started, tid: 1, pid: process.pid })},\n`,
    );
  } catch {}
}

export async function traceInvocation<T>(context: Invocation, name: string, work: () => Promise<T>): Promise<T> {
  const path = context.overrides.STIM_TRACE?.raw;
  if (!path) return work();
  const started = Math.round((performance.timeOrigin + performance.now()) * 1000);
  try {
    return await work();
  } finally {
    appendTrace(path, name, started);
  }
}
