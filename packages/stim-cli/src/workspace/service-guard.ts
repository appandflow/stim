import { readdirSync, readFileSync } from 'node:fs';
import { unitLines, unitWords } from '@stim-cli/core';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import { isPathPrefix } from './config.ts';

export const SERVICE_IN_USE = { code: 'STIM_WORKTREE_SERVICE' } as const;

export interface ServiceUse {
  label: string;
  /** The LaunchAgent plist or systemd unit file that installs the service. */
  plist: string;
  /** The recorded launch argument inside the folder, or null when the file could not be read. */
  argument: string | null;
}

function inside(folder: string, canonical: (path: string) => string) {
  return (value: unknown): value is string =>
    typeof value === 'string' && value.startsWith('/') && isPathPrefix(folder, canonical(value));
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
  const argument = job.ProgramArguments.find(inside(folder, canonical));
  if (argument === undefined) return null;
  return { label: typeof job.Label === 'string' ? job.Label : file, plist: file, argument };
}

/** The launch argument inside `folder` of a unit `stim-server service install` wrote, or null when it has none. */
function unitArgument(text: string, folder: string, canonical: (path: string) => string): string | null | undefined {
  const lines = unitLines(text);
  if (!lines.some((line) => line.section === 'X-Stim' && line.key === 'Managed' && line.value === 'true')) return null;
  const exec = lines.findLast((line) => line.section === 'Service' && line.key === 'ExecStart')?.value;
  const args = exec === undefined ? null : unitWords(exec, true);
  if (!args) return undefined;
  return args.find(inside(folder, canonical)) ?? null;
}

function unitRunningFrom(folder: string, canonical: (path: string) => string, unitsDir: string): ServiceUse | null {
  let names: string[];
  try {
    names = readdirSync(unitsDir).filter((name) => name.endsWith('.service'));
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? null
      : { label: 'unknown', plist: unitsDir, argument: null };
  }
  for (const name of names) {
    const file = join(unitsDir, name);
    const label = name.replace(/\.service$/, '');
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return { label, plist: file, argument: null };
    }
    if (!text.includes('[X-Stim]')) continue;
    const argument = unitArgument(text, folder, canonical);
    if (argument === undefined) return { label, plist: file, argument: null };
    if (argument) return { label, plist: file, argument };
  }
  return null;
}

/**
 * The first installed stim-server service that runs from inside `folder`, or null: a LaunchAgent on macOS, a systemd
 * user unit on Linux. A service file that cannot be read counts as one, with a null `argument`.
 */
export function serviceRunningFrom(
  folder: string,
  canonical: (path: string) => string,
  agentsDir: string = join(homedir(), 'Library', 'LaunchAgents'),
  unitsDir: string = join(homedir(), '.config', 'systemd', 'user'),
  platform: NodeJS.Platform = process.platform,
): ServiceUse | null {
  if (platform === 'linux') return unitRunningFrom(folder, canonical, unitsDir);
  if (platform !== 'darwin') return null;
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

/** The Stim CLI entry points removal must not delete: the running one and the `stim` on PATH. */
export function stimCliEntries(env?: NodeJS.ProcessEnv): { label: string; path: string }[] {
  const entries: { label: string; path: string }[] = [];
  if (process.argv[1]) entries.push({ label: 'the running stim', path: process.argv[1] });
  const onPath = getExecutor().findExecutable('stim', env ? { env } : undefined);
  if (onPath) entries.push({ label: 'the stim on PATH', path: onPath });
  return entries;
}

/** Why removing `folder` would delete a Stim CLI in `entries`, resolved through symlinks; empty when it would not. */
export function stimCliUseOf(
  folder: string,
  canonical: (path: string) => string,
  entries: readonly { label: string; path: string }[],
): string[] {
  return entries.flatMap(({ label, path }) => {
    const resolved = canonical(path);
    return isPathPrefix(folder, resolved) ? [`it holds ${label} (${resolved})`] : [];
  });
}
