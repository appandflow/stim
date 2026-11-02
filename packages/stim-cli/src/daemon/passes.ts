import type { DaemonWorkspaceDecision } from '@stim-cli/core/state';
import { runMaintenance } from '../maintenance/run.ts';
import { loadConfig, type Config } from '../workspace/config.ts';
import { runIdlePass, type IdlePassInput } from './idle.ts';
import { measureTick, type TickMeasurement } from './measure.ts';

export interface HomePasses {
  config: Config | null;
  now: number;
  measured: TickMeasurement;
  workspaces: DaemonWorkspaceDecision[];
}

/**
 * One measurement, the activity pass and an automatic maintenance pass, in this process. The daemon runs them each
 * tick; `stim doctor` runs them when no daemon holds the home. `act: false` decides and logs without acting.
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
