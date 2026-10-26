import chalk from 'chalk';
import type { StimContext } from '@stim-cli/core';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { cachedDeviceActivity, cachedDeviceActivityAsync } from '../../maintenance/activity.ts';
import { planIdleStop, stopIdleWorkspace, type IdleStopOutcome } from '../../maintenance/idle-stop.ts';
import { triggeringRoot } from '../../maintenance/preview.ts';
import type { GcOutput } from './results.ts';

/** Stops each workspace idle past its maintenance.idleStopHours, as automatic maintenance does; returns failures. */
export async function stopIdleWorkspaces(output: GcOutput, operation?: StimContext): Promise<number> {
  const env = operation?.env ?? process.env;
  const devices = () => {
    const now = Date.now();
    return operation ? cachedDeviceActivityAsync(now, env, operation.signal, operation) : cachedDeviceActivity(now);
  };
  const protectedRoot = triggeringRoot(operation);
  const plan = await planIdleStop({ protectedRoot, now: Date.now(), env, devices: devices(), operation });
  let failures = 0;
  for (const action of plan.actions) {
    operation?.signal.throwIfAborted();
    let outcome: IdleStopOutcome;
    try {
      outcome = await stopIdleWorkspace(action, { protectedRoot, devices, operation });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
      operation?.signal.throwIfAborted();
      outcome = { status: 'failed', bytes: 0, detail: error instanceof Error ? error.message : String(error) };
    }
    output.record('devServer', outcome.status, action.target, {
      detail: outcome.status === 'done' ? action.reason : outcome.detail,
    });
    if (outcome.status === 'done')
      output.log(chalk.green(`Stopped the idle workspace ${action.target}: ${action.reason}`));
    else if (outcome.status === 'kept') output.log(chalk.dim(`Kept the workspace ${action.target}: ${outcome.detail}`));
    else {
      failures++;
      output.log(chalk.red(`Could not stop the idle workspace ${action.target}: ${outcome.detail}`));
    }
  }
  return failures;
}
