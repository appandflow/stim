import { readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { canonicalPath } from '../commands/gc/paths.ts';
import { getExecutor } from '../exec.ts';
import { serviceRunningFrom } from './service-guard.ts';

/** The command line and working directory of each process this user runs, or null when they cannot be listed. */
export interface RunningProcesses {
  commands: { pid: number; line: string }[];
  cwds: { pid: number; path: string }[];
}

const LIST_TIMEOUT_MS = 10_000;

function parsePs(text: string): RunningProcesses['commands'] {
  return text.split('\n').flatMap((row) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(row);
    return match ? [{ pid: Number(match[1]), line: match[2] ?? '' }] : [];
  });
}

/** `lsof -Fpn` output: a `p<pid>` line, then the `n<path>` of its working directory. */
function parseLsof(text: string): RunningProcesses['cwds'] {
  const cwds: RunningProcesses['cwds'] = [];
  let pid = 0;
  for (const row of text.split('\n')) {
    if (row.startsWith('p')) pid = Number(row.slice(1));
    else if (row.startsWith('n') && pid) cwds.push({ pid, path: row.slice(1) });
  }
  return cwds;
}

function procCwds(): RunningProcesses['cwds'] | null {
  try {
    return readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .flatMap((name) => {
        try {
          return [{ pid: Number(name), path: readlinkSync(join('/proc', name, 'cwd')) }];
        } catch {
          return [];
        }
      });
  } catch {
    return null;
  }
}

function listsSelf(list: readonly { pid: number }[]): boolean {
  return list.some(({ pid }) => pid === process.pid);
}

function runningFrom(ps: string | null, cwds: RunningProcesses['cwds'] | null): RunningProcesses | null {
  if (ps === null || cwds === null) return null;
  const commands = parsePs(ps);
  return listsSelf(commands) && listsSelf(cwds) ? { commands, cwds } : null;
}

const PS_ARGS = ['-axww', '-o', 'pid=,args='];
const LSOF_ARGS = ['-a', '-d', 'cwd', '-Fpn', '-w'];

export function readRunningProcesses(platform: NodeJS.Platform = process.platform): RunningProcesses | null {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const exec = getExecutor();
  const ps = exec.runFileQuiet('ps', PS_ARGS, { timeoutMs: LIST_TIMEOUT_MS });
  if (platform === 'linux') return runningFrom(ps, procCwds());
  const lsof = exec.runFileQuiet('lsof', LSOF_ARGS, { timeoutMs: LIST_TIMEOUT_MS });
  return runningFrom(ps, lsof === null ? null : parseLsof(lsof));
}

/**
 * `running` without the process `self`, its ancestors and its descendants, and without processes absent from `table`
 * (`ps -axo pid=,ppid=` output read after `running`, so they exited since), so a command run from inside a folder (the
 * shell that started it, and the ps and lsof it ran to list processes) does not count as something else using that
 * folder. Null when `table` does not list `self`, so an unreadable table never frees a folder.
 */
export function othersAmong(running: RunningProcesses, table: string, self: number): RunningProcesses | null {
  const parent = new Map<number, number>();
  for (const row of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
    if (match) parent.set(Number(match[1]), Number(match[2]));
  }
  if (!parent.has(self)) return null;
  const own = new Set<number>();
  for (let pid: number | undefined = self; pid !== undefined && pid > 1 && !own.has(pid); pid = parent.get(pid))
    own.add(pid);
  const descends = (pid: number): boolean => {
    for (
      let at: number | undefined = pid, hops = 0;
      at !== undefined && at > 1 && hops < 256;
      at = parent.get(at), hops++
    )
      if (at === self) return true;
    return false;
  };
  const other = (pid: number): boolean => parent.has(pid) && !own.has(pid) && !descends(pid);
  return {
    commands: running.commands.filter(({ pid }) => other(pid)),
    cwds: running.cwds.filter(({ pid }) => other(pid)),
  };
}

/** `othersAmong` for this process, with a fresh process table; null when either listing cannot be read. */
export async function othersRunningAsync(
  running: RunningProcesses | null,
  signal?: AbortSignal,
): Promise<RunningProcesses | null> {
  if (!running) return null;
  const table = await getExecutor().runFileQuietAsync('ps', ['-axo', 'pid=,ppid='], {
    timeoutMs: LIST_TIMEOUT_MS,
    signal,
  });
  return table === null ? null : othersAmong(running, table, process.pid);
}

export async function readRunningProcessesAsync(
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<RunningProcesses | null> {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const exec = getExecutor();
  const ps = await exec.runFileQuietAsync('ps', PS_ARGS, { timeoutMs: LIST_TIMEOUT_MS, signal });
  if (platform === 'linux') return runningFrom(ps, procCwds());
  const lsof = await exec.runFileQuietAsync('lsof', LSOF_ARGS, { timeoutMs: LIST_TIMEOUT_MS, signal });
  return runningFrom(ps, lsof === null ? null : parseLsof(lsof));
}

function stimOnPath(): string | null {
  const found = getExecutor().findExecutable('stim');
  if (!found) return null;
  try {
    return realpathSync(found);
  } catch {
    return null;
  }
}

/**
 * Why something installed in or running from `folder` still needs it, or null: an installed stim service, the
 * `stim` on PATH, or a live process whose command line or working directory is inside it.
 */
export function runningFromReason(folder: string, running: RunningProcesses | null): string | null {
  const root = canonicalPath(folder);
  const inside = (path: string) => path === root || path.startsWith(`${root}${sep}`);
  const service = serviceRunningFrom(root, canonicalPath);
  if (service) return `the stim service ${service.label} runs from it`;
  const stim = stimOnPath();
  if (stim && inside(stim)) return `the stim on PATH runs from it (${stim})`;
  if (!running) return 'the running processes cannot be listed to prove nothing runs from it';
  const command = running.commands.find(({ line }) => line.includes(`${root}${sep}`));
  if (command) return `process ${command.pid} runs from it`;
  const cwd = running.cwds.find(({ path }) => inside(canonicalPath(path)));
  if (cwd) return `process ${cwd.pid} works in it`;
  return null;
}
