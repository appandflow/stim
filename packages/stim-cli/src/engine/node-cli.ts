import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { readJsonObject } from '@stim-cli/core/state';
import { getExecutor, type ExecOptions } from '../exec.ts';
import { cancelledError, throwIfCancelled } from '../cancellation.ts';
import { childEnvironment, killOnAbort } from '../workspace/git-read.ts';
import { resolvePackageJson } from '../workspace/project.ts';
import { expoBinFromPackage } from '../supervisor/server-expo.ts';
import { operationState } from './operation-state.ts';

function nodeScript(file: string): boolean {
  if (/\.(?:cjs|mjs|js)$/i.test(file)) return true;
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const header = Buffer.alloc(150);
    const count = readSync(fd, header, 0, header.length, 0);
    return /^#![^\r\n]*\bnode(?:\.exe)?(?:[ \t\r\n]|$)/.test(header.toString('utf8', 0, count));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function batchNodeEntry(file: string, packageName: string): string | null {
  try {
    const launcher = readFileSync(file, 'utf8');
    for (const match of launcher.matchAll(/"([^"\r\n]+)"[ \t]+%\*/g)) {
      const literal = match[1];
      if (!literal) continue;
      const target = literal.replace(/^%(?:~dp0|dp0%)/i, dirname(file));
      if (target.includes('%')) continue;
      const candidate = realpathSync.native(resolvePath(dirname(file), target));
      const manifest = resolvePackageJson(dirname(candidate), packageName);
      if (!manifest || readJsonObject(manifest)?.name !== packageName) continue;
      const entry = expoBinFromPackage(manifest, packageName === 'eas-cli' ? 'eas' : packageName);
      if (entry && realpathSync.native(entry) === candidate && nodeScript(candidate)) return candidate;
    }
  } catch {}
  return null;
}

export function remoteCliInvocation(
  file: string,
  args: string[],
  packageName: 'eas-cli' | 'agent-device' | 'expo' | 'react-native' | null,
): { file: string; args: string[] } {
  let program = file;
  let commandArgs = args;
  if (process.platform === 'win32') {
    let entry: string | null = null;
    if (packageName) {
      try {
        entry = /\.(cmd|bat)$/i.test(file)
          ? batchNodeEntry(file, packageName)
          : expoBinFromPackage(
              resolvePackageJson(dirname(realpathSync(file)), packageName),
              packageName === 'eas-cli' ? 'eas' : packageName,
            );
      } catch {}
    }
    const script = entry ?? file;
    if (nodeScript(script)) {
      program = process.execPath;
      commandArgs = [script, ...args];
    } else if (/\.(cmd|bat)$/i.test(file)) {
      throw new Error(
        `Could not resolve the Node entrypoint for ${file}; install ${packageName ?? 'the CLI'} with npm or pnpm so cancellation can reach its process.`,
      );
    }
  }
  return { file: program, args: commandArgs };
}

export async function remoteCommand(
  ctx: { operation?: StimContext; easBin?: string; agentDeviceBin?: string; expoBin?: string },
  file: string,
  args: string[],
  options: ExecOptions,
  cleanup = false,
): Promise<string> {
  const operation = ctx.operation;
  const signal = cleanup
    ? undefined
    : operation
      ? (operationState(operation).runSignal ?? operation.signal)
      : undefined;
  throwIfCancelled(signal, 'remote device');
  const state = cleanup && operation ? operationState(operation) : undefined;
  const refusal = state?.refusal;
  if (state && refusal) state.refusal = null;
  try {
    const environment = operation ? childEnvironment(operation.env) : { env: {}, omitEnv: [] };
    const invocation = remoteCliInvocation(
      file,
      args,
      file === ctx.easBin
        ? 'eas-cli'
        : file === ctx.agentDeviceBin
          ? 'agent-device'
          : file === ctx.expoBin
            ? 'expo'
            : null,
    );
    const output = await getExecutor().runFileAsync(invocation.file, invocation.args, {
      ...environment,
      ...options,
      ...(operation ? { env: { ...environment.env, ...options.env } } : {}),
      omitEnv: [...environment.omitEnv.filter((name) => options.env?.[name] === undefined), ...(options.omitEnv ?? [])],
      declareFor: operation,
      onSpawn: killOnAbort(signal),
    });
    if (signal?.aborted) throw Object.assign(cancelledError('remote device'), { stdout: output });
    return output;
  } finally {
    if (state && refusal) state.refusal = refusal;
  }
}

export function bundleInvocation(root: string, isExpo: boolean, args: string[]): { file: string; args: string[] } {
  const name = isExpo ? 'expo' : 'react-native';
  const file = expoBinFromPackage(resolvePackageJson(root, name), name);
  if (!file) throw new Error(`The ${name} CLI is not installed in ${root}`);
  return remoteCliInvocation(file, args, name);
}
