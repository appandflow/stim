import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getExecutor } from '../exec.ts';
import type { StimContext } from '@stim-cli/core';
import { runOperationFile } from '../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';

export function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function parseDu(output: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of output.split('\n')) {
    const match = /^(\d+)\t(.+?)\r?$/.exec(line);
    if (match) sizes.set(resolve(match[2]!), Number(match[1]) * 1024);
  }
  return sizes;
}

export async function measureDu(
  args: string[],
  operation?: StimContext,
): Promise<{ sizes: Map<string, number>; complete: boolean }> {
  let output = '';
  let complete = true;
  try {
    output = await runOperationFile(operation, getExecutor(), 'du', args, {
      timeoutMs: 20_000,
      cwd: operation?.cwd,
      signal: operation?.signal,
    });
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    operation?.signal.throwIfAborted();
    complete = false;
    const failure = error as { status?: number; code?: string; stdout?: string };
    if (failure.status === 1 && !failure.code && typeof failure.stdout === 'string') output = failure.stdout;
  }
  return { sizes: parseDu(output), complete };
}

export function writeUsageCache(file: string, value: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, file);
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {}
  }
}
