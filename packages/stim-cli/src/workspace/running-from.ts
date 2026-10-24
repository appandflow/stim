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

export function readRunningProcesses(platform: NodeJS.Platform = process.platform): RunningProcesses | null {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const exec = getExecutor();
  const ps = exec.runFileQuiet('ps', ['-axww', '-o', 'pid=,args='], { timeoutMs: LIST_TIMEOUT_MS });
  if (ps === null) return null;
  const cwds =
    platform === 'linux'
      ? procCwds()
      : (() => {
          const lsof = exec.runFileQuiet('lsof', ['-a', '-d', 'cwd', '-Fpn', '-w'], { timeoutMs: LIST_TIMEOUT_MS });
          return lsof === null ? null : parseLsof(lsof);
        })();
  return cwds === null ? null : { commands: parsePs(ps), cwds };
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
 * Why something installed in or running from `folder` still needs it, or null: an installed stim-server service, the
 * `stim` on PATH, or a live process whose command line or working directory is inside it.
 */
export function runningFromReason(folder: string, running: RunningProcesses | null): string | null {
  const root = canonicalPath(folder);
  const inside = (path: string) => path === root || path.startsWith(`${root}${sep}`);
  const service = serviceRunningFrom(root, canonicalPath);
  if (service) return `the stim-server service ${service.label} runs from it`;
  const stim = stimOnPath();
  if (stim && inside(stim)) return `the stim on PATH runs from it (${stim})`;
  if (!running) return 'the running processes cannot be listed to prove nothing runs from it';
  const command = running.commands.find(({ pid, line }) => pid !== process.pid && line.includes(`${root}${sep}`));
  if (command) return `process ${command.pid} runs from it`;
  const cwd = running.cwds.find(({ pid, path }) => pid !== process.pid && inside(canonicalPath(path)));
  if (cwd) return `process ${cwd.pid} works in it`;
  return null;
}
