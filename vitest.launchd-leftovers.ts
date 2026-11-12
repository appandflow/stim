import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

const STIMD_JOB = 'dev.stim.stimd.';
const LAUNCHCTL_TIMEOUT_MS = 5000;
const BUDGET_MS = 30_000;

export type LaunchdLeftover = { label: string; home: string };

/**
 * The stimd launchd jobs of the user's domain whose `STIM_HOME` lies under `root`, which a run that starts stimd
 * through the real launchd leaves registered. Call it while `root` still exists, so its real path resolves.
 */
export function launchdJobsUnder(root: string): LaunchdLeftover[] {
  const uid = process.getuid?.();
  if (process.platform !== 'darwin' || uid === undefined) return [];
  const roots = [...new Set([root, realpathSync(root)])].map((path) => path + sep);
  const listed = spawnSync('launchctl', ['list'], { encoding: 'utf8', timeout: LAUNCHCTL_TIMEOUT_MS });
  const found: LaunchdLeftover[] = [];
  const deadline = Date.now() + BUDGET_MS;
  for (const line of (listed.stdout ?? '').split('\n')) {
    const label = line.split('\t')[2];
    if (!label?.startsWith(STIMD_JOB) || Date.now() > deadline) continue;
    const printed = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], {
      encoding: 'utf8',
      timeout: LAUNCHCTL_TIMEOUT_MS,
    });
    const environment = /^\tenvironment = \{\n((?:\t\t.*\n)*)/m.exec(printed.stdout ?? '')?.[1] ?? '';
    const home = /^\t\tSTIM_HOME => (.+)$/m.exec(environment)?.[1];
    if (home && roots.some((prefix) => home.startsWith(prefix))) found.push({ label, home });
  }
  return found;
}

/** Removes the jobs `launchdJobsUnder` found and describes them for a failure message. */
export function removeLaunchdLeftovers(jobs: readonly LaunchdLeftover[]): string {
  for (const { label } of jobs) spawnSync('launchctl', ['remove', label], { timeout: LAUNCHCTL_TIMEOUT_MS });
  return jobs.map(({ label, home }) => `${label} serving ${home}`).join('; ');
}
