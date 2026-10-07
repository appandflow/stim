import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import { isPathPrefix } from './config.ts';

export const SERVICE_IN_USE = { code: 'STIM_WORKTREE_SERVICE' } as const;

export interface ServiceUse {
  label: string;
  plist: string;
  /** The recorded launch argument inside the folder, or null when the plist could not be read. */
  argument: string | null;
}

function serviceUseOf(
  plist: unknown,
  file: string,
  folder: string,
  canonical: (path: string) => string,
): ServiceUse | null {
  if (typeof plist !== 'object' || plist === null) return null;
  const job = plist as { Label?: unknown; StimService?: unknown; ProgramArguments?: unknown };
  if (typeof job.StimService !== 'object' || job.StimService === null || !Array.isArray(job.ProgramArguments))
    return null;
  const argument = job.ProgramArguments.find(
    (value): value is string =>
      typeof value === 'string' && value.startsWith('/') && isPathPrefix(folder, canonical(value)),
  );
  if (argument === undefined) return null;
  return { label: typeof job.Label === 'string' ? job.Label : file, plist: file, argument };
}

/** The first installed stim-server service that runs from inside `folder`, or null. macOS only. */
export function serviceRunningFrom(
  folder: string,
  canonical: (path: string) => string,
  agentsDir: string = join(homedir(), 'Library', 'LaunchAgents'),
): ServiceUse | null {
  if (process.platform !== 'darwin') return null;
  let names: string[];
  try {
    names = readdirSync(agentsDir).filter((name) => name.endsWith('.plist'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? null
      : { label: 'unknown', plist: agentsDir, argument: null };
  }
  for (const name of names) {
    const file = join(agentsDir, name);
    const label = name.replace(/\.plist$/, '');
    try {
      if (!readFileSync(file).includes('StimService')) continue;
    } catch {
      return { label, plist: file, argument: null };
    }
    try {
      const json = getExecutor().runFile('plutil', ['-convert', 'json', '-o', '-', file], { timeoutMs: 5000 });
      const use = serviceUseOf(JSON.parse(json), file, folder, canonical);
      if (use) return use;
    } catch {
      return { label, plist: file, argument: null };
    }
  }
  return null;
}
