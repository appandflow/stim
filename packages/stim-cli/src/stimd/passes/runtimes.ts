import { isScopedHome, type StimContext } from '@stim-cli/core';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { MaintenanceAction } from '@stim-cli/core/state';
import { parseSimRuntimeList, type SimRuntimeRecord } from '../../commands/gc/inventory.ts';
import { isStimOwnedSim } from '../../devices/device-ownership.ts';
import { listAllIosSimsAsync, type IosSimRecord } from '../../devices/ios.ts';
import { teardownUnavailableOwnedIosSim } from '../../devices/teardown.ts';
import { resolveRuntime } from '../../commands/ios/support.ts';
import { loadConfig } from '../../workspace/config.ts';
import { resolveProjectSettingsAsync } from '../../workspace/settings.ts';
import { getExecutor } from '../../exec.ts';
import { runOperationFile } from '../../engine/operation-exec.ts';
import type { ActionOutcome } from './act.ts';
import type { MaintenancePlan } from './plan.ts';

const SIMCTL_TIMEOUT_MS = 60_000;
const RUNTIME_DELETE_TIMEOUT_MS = 10 * 60_000;

/** The runtime delete argv: `xcrun simctl runtime delete <identifier>`, the image's own identifier. */
const runtimeDeleteArgs = (identifier: string): string[] => ['simctl', 'runtime', 'delete', identifier];

function pinsVersion(pin: string, version: string | null): boolean {
  const wanted = /\d+(?:\.\d+)*/.exec(pin)?.[0];
  return Boolean(wanted && version && (version === wanted || version.startsWith(`${wanted}.`)));
}

async function pinnedRuntimes(operation?: StimContext): Promise<string[]> {
  const pins: string[] = [];
  for (const path of Object.keys(loadConfig()?.projects ?? {})) {
    try {
      const { settings } = await resolveProjectSettingsAsync(
        path,
        operation ? { env: operation.env, signal: operation.signal, declareFor: operation } : {},
      );
      const pin = resolveRuntime(null, settings);
      if (pin) pins.push(pin);
    } catch (error) {
      if (isClaimUnavailable(error)) throw error;
      operation?.signal.throwIfAborted();
    }
  }
  return pins;
}

function versionKey(version: string | null): number[] {
  return (version ?? '').split('.').map((part) => Number(part) || 0);
}

