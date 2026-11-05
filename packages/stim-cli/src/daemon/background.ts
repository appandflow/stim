import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { daemonDir, maintenanceChildLogFile, readJsonObject } from '@stim-cli/core/state';
import { windowsLauncherArgs } from '../detached-entry.ts';
import { getExecutor } from '../exec.ts';
import { capChildLog } from '../maintenance/attempt.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { daemonMode } from './mode.ts';
import { HOME_PASSES_TEST_GUARD_ENV } from './passes-guard-env.ts';

/** The activity pass decides nothing new more often than the daemon's own tick. */
const MIN_INTERVAL_MS = 60_000;

const stampFile = () => join(daemonDir(), 'command-passes.json');

/** Whether a background pass is due: the last one started at least a minute ago, or no readable record says so. */
function backgroundPassesDue(now: number): boolean {
  const at = readJsonObject(stampFile())?.at;
  return typeof at !== 'number' || !Number.isFinite(at) || at > now || now - at >= MIN_INTERVAL_MS;
}

function stampBackgroundPasses(now: number): void {
  mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
  const file = stampFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ at: now })}\n`);
  try {
    renameSync(tmp, file);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/**
 * Starts the in-process passes in a detached child that prints nothing and that the command does not wait for, at
 * most once a minute and never while `daemon.mode` is off. The child's output goes to the maintenance child log.
 */
export function spawnBackgroundPasses(
  trigger: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  try {
    if (env[HOME_PASSES_TEST_GUARD_ENV] || daemonMode(env) === 'off') return;
    const now = Date.now();
    if (!backgroundPassesDue(now)) return;
    stampBackgroundPasses(now);
    capChildLog();
    const logFile = maintenanceChildLogFile();
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, 'a');
    try {
      const cwd = process.cwd();
      const entry = spawnEntry('passes-run');
      const launcher = platform === 'win32' ? windowsLauncherArgs({ entry, args: [trigger], cwd, logFile }) : null;
      const child = getExecutor().spawn(launcher?.file ?? process.execPath, launcher?.args ?? [entry, trigger], {
        cwd,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...env, ...launcher?.env },
        ...(launcher ? { windowsHide: true } : {}),
      });
      child.on?.('error', () => {});
      child.unref?.();
    } finally {
      closeSync(fd);
    }
  } catch {}
}
