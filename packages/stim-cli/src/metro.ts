import { getExecutor } from './exec.ts';
import { isMetroRunning } from './ports.ts';
import { readlinkSync, realpathSync } from 'fs';
import { sep } from 'path';
import { inspectProcessIdentity } from './process-identity.ts';
import { readWorkspaceState } from './workspace/workspace-state.ts';

/**
 * True when some process with this pid exists right now. It cannot tell a recycled pid from the
 * process that first held it, so it is only valid for a pid this run spawned and still holds a
 * handle on. For a pid read from a record on disk, decide with `inspectProcessIdentity` on that
 * record's process token, or take an ownership claim (`ownership-claim.ts`): this answer would keep
 * a dead holder's record looking live until some unrelated process exits.
 */
export function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function parseLsofPids(out: unknown): number[] {
  if (!out) return [];
  return String(out)
    .split('\n')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

function addressPort(address: string | undefined): number {
  const colon = String(address ?? '').lastIndexOf(':');
  return colon < 0 ? Number.NaN : Number(String(address).slice(colon + 1));
}

// netstat's LISTENING state column is localized, so a listening TCP row is recognized by its
// foreign address carrying port 0 instead.
export function parseNetstatPids(out: unknown, port: number): number[] {
  const pids: number[] = [];
  for (const line of String(out ?? '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0]?.toUpperCase() !== 'TCP') continue;
    if (addressPort(cols[1]) !== port || addressPort(cols[2]) !== 0) continue;
    const pid = Number(cols.at(-1));
    if (Number.isSafeInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

export function listeningPids(port: number, platform: NodeJS.Platform = process.platform): number[] {
  const pids = parseLsofPids(getExecutor().runQuiet(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`));
  if (pids.length > 0 || platform !== 'win32') return pids;
  return parseNetstatPids(getExecutor().runQuiet('netstat -ano'), port);
}

export function parseLsofCwd(out: unknown): string | null {
  if (!out) return null;
  const lines = String(out).split('\n');
  const idx = lines.findIndex((l) => l === 'fcwd');
  if (idx === -1) return null;
  const nLine = lines.slice(idx + 1).find((l) => l.startsWith('n'));
  return nLine ? nLine.slice(1) : null;
}

function lsofOutput(args: string[]): Promise<string | null> {
  return getExecutor()
    .runFileAsync('lsof', args)
    .catch((error: { stdout?: unknown }) => (typeof error?.stdout === 'string' ? error.stdout : null));
}

export function parseLsofListeners(out: unknown): Map<number, number[]> {
  const byPort = new Map<number, number[]>();
  let pid: number | null = null;
  for (const line of String(out ?? '').split('\n')) {
    if (line.startsWith('p')) pid = parseInt(line.slice(1), 10);
    else if (line.startsWith('n') && pid !== null && Number.isFinite(pid)) {
      const port = addressPort(line.slice(1));
      const pids = byPort.get(port) ?? [];
      if (!pids.includes(pid)) pids.push(pid);
      byPort.set(port, pids);
    }
  }
  return byPort;
}

/**
 * `listeningPids` for several ports with one lsof call. A port lsof could not be asked about is
 * missing from the map.
 */
export async function listeningPidsByPort(ports: number[]): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  if (ports.length === 0) return result;
  const out = await lsofOutput(['-nP', `-iTCP:${ports.join(',')}`, '-sTCP:LISTEN', '-Fpn']);
  if (out === null) return result;
  const found = parseLsofListeners(out);
  for (const port of ports) result.set(port, found.get(port) ?? []);
  return result;
}

export function parseLsofCwds(out: unknown): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  let inCwd = false;
  for (const line of String(out ?? '').split('\n')) {
    if (line.startsWith('p')) {
      pid = parseInt(line.slice(1), 10);
      inCwd = false;
    } else if (line.startsWith('f')) {
      inCwd = line === 'fcwd';
    } else if (inCwd && line.startsWith('n') && pid !== null && !cwds.has(pid)) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

/** `processCwd` for several pids with at most one lsof call. A pid lsof could not be asked about is missing from the map. */
export async function processCwds(pids: number[]): Promise<Map<number, string | null>> {
  const cwds = new Map<number, string | null>();
  const viaLsof: number[] = [];
  for (const pid of new Set(pids)) {
    let cwd: string | null = null;
    if (process.platform === 'linux') {
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {}
    }
    if (cwd) cwds.set(pid, cwd);
    else viaLsof.push(pid);
  }
  if (viaLsof.length === 0) return cwds;
  const out = await lsofOutput(['-a', '-p', viaLsof.join(','), '-d', 'cwd', '-Fn']);
  if (out === null) return cwds;
  const found = parseLsofCwds(out);
  for (const pid of viaLsof) cwds.set(pid, found.get(pid) ?? null);
  return cwds;
}

export function processCwd(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
  }
  return parseLsofCwd(getExecutor().runQuiet(`lsof -a -p ${pid} -d cwd -Fn`));
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isInsideProject(cwd: string | null | undefined, projectPath: string | null | undefined): boolean {
  if (!cwd || !projectPath) return false;
  const a = canonicalPath(cwd);
  const b = canonicalPath(projectPath);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

export const NOT_OURS_UNRESPONSIVE = 'unresponsive';
const NOT_OURS_UNREADABLE_CWD = 'unreadable-cwd';
export const NOT_OURS_FOREIGN_CWD = 'foreign-cwd';

export interface MetroResolution {
  missing?: true;
  notOurs?: string;
  kind?: string;
  pid?: number;
  metro?: { pid: number; leader: number; cwd: string; processToken?: string };
}

function ownedSupervisor(projectPath: string, port: number) {
  const supervisor = readWorkspaceState(canonicalPath(projectPath))?.supervisor;
  if (supervisor?.port !== port || inspectProcessIdentity(supervisor) !== 'same') return null;
  return supervisor;
}

export async function resolveProjectMetro(
  port: number,
  projectPath: string,
  {
    probe = isMetroRunning,
    pidsOf = listeningPids,
    cwdOf = processCwd,
  }: {
    probe?: (port: number) => Promise<boolean> | boolean;
    pidsOf?: (port: number) => Promise<number[]> | number[];
    cwdOf?: (pid: number) => Promise<string | null> | string | null;
  } = {},
): Promise<MetroResolution> {
  const pids = await pidsOf(port);
  const pid = pids[0];
  if (pid === undefined) return { missing: true };

  if (!(await probe(port))) {
    return { notOurs: `pid ${pid} on port ${port} does not answer Metro's /status`, kind: NOT_OURS_UNRESPONSIVE, pid };
  }
  const cwd = await cwdOf(pid);
  if (!cwd) {
    const owner = ownedSupervisor(projectPath, port);
    if (owner && (pid === owner.pid || pid === owner.serverPid)) {
      return {
        metro: {
          pid,
          leader: owner.pid as number,
          cwd: canonicalPath(projectPath),
          processToken: owner.processToken as string,
        },
      };
    }
    return {
      notOurs: `pid ${pid} on port ${port}: working directory could not be read`,
      kind: NOT_OURS_UNREADABLE_CWD,
      pid,
    };
  }
  if (!isInsideProject(cwd, projectPath)) {
    return {
      notOurs: `pid ${pid} on port ${port} runs from ${cwd}, outside ${projectPath}`,
      kind: NOT_OURS_FOREIGN_CWD,
      pid,
    };
  }
  const owner = ownedSupervisor(projectPath, port);
  return {
    metro: {
      pid,
      leader: owner ? (owner.pid as number) : pid,
      cwd,
      ...(owner ? { processToken: owner.processToken as string } : {}),
    },
  };
}

/**
 * Terminate a process and everything it spawned. On POSIX `group` signals the process group, which
 * is what a detached leader owns. Windows has no process groups, and its SIGTERM is
 * TerminateProcess: no handler runs and no child is reached, so a spawned dev server or `adb
 * logcat` would outlive its parent. taskkill /T is the only route to the tree there, and it is
 * always forceful.
 */
export function signalProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
  { group = false, platform = process.platform }: { group?: boolean; platform?: NodeJS.Platform } = {},
): boolean {
  if (platform !== 'win32') return process.kill(group ? -pid : pid, signal);
  return getExecutor().runFileQuiet('taskkill', ['/PID', String(pid), '/T', '/F']) !== null;
}

export function killMetroTree(leader: number | null | undefined, processToken?: string): boolean {
  if (!leader || leader === process.pid || inspectProcessIdentity({ pid: leader, processToken }) !== 'same')
    return false;
  try {
    return signalProcessTree(leader, 'SIGTERM', { group: true });
  } catch {
    return false;
  }
}
