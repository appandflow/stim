import type { DaemonWorkspaceDecision } from '@stim-cli/core/state';
import { runMaintenance } from '../maintenance/run.ts';
import { loadConfig, type Config } from '../workspace/config.ts';
import { daemonClaimHeld, daemonMode } from './client.ts';
import { runIdlePass, type IdlePassInput } from './idle.ts';
import { HOME_PASSES_TEST_GUARD_ENV } from './passes-guard-env.ts';
import { measureTick, type TickMeasurement } from './measure.ts';

export interface HomePasses {
  config: Config | null;
  now: number;
  measured: TickMeasurement;
  workspaces: DaemonWorkspaceDecision[];
}

/**
 * One measurement, the activity pass and an automatic maintenance pass, in this process, as the daemon runs them each
 * tick. `act: false` decides and logs without acting.
 */
export async function runHomePasses({
  act,
  trigger,
  log,
}: {
  act: boolean;
  trigger: string;
  log: IdlePassInput['log'];
}): Promise<HomePasses> {
  const config = loadConfig();
  const now = Date.now();
  const measured = await measureTick(config, now);
  const workspaces = await runIdlePass({
    config,
    now,
    sims: measured.sims,
    simsError: measured.simsError,
    devices: measured.devices,
    act,
    log,
  });
  await runMaintenance(trigger, { report: !act });
  return { config, now, measured, workspaces };
}

/**
 * Automatic maintenance at command time, for a command that found no daemon holding the home: Windows, `daemon.mode
 * off`, or a daemon that could not start. The activity pass is the daemon's alone; without one, each dev server
 * supervisor times its own idle stop. The pass never stops the command's own workspace.
 */
export async function runPassesInProcess(trigger: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    if (env[HOME_PASSES_TEST_GUARD_ENV] || daemonClaimHeld()) return;
    await runMaintenance(trigger, { report: daemonMode(env) === 'report' });
  } catch {}
}
