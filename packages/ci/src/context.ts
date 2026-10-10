import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { StimOptions } from 'stim';
import type { CIFailure } from './index.ts';

export interface CIContextOptions {
  projectRoot: string;
  artifactsDir?: string;
  home?: string;
  buildCache?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: StimOptions['onProgress'];
}

export function failure(error: unknown, code: string): CIFailure {
  const caught = error as { code?: unknown; message?: unknown; remedy?: unknown } | null;
  return {
    code: typeof caught?.code === 'string' ? caught.code : code,
    message: typeof caught?.message === 'string' ? caught.message : String(error),
    ...(typeof caught?.remedy === 'string' ? { remedy: caught.remedy } : {}),
  };
}

export function writeJson(path: string, value: unknown): void {
  const pending = `${path}.tmp`;
  writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(pending, path);
}

export function prepareCI<T extends CIContextOptions>(
  options: T,
): {
  options: T;
  projectRoot: string;
  artifactsDir: string;
  timeout: AbortSignal | undefined;
  signal: AbortSignal | undefined;
} {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive integer.');
  }
  if (
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    process.env.RUNNER_TEMP &&
    !options.home &&
    !process.env.STIM_HOME
  ) {
    const directory = join(resolve(process.env.RUNNER_TEMP), 'stim-ci');
    options = {
      ...options,
      home: join(directory, 'home'),
      buildCache: options.buildCache || (process.env.STIM_BUILD_CACHE ? undefined : join(directory, 'build-cache')),
    };
  }
  const projectRoot = realpathSync(options.projectRoot);
  const artifactsDir = options.artifactsDir ? resolve(options.artifactsDir) : mkdtempSync(join(tmpdir(), 'stim-ci-'));
  mkdirSync(artifactsDir, { recursive: true });
  if (readdirSync(artifactsDir).length > 0) {
    throw new Error(`Artifacts directory must be empty: ${artifactsDir}. Choose a new directory for this run.`);
  }
  const timeout = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
  const signals = [options.signal, timeout].filter((value): value is AbortSignal => value !== undefined);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  return { options, projectRoot, artifactsDir, timeout, signal };
}