function newer(a: SimRuntimeRecord, b: SimRuntimeRecord): number {
  const [x, y] = [versionKey(a.version), versionKey(b.version)];
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/**
 * Which installed iOS simulator runtime images to delete: those simctl marks deletable, no simulator on the machine
 * uses, owned or not, available or not, and no registered project pins with `ios.runtime`. The only installed runtime is never deleted, and when no remaining
 * runtime would be used the newest stays, so the machine always keeps one runtime.
 */
export function selectUnusedRuntimes(
  runtimes: readonly SimRuntimeRecord[],
  sims: readonly Pick<IosSimRecord, 'runtime'>[],
  pinned: readonly string[] = [],
): {
  take: SimRuntimeRecord[];
  kept: { runtime: SimRuntimeRecord; reason: string }[];
} {
  const kept: { runtime: SimRuntimeRecord; reason: string }[] = [];
  if (runtimes.length <= 1)
    return {
      take: [],
      kept: runtimes.map((runtime) => ({
        runtime,
        reason: 'it is the only installed simulator runtime',
      })),
    };
  const take: SimRuntimeRecord[] = [];
  for (const runtime of runtimes) {
    const users = sims.filter((sim) => sim.runtime === runtime.runtimeIdentifier).length;
    if (!runtime.runtimeIdentifier)
      kept.push({
        runtime,
        reason: 'simctl names no runtime identifier for it',
      });
    else if (users)
      kept.push({
        runtime,
        reason: `${users} ${users === 1 ? 'simulator uses' : 'simulators use'} it`,
      });
    else if (pinned.some((pin) => pinsVersion(pin, runtime.version)))
      kept.push({ runtime, reason: 'a registered project pins it with ios.runtime' });
    else if (!runtime.deletable) kept.push({ runtime, reason: 'simctl does not mark it deletable' });
    else take.push(runtime);
  }
  if (take.length === runtimes.length) {
    const newest = take.toSorted(newer)[0];
    if (newest) {
      take.splice(take.indexOf(newest), 1);
      kept.push({
        runtime: newest,
        reason: 'no simulator uses any runtime, and the newest one stays installed',
      });
    }
  }
  return { take, kept };
}

async function listRuntimes(operation?: StimContext): Promise<SimRuntimeRecord[]> {
  return parseSimRuntimeList(
    await runOperationFile(operation, getExecutor(), 'xcrun', ['simctl', 'runtime', 'list', '-j'], {
      timeoutMs: SIMCTL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      cwd: operation?.cwd,
    }),
  );
}

const label = (runtime: SimRuntimeRecord) => `iOS ${runtime.version ?? '?'} simulator runtime (${runtime.identifier})`;

/**
 * Unused simulator runtimes, and this home's owned simulators whose runtime is gone. Runtimes are not Stim-owned:
 * deleting one no simulator uses is the one exception to device ownership, and nothing is planned in a scoped home,
 * off macOS, or when either listing fails.
 */
export async function planRuntimes(operation?: StimContext): Promise<MaintenancePlan> {
  const env = operation?.env ?? process.env;
  const actions: MaintenanceAction[] = [];
  const skips: MaintenancePlan['skips'] = [];
  if (process.platform !== 'darwin' || isScopedHome(env)) return { actions, skips, blocked: [] };
  let sims: IosSimRecord[];
  let runtimes: SimRuntimeRecord[];
  try {
    sims = await listAllIosSimsAsync({
      includeUnavailable: true,
      operation,
      signal: operation?.signal,
    });
    runtimes = await listRuntimes(operation);
  } catch (error) {
    if (isClaimUnavailable(error)) throw error;
    operation?.signal.throwIfAborted();
    return {
      actions,
      skips,
      blocked: [`Could not list simulator runtimes: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const { take, kept } = selectUnusedRuntimes(runtimes, sims, await pinnedRuntimes(operation));
  for (const runtime of take)
    actions.push({
      kind: 'would-delete-runtime',
      target: runtime.identifier,
      bytes: runtime.sizeBytes ?? 0,
      reason: `${label(runtime)}: no simulator uses it`,
    });
  for (const { runtime, reason } of kept) skips.push({ target: label(runtime), reason });
  for (const sim of sims.filter((entry) => !entry.available && isStimOwnedSim(entry)))
    actions.push({
      kind: 'would-delete-unavailable-sim',
      target: sim.udid,
      bytes: sim.dataPathSize ?? 0,
      reason: `${sim.name}: its runtime ${sim.runtime} is no longer installed`,
    });
  return { actions, skips, blocked: [] };
}

/** Deletes one runtime after listing again and finding it still unused and still not the only one. */
export async function deleteRuntimeAction(action: MaintenanceAction, operation?: StimContext): Promise<ActionOutcome> {
  try {
    const sims = await listAllIosSimsAsync({
      includeUnavailable: true,
      operation,
      signal: operation?.signal,
    });
    const runtimes = await listRuntimes(operation);
    const { take, kept } = selectUnusedRuntimes(runtimes, sims, await pinnedRuntimes(operation));
    const runtime = take.find((entry) => entry.identifier === action.target);
    if (!runtime)
      return {
        status: 'kept',
        bytes: 0,
        detail: kept.find((entry) => entry.runtime.identifier === action.target)?.reason ?? 'it is no longer installed',
      };
    await runOperationFile(operation, getExecutor(), 'xcrun', runtimeDeleteArgs(runtime.identifier), {
      timeoutMs: RUNTIME_DELETE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      cwd: operation?.cwd,
    });
    return {
      status: 'done',
      bytes: runtime.sizeBytes ?? 0,
      detail: `deleted ${label(runtime)}`,
    };
  } catch (error) {
    if (isClaimUnavailable(error)) throw error;
    operation?.signal.throwIfAborted();
    return {
      status: 'failed',
      bytes: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function deleteUnavailableSimAction(
  action: MaintenanceAction,
  operation?: StimContext,
): Promise<ActionOutcome> {
  const outcome = await teardownUnavailableOwnedIosSim(action.target, {
    operation,
  });
  if (outcome.status === 'torn-down')
    return {
      status: 'done',
      bytes: action.bytes,
      detail: `deleted ${outcome.label ?? action.target}`,
    };
  if (outcome.status === 'failed')
    return {
      status: 'failed',
      bytes: 0,
      detail: outcome.reason ?? 'teardown failed',
    };
  return { status: 'kept', bytes: 0, detail: outcome.reason ?? 'it is gone' };
}
