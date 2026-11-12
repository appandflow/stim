import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { parseLaunchctlPrint } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';

/** The start of every label of a stimd launchd job. */
export const STIMD_LAUNCHD_ROOT = 'dev.stim.stimd.';

const LAUNCHCTL_TIMEOUT_MS = 5000;
const PATH_TIMEOUT_MS = 2000;
const SWEEP_BUDGET_MS = 15_000;

export interface StaleHomeJob {
  label: string;
  home: string;
}

/** Whether a job `launchctl print` describes is running, and the `STIM_HOME` in its environment. */
export function parseLaunchdJob(printed: string): { running: boolean; home: string | null } {
  const environment = /^\tenvironment = \{\n((?:\t\t.*\n)*)/m.exec(printed)?.[1] ?? '';
  return {
    running: parseLaunchctlPrint(printed).state !== 'not running',
    home: /^\t\tSTIM_HOME => (.+)$/m.exec(environment)?.[1] ?? null,
  };
}

const underVolumes = (path: string) => path === '/Volumes' || path.startsWith('/Volumes/');

/**
 * True when `home` is absent and its nearest existing ancestor is a reachable folder outside /Volumes. Unreadable
 * paths, a dangling symlink on the way, anything under /Volumes and any path that does not answer within two seconds
 * are kept. A share mounted elsewhere, such as SMB or NFS at `~/mnt/x`, is not recognised as unmounted: its home reads
 * as gone while the mount point is empty.
 */
export async function homeIsGone(home: string): Promise<boolean> {
  if (!isAbsolute(home)) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), PATH_TIMEOUT_MS);
    timer.unref();
  });
  const judge = async (): Promise<boolean> => {
    for (let at = home; ; at = dirname(at)) {
      try {
        await lstat(at);
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if ((code === 'ENOENT' || code === 'ENOTDIR') && dirname(at) !== at) continue;
        return false;
      }
      if (at === home) return false;
      try {
        await stat(at);
        return !underVolumes(home) && !underVolumes(await realpath(at));
      } catch {
        return false;
      }
    }
  };
  try {
    return await Promise.race([judge(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The stimd jobs of the user's launchd domain that are not running and whose `STIM_HOME` no longer exists. One
 * `launchctl list` finds the candidates and one `launchctl print` each reads its home. Every call counts against
 * `deadline`; what it has not reached is left for the next sweep.
 */
export async function findStaleHomeJobs(deadline: number = Date.now() + SWEEP_BUDGET_MS): Promise<StaleHomeJob[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const executor = getExecutor();
  const timeoutMs = () => Math.min(LAUNCHCTL_TIMEOUT_MS, deadline - Date.now());
  const listed =
    timeoutMs() > 0 ? await executor.runFileQuietAsync('launchctl', ['list'], { timeoutMs: timeoutMs() }) : null;
  const stale: StaleHomeJob[] = [];
  for (const line of (listed ?? '').split('\n')) {
    const [pid, , label] = line.split('\t');
    if (pid !== '-' || !label?.startsWith(STIMD_LAUNCHD_ROOT)) continue;
    if (timeoutMs() <= 0) break;
    const printed = await executor.runFileQuietAsync('launchctl', ['print', `gui/${uid}/${label}`], {
      timeoutMs: timeoutMs(),
    });
    const { running, home } = parseLaunchdJob(printed ?? '');
    if (printed && !running && home && (await homeIsGone(home))) stale.push({ label, home });
  }
  return stale;
}

/** Removes the jobs `findStaleHomeJobs` returns and gives the ones it removed; `list`, `print` and `remove` share one budget. */
export async function removeStaleHomeJobs(budgetMs: number = SWEEP_BUDGET_MS): Promise<StaleHomeJob[]> {
  const deadline = Date.now() + budgetMs;
  const removed: StaleHomeJob[] = [];
  for (const job of await findStaleHomeJobs(deadline)) {
    const timeoutMs = Math.min(LAUNCHCTL_TIMEOUT_MS, deadline - Date.now());
    if (timeoutMs <= 0) break;
    const done = await getExecutor().runFileQuietAsync('launchctl', ['remove', job.label], { timeoutMs });
    if (done !== null) removed.push(job);
  }
  return removed;
}
