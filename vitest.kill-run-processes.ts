import { spawnSync } from 'node:child_process';
import { readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024;

function isRunRoot(root: string | undefined): root is string {
  return process.platform !== 'win32' && !!root && basename(root).startsWith('stim-vitest-');
}

// A process's working directory outlives the directory itself: macOS lsof and Linux /proc keep naming the removed path.
function workingDirectories(): Map<number, string> {
  const found = new Map<number, string>();
  if (process.platform === 'linux') {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        found.set(Number(entry), readlinkSync(`/proc/${entry}/cwd`).replace(/ \(deleted\)$/, ''));
      } catch {}
    }
    return found;
  }
  const table = spawnSync('lsof', ['-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
  let pid = 0;
  for (const line of (table.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) found.set(pid, line.slice(1));
  }
  return found;
}

function commandLines(): Map<number, string> {
  const table = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
  const commands = new Map<number, string>();
  for (const line of (table.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2] ?? '');
  }
  return commands;
}

/** The stimd processes whose working directory, their Stim home's `run/`, lies under `directory`, with each home. */
function stimdUnder(directory: string): { pid: number; home: string }[] {
  try {
    const prefix = realpathSync(directory) + sep;
    const commands = commandLines();
    const survivors: { pid: number; home: string }[] = [];
    for (const [pid, cwd] of workingDirectories()) {
      if (
        pid === process.pid ||
        !cwd.startsWith(prefix) ||
        !/(^|[\s/])(?:__)?stimd(\s|$)/.test(commands.get(pid) ?? '')
      )
        continue;
      survivors.push({ pid, home: basename(cwd) === 'run' ? dirname(cwd) : cwd });
    }
    return survivors;
  } catch {
    return [];
  }
}

export function killStimdUnder(directory: string): void {
  for (const { pid } of stimdUnder(directory)) kill(pid);
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// macOS and procps `ps e` append each process's environment to its command column. A process that sets process.title,
// as stimd does, overwrites that area, so stimd is found by its working directory instead.
export function killRunProcesses(root: string | undefined): { pid: number; home: string }[] {
  if (!isRunRoot(root)) return [];
  const table = spawnSync('ps', ['axeww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
  for (const line of (table.stdout ?? '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/, 2).map(Number);
    if (!pid || ppid === process.pid || pid === process.pid || pid === table.pid || !line.includes(root)) continue;
    kill(pid);
  }
  let survivors = stimdUnder(root);
  for (const deadline = Date.now() + 2000; survivors.some(({ pid }) => alive(pid)) && Date.now() < deadline;)
    spawnSync('sleep', ['0.1']);
  survivors = survivors.filter(({ pid }) => alive(pid));
  for (const { pid } of survivors) kill(pid);
  return survivors;
}
