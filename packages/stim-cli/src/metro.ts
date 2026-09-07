import { getExecutor } from './exec.ts';
import { isMetroRunning } from './ports.ts';
import { readlinkSync, realpathSync } from 'fs';
import { sep } from 'path';
import { inspectProcessIdentity } from './process-identity.ts';
import { readWorkspaceState } from './supervisor/state.ts';

export function isPidAlive(pid: number): boolean {
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

export function parseLsofCwd(out: unknown): string | null {
  if (!out) return null;
  const lines = String(out).split('\n');
  const idx = lines.findIndex((l) => l === 'fcwd');
  if (idx === -1) return null;
  const nLine = lines.slice(idx + 1).find((l) => l.startsWith('n'));
  return nLine ? nLine.slice(1) : null;
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

export async function resolveProjectMetro(
  port: number,
  projectPath: string,
  { probe = isMetroRunning }: { probe?: (port: number) => Promise<boolean> | boolean } = {},
): Promise<MetroResolution> {
  const pids = parseLsofPids(getExecutor().runQuiet(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`));
  const pid = pids[0];
  if (pid === undefined) return { missing: true };

  if (!(await probe(port))) {
    return { notOurs: `pid ${pid} on port ${port} does not answer Metro's /status`, kind: NOT_OURS_UNRESPONSIVE, pid };
  }
  const cwd = processCwd(pid);
  if (!cwd) {
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
  const supervisor = readWorkspaceState(canonicalPath(projectPath))?.supervisor;
  const owned = supervisor?.port === port && inspectProcessIdentity(supervisor) === 'same';
  return {
    metro: {
      pid,
      leader: owned ? (supervisor.pid as number) : pid,
      cwd,
      ...(owned ? { processToken: supervisor.processToken as string } : {}),
    },
  };
}

export function killMetroTree(leader: number | null | undefined, processToken?: string): boolean {
  if (!leader || leader === process.pid || inspectProcessIdentity({ pid: leader, processToken }) !== 'same')
    return false;
  try {
    process.kill(-leader, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
