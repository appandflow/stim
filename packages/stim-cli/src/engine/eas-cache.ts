import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { isJsonObject } from '@stim-cli/core/state';
import { getExecutor, isTimeoutError } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { runCancellationSignal } from './native-run.ts';

interface EasCacheOptions {
  file: string;
  projectRoot: string;
  platform?: string | null;
  fingerprintHash: string;
  runOptions: Record<string, unknown>;
  buildPath?: string;
  timeoutMs: number;
  context?: StimContext;
  logWriter?: NdjsonWriter | null;
  note?: (line: string) => void;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function jsonString(stdout: string, field: string): string | null {
  const value: unknown = JSON.parse(stdout);
  if (!isJsonObject(value)) return null;
  const answer = value[field];
  return typeof answer === 'string' && answer.trim() ? answer.trim() : null;
}

async function devClient(
  projectRoot: string,
  options: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  const pkg: unknown = JSON.parse(await readFile(join(projectRoot, 'package.json'), { encoding: 'utf8', signal }));
  if (!isJsonObject(pkg)) return false;
  const installed =
    (isJsonObject(pkg.dependencies) && Boolean(pkg.dependencies['expo-dev-client'])) ||
    (isJsonObject(pkg.devDependencies) && Boolean(pkg.devDependencies['expo-dev-client']));
  if (!installed) return false;
  if (options.variant !== undefined) return options.variant === 'debug';
  if (options.configuration !== undefined) return options.configuration === 'Debug';
  return true;
}

export async function easCache(
  phase: 'resolve' | 'upload',
  options: EasCacheOptions,
): Promise<{ appPath?: string; uploaded?: true; destination?: string; failed?: string } | null> {
  const { file, projectRoot, platform, context, timeoutMs, logWriter, note } = options;
  const signal = runCancellationSignal(context) ?? context?.signal;
  const deadline = performance.now() + timeoutMs;
  const report = (line: string) => {
    logWriter?.write({ src: 'build', level: 'debug', event: 'provider', msg: line });
    if (note) note(line);
    else context?.output('stderr', `${line}\n`);
  };
  const command = async (args: string[]): Promise<string> => {
    signal?.throwIfAborted();
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw Object.assign(new Error('EAS cache deadline exceeded'), { code: 'ETIMEDOUT' });
    let cancel: (() => void) | undefined;
    try {
      return await getExecutor().runFileAsync(file, args, {
        cwd: projectRoot,
        timeoutMs: remaining,
        killSignal: 'SIGKILL',
        ...(context
          ? {
              env: Object.fromEntries(
                Object.entries(context.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
              ),
              redact: context.env.EXPO_TOKEN ? [context.env.EXPO_TOKEN] : [],
            }
          : {}),
        onSpawn: (child) => {
          cancel = () => {
            child.kill('SIGKILL');
          };
          signal?.addEventListener('abort', cancel, { once: true });
          if (signal?.aborted) cancel();
        },
      });
    } finally {
      if (cancel) signal?.removeEventListener('abort', cancel);
      signal?.throwIfAborted();
    }
  };
  try {
    signal?.throwIfAborted();
    if (!(await fileExists(join(projectRoot, 'eas.json')))) return null;
    let hash = options.fingerprintHash;
    try {
      const generated = await command([
        'fingerprint:generate',
        `--platform=${platform}`,
        '--json',
        '--non-interactive',
      ]);
      hash = jsonString(generated, 'hash') ?? hash;
    } catch (error) {
      signal?.throwIfAborted();
      if (isTimeoutError(error)) throw error;
    }
    if (phase === 'resolve') {
      report('Searching the EAS build cache');
      const stdout = await command([
        'build:download',
        `--platform=${platform}`,
        `--fingerprint=${hash}`,
        '--non-interactive',
        (await devClient(projectRoot, options.runOptions, signal)) ? '--dev-client' : '--no-dev-client',
        '--json',
      ]);
      const appPath = jsonString(stdout, 'path');
      if (!appPath) return null;
      return (await fileExists(appPath)) ? { appPath } : { failed: `returned ${appPath}, which does not exist` };
    }
    report('Uploading to the EAS build cache');
    const stdout = await command([
      'upload',
      `--platform=${platform}`,
      `--fingerprint=${hash}`,
      `--build-path=${options.buildPath}`,
      '--non-interactive',
      '--json',
    ]);
    const destination = jsonString(stdout, 'url');
    if (!destination) return { failed: 'EAS returned no upload destination' };
    report(`Build uploaded: ${destination}`);
    return { uploaded: true, destination };
  } catch (error) {
    signal?.throwIfAborted();
    if (isTimeoutError(error)) return { failed: `EAS cache ${phase} timed out after ${timeoutMs}ms` };
    const detail = error instanceof Error ? error.message : String(error);
    return { failed: detail.split('\n')[0]?.slice(0, 200) || 'EAS cache request failed' };
  }
}
