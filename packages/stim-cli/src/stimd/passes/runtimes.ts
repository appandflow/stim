import { isScopedHome, type StimContext } from '@stim-cli/core';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { MaintenanceAction } from '@stim-cli/core/state';
import { parseSimRuntimeList, type SimRuntimeRecord } from '../../commands/gc/inventory.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isStimOwnedSim } from '../../devices/device-ownership.ts';
import { projectDeviceSlots } from '../../devices/device-slots.ts';
import { isAbsentPath, isOnMountedVolume, listMountedVolumes } from '../../fs-util.ts';
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

/** What one registered project says about runtimes: its `ios.runtime` pin, or that its settings cannot be read. */
export type ProjectPin =
  | { path: string; state: 'resolved'; pin: string | null }
  | { path: string; state: 'gone' }
  | { path: string; state: 'unresolved'; reason: string };

/**
 * The runtime pins of every registered project, or the projects whose settings cannot be read. A project on an
 * unmounted volume, or with a settings file that cannot be parsed, could pin any runtime, so it blocks runtime cleanup.
 */
export function runtimePins(projects: readonly ProjectPin[]): { pins: string[]; unresolved: string[] } {
  return {
    pins: projects.flatMap((project) => (project.state === 'resolved' && project.pin ? [project.pin] : [])),
    unresolved: projects.flatMap((project) =>
      project.state === 'unresolved' ? [`${project.path}: ${project.reason}`] : [],
    ),
  };
}

function unreadableSettings(dir: string | null): boolean {
  if (!dir) return false;
  const file = join(dir, '.stim.json');
  if (!existsSync(file)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return typeof parsed !== 'object' || parsed === null || Array.isArray(parsed);
  } catch {
    return true;
  }
}

async function projectPins(operation?: StimContext): Promise<ProjectPin[]> {
  const mounted = listMountedVolumes();
  const projects: ProjectPin[] = [];
  for (const path of Object.keys(loadConfig()?.projects ?? {})) {
    if (!existsSync(path)) {
      projects.push(
        isAbsentPath(path) && isOnMountedVolume(path, mounted)
          ? { path, state: 'gone' }
          : { path, state: 'unresolved', reason: 'its path cannot be reached' },
      );
      continue;
    }
    try {
      const { context, settings } = await resolveProjectSettingsAsync(
        path,
        operation ? { env: operation.env, signal: operation.signal, declareFor: operation } : {},
      );
      projects.push(
        [context.projectPath, context.repoRoot].some(unreadableSettings)
          ? { path, state: 'unresolved', reason: 'its .stim.json cannot be read' }
          : { path, state: 'resolved', pin: resolveRuntime(null, settings) },
      );
    } catch (error) {
      if (isClaimUnavailable(error)) throw error;
      operation?.signal.throwIfAborted();
      projects.push({ path, state: 'unresolved', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return projects;
}

function workspaceSimulators(): Set<string> {
  const udids = new Set<string>();
  for (const project of Object.values(loadConfig()?.projects ?? {}))
    for (const { platforms } of projectDeviceSlots(project))
      if (platforms.ios?.deviceUdid) udids.add(platforms.ios.deviceUdid);
  return udids;
}

/**
 * The owned simulators whose runtime is gone that maintenance deletes on its own: those no registered workspace records,
 * such as parked or orphaned ones. A workspace's own simulator goes only through that workspace's dormant stage or
 * teardown, which apply its pin, lock, lease and activity checks.
 */
export function unavailableSimsToDelete<T extends Pick<IosSimRecord, 'udid' | 'available'>>(
  owned: readonly T[],
  inWorkspace: ReadonlySet<string>,
): T[] {
  return owned.filter((sim) => !sim.available && !inWorkspace.has(sim.udid));
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
 * uses, owned or not, available or not, and no registered project pins with `ios.runtime`. The only installed runtime
 * is never deleted, and when no remaining runtime would be used the newest stays, so the machine always keeps one.
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
  const blocked: string[] = [];
  const { pins, unresolved } = runtimePins(await projectPins(operation));
  if (unresolved.length)
    blocked.push(`Simulator runtimes stay until these projects' settings can be read: ${unresolved.join('; ')}`);
  const { take, kept } = unresolved.length ? { take: [], kept: [] } : selectUnusedRuntimes(runtimes, sims, pins);
  for (const runtime of take)
    actions.push({
      kind: 'would-delete-runtime',
      target: runtime.identifier,
      bytes: runtime.sizeBytes ?? 0,
      reason: `${label(runtime)}: no simulator uses it`,
    });
  for (const { runtime, reason } of kept) skips.push({ target: label(runtime), reason });
  for (const sim of unavailableSimsToDelete(sims.filter(isStimOwnedSim), workspaceSimulators()))
    actions.push({
      kind: 'would-delete-unavailable-sim',
      target: sim.udid,
      bytes: sim.dataPathSize ?? 0,
      reason: `${sim.name}: its runtime ${sim.runtime} is no longer installed`,
    });
  return { actions, skips, blocked };
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
    const { pins, unresolved } = runtimePins(await projectPins(operation));
    if (unresolved.length)
      return { status: 'kept', bytes: 0, detail: `project settings cannot be read: ${unresolved.join('; ')}` };
    const { take, kept } = selectUnusedRuntimes(runtimes, sims, pins);
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
  if (workspaceSimulators().has(action.target))
    return { status: 'kept', bytes: 0, detail: 'a registered workspace records it as its simulator' };
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
