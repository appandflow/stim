import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';

const LAUNCHCTL = '/bin/launchctl';
const STIMD_JOB = 'dev.stim.stimd.';
const LAUNCHCTL_TIMEOUT_MS = 5000;
const BUDGET_MS = 30_000;

export type LaunchdLeftover = { label: string; home: string };

/**
 * Puts a `launchctl` that always fails first on PATH, so no test process or child that inherits PATH registers or
 * removes a job in the developer's launchd domain, whatever executor or environment it builds. A test of the launchd
 * path puts its own stub before it.
 */
export function installRefusingLaunchctl(directory: string): void {
  if (process.platform === 'win32') return;
  const bin = join(directory, 'stim-test-launchctl');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, 'launchctl');
  writeFileSync(stub, '#!/bin/sh\necho "launchctl is not available to tests" >&2\nexit 1\n');
  chmodSync(stub, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
}

/**
 * The stimd launchd jobs of the user's domain whose `STIM_HOME` lies under `root`, which a run that starts stimd
 * through the real launchd leaves registered. Call it while `root` still exists, so its real path resolves. It runs
 * the system `launchctl` by absolute path, so the refusing stub cannot blind it.
 */
export function launchdJobsUnder(root: string): LaunchdLeftover[] {
  const uid = process.getuid?.();
  if (process.platform !== 'darwin' || uid === undefined) return [];
  const roots = [...new Set([root, realpathSync(root)])].map((path) => path + sep);
  const listed = spawnSync(LAUNCHCTL, ['list'], { encoding: 'utf8', timeout: LAUNCHCTL_TIMEOUT_MS });
  const found: LaunchdLeftover[] = [];
  const deadline = Date.now() + BUDGET_MS;
  for (const line of (listed.stdout ?? '').split('\n')) {
    const label = line.split('\t')[2];
    if (!label?.startsWith(STIMD_JOB) || Date.now() > deadline) continue;
    const printed = spawnSync(LAUNCHCTL, ['print', `gui/${uid}/${label}`], {
      encoding: 'utf8',
      timeout: LAUNCHCTL_TIMEOUT_MS,
    });
    const environment = /^\tenvironment = \{\n((?:\t\t.*\n)*)/m.exec(printed.stdout ?? '')?.[1] ?? '';
    const home = /^\t\tSTIM_HOME => (.+)$/m.exec(environment)?.[1];
    if (home && roots.some((prefix) => home.startsWith(prefix))) found.push({ label, home });
  }
  return found;
}

/** Removes the jobs `launchdJobsUnder` found, and describes the first three for a failure message. */
export function removeLaunchdLeftovers(jobs: readonly LaunchdLeftover[]): string {
  for (const { label } of jobs) spawnSync(LAUNCHCTL, ['remove', label], { timeout: LAUNCHCTL_TIMEOUT_MS });
  const shown = jobs.slice(0, 3).map(({ label, home }) => `${label} serving ${home}`);
  return jobs.length > 3 ? `${shown.join('; ')}; and ${jobs.length - 3} more` : shown.join('; ');
}
