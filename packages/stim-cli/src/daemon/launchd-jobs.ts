import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { getExecutor } from '../exec.ts';
import { LAUNCHD_TEST_GUARD_ENV } from './launchd-guard-env.ts';

/** The start of every label of a stimd launchd job. */
export const STIMD_LAUNCHD_ROOT = 'dev.stim.stimd.';

const SYSTEM_LAUNCHCTL: ReadonlySet<string> = new Set(['/bin/launchctl', '/usr/bin/launchctl']);

/** Whether a test run forbids this process from reaching the real launchd: its guard is set and PATH finds the system `launchctl`. */
export function realLaunchctlBlocked(): boolean {
  return !!process.env[LAUNCHD_TEST_GUARD_ENV] && SYSTEM_LAUNCHCTL.has(getExecutor().findExecutable('launchctl') ?? '');
}

const LAUNCHCTL_TIMEOUT_MS = 5000;
const SWEEP_BUDGET_MS = 15_000;

export interface StaleHomeJob {
  label: string;
  home: string;
}

/** Whether a job `launchctl print` describes is running, and the `STIM_HOME` in its environment. */
export function parseLaunchdJob(printed: string): { running: boolean; home: string | null } {
  const state = /^\tstate = (.*)$/m.exec(printed)?.[1]?.trim();
  const environment = /^\tenvironment = \{\n((?:\t\t.*\n)*)/m.exec(printed)?.[1] ?? '';
  return { running: state !== 'not running', home: /^\t\tSTIM_HOME => (.+)$/m.exec(environment)?.[1] ?? null };
}

const underVolumes = (path: string) => path === '/Volumes' || path.startsWith('/Volumes/');

/**
 * True only when `home` is absent and the nearest existing ancestor shows that nothing is merely unmounted: an
 * unreadable path, a dangling symlink on the way, and anything under /Volumes cannot be judged (invariant 8).
 */
export function homeIsGone(home: string): boolean {
  if (!isAbsolute(home)) return false;
  for (let at = home; ; at = dirname(at)) {
    try {
      lstatSync(at);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if ((code === 'ENOENT' || code === 'ENOTDIR') && dirname(at) !== at) continue;
      return false;
    }
    if (at === home) return false;
    try {
      statSync(at);
      return !underVolumes(home) && !underVolumes(realpathSync(at));
    } catch {
      return false;
    }
  }
}

/**
 * The stimd jobs of the user's launchd domain that are not running and whose `STIM_HOME` no longer exists. One
 * `launchctl list` finds the candidates and one `launchctl print` each reads its home; the sweep stops at its time
 * budget and leaves the rest for the next one.
 */
export async function findStaleHomeJobs(): Promise<StaleHomeJob[]> {
  const uid = process.getuid?.();
  if (uid === undefined || realLaunchctlBlocked()) return [];
  const executor = getExecutor();
  const listed = await executor.runFileQuietAsync('launchctl', ['list'], { timeoutMs: LAUNCHCTL_TIMEOUT_MS });
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  const stale: StaleHomeJob[] = [];
  for (const line of (listed ?? '').split('\n')) {
    const [pid, , label] = line.split('\t');
    if (pid !== '-' || !label?.startsWith(STIMD_LAUNCHD_ROOT)) continue;
    if (Date.now() > deadline) break;
    const printed = await executor.runFileQuietAsync('launchctl', ['print', `gui/${uid}/${label}`], {
      timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    });
    const { running, home } = parseLaunchdJob(printed ?? '');
    if (printed && !running && home && homeIsGone(home)) stale.push({ label, home });
  }
  return stale;
}

/** Removes the jobs `findStaleHomeJobs` returns and gives the ones it removed. */
export async function removeStaleHomeJobs(): Promise<StaleHomeJob[]> {
  const removed: StaleHomeJob[] = [];
  for (const job of await findStaleHomeJobs()) {
    const done = await getExecutor().runFileQuietAsync('launchctl', ['remove', job.label], {
      timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    });
    if (done !== null) removed.push(job);
  }
  return removed;
}
