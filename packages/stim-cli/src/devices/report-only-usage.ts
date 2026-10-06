import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getExecutor } from '../exec.ts';

export function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function parseDu(output: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of output.split('\n')) {
    const match = /^(\d+)\t(.+?)\r?$/.exec(line);
    if (match) sizes.set(resolve(match[2]!), Number(match[1]) * 1024);
  }
  return sizes;
}

export async function measureDu(args: string[]): Promise<{ sizes: Map<string, number>; complete: boolean }> {
  let output = '';
  let complete = true;
  try {
    output = await getExecutor().runFileAsync('du', args, { timeoutMs: 60_000 });
  } catch (error) {
    complete = false;
    const failure = error as { status?: number; code?: string; stdout?: string };
    if (failure.status === 1 && !failure.code && typeof failure.stdout === 'string') output = failure.stdout;
  }
  return { sizes: parseDu(output), complete };
}

export function writeUsageCache(file: string, value: unknown): void {
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
