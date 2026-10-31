import { readlinkSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { getExecutor } from '../exec.ts';
import { pidExists } from '../metro.ts';
import { processGroupAlive } from '../ownership-claim.ts';
import { inspectProcessIdentity, type ProcessRecord } from '../process-identity.ts';
import type { StimContext } from '@stim-cli/core';
import { runOperationFile } from '../engine/operation-exec.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/**
 * The process Chrome's `SingletonLock` names, when it is a live process on this host. Chrome writes the lock as a
 * symlink to `<hostname>-<pid>` and refuses a second instance on the profile while that process lives.
 */
export function liveProfileHolder(
  profile: string,
  { alive = pidExists }: { alive?: (pid: number) => boolean } = {},
): number | null {
  let target: string;
  try {
    target = readlinkSync(join(profile, 'SingletonLock'));
  } catch {
    return null;
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match || match[1] !== hostname()) return null;
  const pid = Number(match[2]);
  return alive(pid) ? pid : null;
}

/** Removes the lock files a Chrome that did not exit cleanly leaves; call only once that Chrome is gone. */
export function removeSingletonFiles(profile: string): void {
  for (const name of SINGLETON_FILES) rmSync(join(profile, name), { force: true });
}

/** Whether a process in group `pgid` in a `ps -o pgid=,command=` listing has `profile` as its Chrome user data dir. */
function groupRunsProfile(listing: string, pgid: number, profile: string): boolean {
  const flag = `--user-data-dir=${profile}`;
  return listing.split('\n').some((line) => {
    const row = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!row || Number(row[1]) !== pgid) return false;
    const at = row[2]!.indexOf(flag);
    return at !== -1 && (row[2]!.length === at + flag.length || row[2]![at + flag.length] === ' ');
  });
}

function chromeIdentityState(record: ProcessRecord & { pid: number }): 'running' | 'gone' | 'unknown' | null {
  const identity = inspectProcessIdentity(record);
  if (identity === 'same') return 'running';
  if (identity === 'unknown') return 'unknown';
  if (identity === 'different' || !processGroupAlive(record.pid)) return 'gone';
  return null;
}

/**
 * Whether the owned Chrome still runs. `lingering` means the recorded process exited but a process of its group,
 * whose id is that pid, still runs Chrome on `profile`. A group id stays reserved only while the original group
 * lives, so a live group whose members do not run on the profile is `gone`, never something to signal, and so is a
 * pid now held by a different process.
 */
export function chromeProcessState(
  record: ProcessRecord & { pid: number },
  profile: string,
): 'running' | 'lingering' | 'gone' | 'unknown' {
  const state = chromeIdentityState(record);
  if (state) return state;
  const listing = getExecutor().runFileQuiet('ps', ['-A', '-ww', '-o', 'pgid=,command='], { timeoutMs: 10_000 });
  if (listing === null) return 'unknown';
  return groupRunsProfile(listing, record.pid, profile) ? 'lingering' : 'gone';
}

/** Checks the owned Chrome process or surviving group without blocking on ps. */
export async function chromeProcessStateAsync(
  record: ProcessRecord & { pid: number },
  profile: string,
  operation?: StimContext,
): Promise<'running' | 'lingering' | 'gone' | 'unknown'> {
  operation?.signal.throwIfAborted();
  const state = chromeIdentityState(record);
  if (state) return state;
  let listing: string | null;
  const args = ['-A', '-ww', '-o', 'pgid=,command='];
  const options = { timeoutMs: 10_000, killSignal: 'SIGKILL' as const };
  if (operation) {
    try {
      listing = await runOperationFile(operation, getExecutor(), 'ps', args, { ...options, cwd: operation.cwd });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      operation.signal.throwIfAborted();
      return 'unknown';
    }
  } else listing = await getExecutor().runFileQuietAsync('ps', args, options);
  if (listing === null) return 'unknown';
  return groupRunsProfile(listing, record.pid, profile) ? 'lingering' : 'gone';
}
