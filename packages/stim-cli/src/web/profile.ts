import { readlinkSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pidExists } from '../metro.ts';
import { processGroupAlive } from '../ownership-claim.ts';
import { inspectProcessIdentity, type ProcessRecord } from '../process-identity.ts';

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

/**
 * Whether the owned Chrome still runs. `lingering` means the recorded process exited but its process group, whose
 * id is that pid, still has helper processes: a live group id cannot be reused. A pid now held by a different
 * process is `gone`, never something to signal.
 */
export function chromeProcessState(
  record: ProcessRecord & { pid: number },
): 'running' | 'lingering' | 'gone' | 'unknown' {
  const identity = inspectProcessIdentity(record);
  if (identity === 'same') return 'running';
  if (identity === 'unknown') return 'unknown';
  if (identity === 'different') return 'gone';
  return processGroupAlive(record.pid) ? 'lingering' : 'gone';
}
