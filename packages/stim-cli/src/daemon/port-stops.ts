import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { PORT_IDLE_STOP_KEY, readPortIdleStop, type PortIdleStopRecord } from '@stim-cli/core/state';
import { canonicalPath } from '../commands/gc/paths.ts';
import { portsWithListener, recordedCommands, runPortCommands } from '../named-ports.ts';
import { checkoutOwnerOf } from '../workspace/checkout-role.ts';
import { discoveredReads } from '../workspace/discovered-reads.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { idleMinutesSetting, resolveProjectSettingsAsync } from '../workspace/settings.ts';
import { readWorkspaceState, updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
import { writeWorkspaceEvent, type IdlePassInput } from './idle.ts';
import { sourceCheckoutIdle } from './stages.ts';

const MINUTE_MS = 60_000;
const SETTING = 'idle.minutes';

type Outcome = { outcome: 'stopped' | 'would-stop' | 'kept' | 'failed'; detail: string };

/**
 * The servers of a registered workspace's named ports that have a recorded stop command and a listener, when the
 * workspace has had no activity for `idle.minutes` by the full evidence (Stim activity, source and git writes, and no
 * process or agent session working in its checkout) and nothing keeps it: their stop commands run and their
 * allocations stay. A failed run waits `idle.minutes` before the next.
 */
export async function runPortStopPass(
  input: Pick<IdlePassInput, 'config' | 'act' | 'log' | 'operation' | 'protectedRoot'>,
): Promise<void> {
  const { config, operation } = input;
  if (!config) return;
  const reads = discoveredReads(operation?.signal);
  for (const [path, project] of Object.entries(config.projects)) {
    operation?.signal.throwIfAborted();
    const stops = project.portCommands;
    const labelled = Object.entries(project.ports ?? {}).filter(([name]) => stops && Object.hasOwn(stops, name));
    if (!labelled.length) continue;
    let result: Outcome | null;
    try {
      if (input.protectedRoot && canonicalPath(input.protectedRoot) === canonicalPath(path)) continue;
      if (!(await portsWithListener(labelled.map(([, port]) => port))).length) continue;
      result = await decide(path, input, reads);
    } catch (error) {
      if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
      operation?.signal.throwIfAborted();
      result = { outcome: 'failed', detail: error instanceof Error ? error.message : String(error) };
    }
    if (!result || result.outcome === 'kept') continue;
    input.log(
      result.outcome === 'failed' ? 'warn' : 'info',
      `workspace_port_${result.outcome.replace('-', '_')}`,
      `${path}: ${result.detail}`,
      {
        workspace: path,
      },
    );
  }
}

async function decide(
  path: string,
  input: Pick<IdlePassInput, 'act' | 'operation'>,
  reads: ReturnType<typeof discoveredReads>,
): Promise<Outcome | null> {
  const { operation } = input;
  const { settings } = await resolveProjectSettingsAsync(
    path,
    operation ? { env: operation.env, signal: operation.signal, declareFor: operation } : {},
  );
  const minutes = idleMinutesSetting(settings);
  if (minutes <= 0) return null;
  const thresholdMs = minutes * MINUTE_MS;
  const attempt = readPortIdleStop(readWorkspaceState(path));
  if (attempt?.failed && Date.now() - Date.parse(attempt.at) < thresholdMs) return null;
  const { checkout } = await checkoutOwnerOf(path, operation);
  if (typeof checkout !== 'string') return null;
  const verdict = await sourceCheckoutIdle(path, thresholdMs, SETTING, { operation, reads, checkout });
  if ('kept' in verdict) return null;
  const why = `no activity for ${Math.floor(verdict.idleMs / MINUTE_MS)} minutes (${SETTING} is ${minutes})`;
  if (!input.act) return { outcome: 'would-stop', detail: `${why}; daemon.mode report acts on nothing` };
  const run = await withIdleWorkspace(
    path,
    async (): Promise<Outcome> => {
      const again = await sourceCheckoutIdle(path, thresholdMs, SETTING, { operation, reads, checkout, locked: true });
      if ('kept' in again) return { outcome: 'kept', detail: again.kept };
      const { done, labels, failures } = await runPortCommands(
        path,
        'stop',
        operation ? { operation, signal: operation.signal } : {},
      );
      await updateWorkspaceStateAsync(path, (state) => {
        const record: PortIdleStopRecord = {
          at: new Date().toISOString(),
          failed: failures.length > 0,
          stopped: [...new Set([...(readPortIdleStop(state)?.stopped ?? []), ...labels])],
        };
        return { ...state, [PORT_IDLE_STOP_KEY]: record };
      });
      const resumable = labels.some((label) => recordedCommands(path, label).resume);
      const detail = `${why}: ${[...(done.length ? [`stopped ${done.join('; ')}`] : []), ...failures].join('; ') || 'nothing listened any more'}. The allocations stay; ${resumable ? 'stim revive runs their resume commands' : 'start the servers again the way you started them'}.`;
      writeWorkspaceEvent(path, failures.length ? 'warn' : 'info', 'workspace_port_stop', detail);
      return { outcome: failures.length ? 'failed' : 'stopped', detail };
    },
    { purpose: 'named port stop', operation },
  );
  return run.ran ? run.value : { outcome: 'kept', detail: `in use: ${run.reasons.join('; ')}` };
}
