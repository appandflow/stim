import { spawnSync } from 'node:child_process';
import { readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024;

const RUN_ROOT = /^stim-(?:vitest|e2e-run)-/;
const INSPECT_TIMEOUT_MS = 15_000;
const STOPPING_GRACE_MS = 10_000;

export type StimdSurvivor = { pid: number; home: string };

function isRunRoot(root: string | undefined): root is string {
  return process.platform !== 'win32' && !!root && RUN_ROOT.test(basename(root));
}

function underRunRoot(directory: string): boolean {
  if (process.platform === 'win32') return false;
  let current = realpathSync(directory);
  for (let parent = dirname(current); parent !== current; current = parent, parent = dirname(current))
    if (RUN_ROOT.test(basename(current))) return true;
  return false;
}

// A process's working directory outlives the directory itself: macOS lsof and Linux /proc keep naming the removed path.
function workingDirectories(): Map<number, string> | null {
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
  const table = spawnSync('lsof', ['-d', 'cwd', '-Fpn'], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: INSPECT_TIMEOUT_MS,
  });
  if (table.error || table.signal) return null;
  let pid = 0;
  for (const line of (table.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) found.set(pid, line.slice(1));
  }
  return found;
}

function commandLines(): Map<number, string> | null {
  const table = spawnSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: INSPECT_TIMEOUT_MS,
  });
  if (table.error || table.signal) return null;
  const commands = new Map<number, string>();
  for (const line of (table.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2] ?? '');
  }
  return commands;
}

/** The stimd processes whose working directory, their Stim home's `run/`, lies under `directory`, with each home. */
function stimdUnder(directory: string): StimdSurvivor[] | null {
  try {
    const prefix = realpathSync(directory) + sep;
    const commands = commandLines();
    const directories = workingDirectories();
    if (!commands || !directories) return null;
    const survivors: StimdSurvivor[] = [];
    for (const [pid, cwd] of directories) {
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
    return null;
  }
}

export function killStimdUnder(directory: string): void {
  if (!underRunRoot(directory)) throw new Error(`${directory} is not inside a test run root`);
  for (const { pid } of stimdUnder(directory) ?? []) kill(pid);
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
// as stimd does, overwrites that area, so stimd is found by its working directory instead. `checked` is false when the
// process table could not be read, so no leftover daemon can be ruled out.
export function killRunProcesses(root: string | undefined): { survivors: StimdSurvivor[]; checked: boolean } {
  if (!isRunRoot(root)) return { survivors: [], checked: true };
  const table = spawnSync('ps', ['axeww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: INSPECT_TIMEOUT_MS,
  });
  for (const line of (table.stdout ?? '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/, 2).map(Number);
    if (!pid || ppid === process.pid || pid === process.pid || pid === table.pid || !line.includes(root)) continue;
    kill(pid);
  }
  const found = stimdUnder(root);
  if (!found) return { survivors: [], checked: false };
  for (const deadline = Date.now() + STOPPING_GRACE_MS; found.some(({ pid }) => alive(pid)) && Date.now() < deadline;)
    spawnSync('sleep', ['0.1']);
  const survivors = found.filter(({ pid }) => alive(pid));
  for (const { pid } of survivors) kill(pid);
  return { survivors, checked: true };
}
