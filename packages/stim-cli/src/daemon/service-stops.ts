import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { ServiceRecord } from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { workspaceProcessLockError } from '../engine/workspace-process-lock.ts';
import { forgetExitedServices, serviceProcessPids, serviceRecords, serviceRunning, stopServices } from '../services.ts';
import { checkoutOwnerOf } from '../workspace/checkout-role.ts';
import { discoveredReads, type DiscoveredReads } from '../workspace/discovered-reads.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { idleMinutesSetting, resolveProjectSettingsAsync } from '../workspace/settings.ts';
import { writeWorkspaceEvent, type IdlePassInput } from './idle.ts';
import { sourceCheckoutIdle } from './stages.ts';

const MINUTE_MS = 60_000;
const SETTING = 'idle.minutes';

type Outcome = { outcome: 'stopped' | 'would-stop' | 'kept' | 'failed'; detail: string };

/**
 * Stops the running services Stim started in a registered workspace once it has had no activity for `idle.minutes` by
 * the full evidence (Stim activity, source and git writes, and no process or agent session working in its checkout)
 * and nothing keeps it. A service whose stop failed waits `idle.minutes` before the next try.
 */
export async function runServiceStopPass(
  input: Pick<IdlePassInput, 'config' | 'act' | 'log' | 'operation' | 'protectedRoot'>,
): Promise<void> {
  const { config, operation } = input;
  if (!config) return;
  const reads = discoveredReads(operation?.signal);
  for (const path of Object.keys(config.projects)) {
    operation?.signal.throwIfAborted();
    const running = Object.entries(serviceRecords(path)).filter(([, record]) => record.state === 'running');
    if (!running.length) continue;
    let result: Outcome | null;
    try {
      if (input.protectedRoot && canonicalPath(input.protectedRoot) === canonicalPath(path)) continue;
      result = await decide(path, running, input, reads);
    } catch (error) {
      if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
      operation?.signal.throwIfAborted();
      result = workspaceProcessLockError(error)
        ? null
        : { outcome: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }
    if (!result || result.outcome === 'kept') continue;
    input.log(
      result.outcome === 'failed' ? 'warn' : 'info',
      `workspace_services_${result.outcome.replace('-', '_')}`,
      `${path}: ${result.detail}`,
      { workspace: path },
    );
  }
}

async function decide(
  path: string,
  running: [string, ServiceRecord][],
  input: Pick<IdlePassInput, 'act' | 'operation'>,
  shared: DiscoveredReads,
): Promise<Outcome | null> {
  const { operation } = input;
  const { settings } = await resolveProjectSettingsAsync(
    path,
    operation ? { env: operation.env, signal: operation.signal, declareFor: operation } : {},
  );
  const exited: string[] = [];
  for (const [name, record] of running) if (!(await serviceRunning(record))) exited.push(name);
  // @ref LLP 0027#the-idle-pass-stops-services -- bookkeeping, also in report mode, so a dead service lets stimd exit
  if (exited.length) await forgetExitedServices(path, exited, operation?.signal, 0);
  const minutes = idleMinutesSetting(settings);
  if (minutes <= 0) return null;
  const thresholdMs = minutes * MINUTE_MS;
  const due = running.flatMap(([name, record]) =>
    !exited.includes(name) && !(Date.now() - Date.parse(record.idleStopFailedAt ?? '') < thresholdMs) ? [name] : [],
  );
  if (!due.length) return null;
  const { checkout } = await checkoutOwnerOf(path, operation);
  if (typeof checkout !== 'string') return null;
  const own = await serviceProcessPids(path, operation);
  const reads: DiscoveredReads = {
    ...shared,
    processes: async () => {
      const table = await shared.processes();
      return (
        table && {
          commands: table.commands.filter(({ pid }) => !own.has(pid)),
          cwds: table.cwds.filter(({ pid }) => !own.has(pid)),
        }
      );
    },
  };
  const verdict = await sourceCheckoutIdle(path, thresholdMs, SETTING, { operation, reads, checkout });
  if ('kept' in verdict) return null;
  const why = `no activity for ${Math.floor(verdict.idleMs / MINUTE_MS)} minutes (${SETTING} is ${minutes})`;
  if (!input.act) return { outcome: 'would-stop', detail: `${why}; daemon.mode report acts on nothing` };
  const run = await withIdleWorkspace(
    path,
    async (): Promise<Outcome> => {
      const again = await sourceCheckoutIdle(path, thresholdMs, SETTING, { operation, reads, checkout, locked: true });
      if ('kept' in again) return { outcome: 'kept', detail: again.kept };
      const outcomes = await stopServices(path, undefined, 'idle', {
        names: due,
        waitMs: 0,
        ...(operation ? { operation, signal: operation.signal } : {}),
      });
      const failed = outcomes.filter((outcome) => outcome.outcome === 'failed');
      const stopped = outcomes.filter((outcome) => outcome.outcome === 'stopped').map((outcome) => outcome.name);
      const detail = `${why}: ${[
        ...(stopped.length ? [`stopped ${stopped.join(', ')}`] : []),
        ...failed.map((outcome) => `${outcome.name}: ${outcome.detail}`),
      ].join('; ')}. stim revive starts them again.`;
      writeWorkspaceEvent(path, failed.length ? 'warn' : 'info', 'workspace_services_stop', detail);
      return { outcome: failed.length ? 'failed' : 'stopped', detail };
    },
    { purpose: 'service idle stop', operation },
  );
  return run.ran ? run.value : { outcome: 'kept', detail: `in use: ${run.reasons.join('; ')}` };
}
