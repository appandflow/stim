import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { LOCKFILES, readJsonObject } from '@stim-cli/core/state';
import { backgroundPassesAvailable } from '../daemon/client.ts';
import { shortHash } from '../command-output.ts';
import { processContext } from '../cli-operation.ts';
import { runCancellationSignal } from '../engine/native-run.ts';
import { fingerprint, fingerprintRuntime, type Fingerprint, type FingerprintRuntime } from './evaluate.ts';
import { fingerprintJobEnv } from './env.ts';
import { installRoot, targetLayout, type StaticTarget } from './inputs.ts';
import { isUncertain, type Input, type Layout, type NativeMode, type Uncertain } from './key.ts';
import { fingerprintSyncFiles } from './replay.ts';
import { newerThanInstall } from './index-store.ts';
import { pathForm } from './walk.ts';
import { takeDisagreements, verifyHit, type BackgroundCheck } from './verify.ts';

export type FingerprintCheck = BackgroundCheck;

export interface FingerprintInputs {
  sources: readonly Input[];
  ignored: readonly string[];
  schema: number;
  env: { set: Record<string, string | { path: string }>; absent: string[] };
  native: NativeMode;
  layout: Layout;
  runtime: FingerprintRuntime;
  fingerprintInputs?: string[];
}

export async function fingerprintForBuild(
  root: string,
  target: StaticTarget,
  {
    operation,
    embedMode,
    readOnly = false,
    consult = true,
    onDisagreement,
  }: {
    operation?: StimContext;
    embedMode: 'development' | 'production';
    readOnly?: boolean;
    consult?: boolean;
    onDisagreement?: (line: string) => void;
  },
): Promise<{ fingerprint: Fingerprint; check: FingerprintCheck | null } | { uncertain: string }> {
  operation ??= processContext(root);
  const env = operation.env;
  const runSignal = runCancellationSignal(operation);
  const signal = runSignal ? AbortSignal.any([operation.signal, runSignal]) : operation.signal;
  signal?.throwIfAborted();
  if (onDisagreement) {
    const home = operation.home;
    for (const item of takeDisagreements(home).unreported)
      onDisagreement(
        `an earlier cache lookup used fingerprint ${shortHash(item.recorded)}, but background verification found ` +
          `${shortHash(item.current)}; the stale record was removed`,
      );
  }
  const index = readOnly ? 'skip' : consult ? 'use' : 'refresh';
  const result = await fingerprint(root, target, { env, embedMode, signal, operation, index });
  signal?.throwIfAborted();
  if (isUncertain(result)) return result;
  const passes =
    result.from === 'index' && !readOnly && consult ? await backgroundPassesAvailable(operation.home) : false;
  signal?.throwIfAborted();
  const verify = () => verifyHit({ root, target, embedMode }, result, { env, signal, operation, passes });
  const check = readOnly || !consult ? null : verify();
  return { fingerprint: result, check };
}

export function fingerprintOffloadInputs(
  root: string,
  target: StaticTarget,
  key: Fingerprint,
  env: NodeJS.ProcessEnv,
): FingerprintInputs | Uncertain {
  if (!key.portable) return { uncertain: 'the fingerprint has inputs that cannot be safely mapped to this worker' };
  const project = realpathSync.native(root);
  const roots = { project, install: installRoot(project) };
  const files = fingerprintSyncFiles(project, key.inputs);
  if (isUncertain(files)) return files;
  const runtime = fingerprintRuntime(project, env);
  if (isUncertain(runtime)) return runtime;
  const values = fingerprintJobEnv(key.inputs, env, (path) => {
    try {
      return pathForm(realpathSync.native(path), roots);
    } catch {
      return pathForm(resolve(path), roots);
    }
  });
  if (!values) return { uncertain: 'the fingerprint environment contains a private or nonportable input' };
  return {
    sources: key.inputs,
    ignored: files,
    schema: key.schema,
    env: values,
    native: key.native,
    layout: targetLayout(target),
    runtime,
    ...(target.fingerprintInputs === undefined ? {} : { fingerprintInputs: [...target.fingerprintInputs] }),
  };
}

export function fingerprintInstallWarning(root: string): string | null {
  const project = realpathSync.native(root);
  const install = installRoot(project);
  const pending = newerThanInstall({ project, install });
  if (!pending) return null;
  const consequence = 'the build will be installed but not cached';
  if (isUncertain(pending)) return `${pending.uncertain}; ${consequence}`;
  const warning = `${pending.input} changed after the last install; ${consequence}`;
  if (
    pending.input !== join(install, 'package-lock.json') ||
    pending.stamp !== join(install, 'node_modules', '.package-lock.json') ||
    LOCKFILES.some((file) => file !== 'package-lock.json' && existsSync(join(install, file)))
  )
    return warning;
  const declared = readJsonObject(join(install, 'package.json'))?.packageManager;
  if (typeof declared === 'string' && !declared.startsWith('npm@')) return warning;
  return `${warning}. Run \`npm install\` in ${JSON.stringify(install)} before the next build.`;
}

export async function settleFingerprintCheck(
  check: FingerprintCheck | null | undefined,
  platform: 'ios' | 'android',
  warn: (line: string) => void,
  log?: (record: Record<string, unknown>) => void,
): Promise<void> {
  if (!check) return;
  const { status, recorded, current } = await check.settle();
  if (status !== 'disagreed' || !current) return;
  const line = disagreementLine(platform, recorded, current);
  warn(line);
  log?.({ src: 'build', level: 'warn', event: 'fingerprint_index_disagreement', msg: line, recorded, current });
}

function disagreementLine(platform: 'ios' | 'android', recorded: string, current: string): string {
  return (
    `the recorded fingerprint ${shortHash(recorded)} no longer matches the tree (${shortHash(current)}), ` +
    `so this run looked up the build cache with a stale key; run stim ${platform} again to use the current tree`
  );
}
