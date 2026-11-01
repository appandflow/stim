import { readMacosRecord, type MacosProcess } from '@stim-cli/core/state';
import { stopHostedMacos } from '../device-host/hosted-macos.ts';
import { inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { withWorkspaceStateLockAsync, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { hostedBundleDirs, runningBundleInstancesAsync, runningInstancesInAsync } from './instances.ts';
import { macosRuntimeClaim, requiredMacosRecord } from './state.ts';
import { readClaimSet } from '../ownership-claim.ts';
import type { StimContext } from '@stim-cli/core';

const APP_EXIT_MS = 5000;
const SUPERVISOR_EXIT_MS = 2 * APP_EXIT_MS + 2000;

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function stopProcesses(
  records: readonly MacosProcess[],
  waitMs = APP_EXIT_MS,
  operation?: StimContext,
): Promise<void> {
  let live = [...new Map(records.map((record) => [record.pid, record])).values()];
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    operation?.signal.throwIfAborted();
    live = live.filter((record) => {
      const identity = inspectProcessIdentity(record);
      if (identity === 'gone' || identity === 'different') return false;
      if (identity !== 'same') {
        throw Object.assign(new Error(`Cannot verify macOS owner pid ${record.pid}; no signal was sent.`), {
          code: 'STIM_MACOS_OWNER_UNVERIFIED',
        });
      }
      return true;
    });
    for (const record of live) {
      operation?.signal.throwIfAborted();
      signal(record.pid, name);
    }
    const exited = await Promise.all(live.map((record) => waitForProcessExit(record, waitMs, operation?.signal)));
    live = live.filter((_, index) => !exited[index]);
    if (!live.length) return;
  }
  throw new Error(`Owned macOS process ${live.map((record) => record.pid).join(', ')} did not exit.`);
}

/** Stops every running copy of the workspace's owned app bundle, including copies LaunchServices started. */
export async function stopBundleInstances(root: string, operation?: StimContext): Promise<boolean> {
  const instances = await runningBundleInstancesAsync(root, operation);
  await stopProcesses(instances, undefined, operation);
  return instances.length > 0;
}

/** Stops every running copy of a hosted session's app bundles, including copies LaunchServices started from an earlier attempt. */
export async function stopHostedBundleInstances(area: string, operation?: StimContext): Promise<void> {
  await stopProcesses(await runningInstancesInAsync(hostedBundleDirs(area), operation), undefined, operation);
}

export async function stopMacosAppHeld(root: string, operation?: StimContext): Promise<boolean> {
  operation?.signal.throwIfAborted();
  const record = requiredMacosRecord(root);
  if (record?.supervisor) await stopProcesses([record.supervisor], SUPERVISOR_EXIT_MS, operation);
  const app = readMacosRecord(root)?.app ?? record?.app;
  if (app) await stopProcesses([app], undefined, operation);
  const instances = await runningBundleInstancesAsync(root, operation);
  await stopProcesses(instances, undefined, operation);
  operation?.signal.throwIfAborted();
  if (!record) return instances.length > 0;
  const claims = readClaimSet(macosRuntimeClaim(root));
  if (claims.unresolved.length || claims.live.length) {
    throw Object.assign(
      new Error('The macOS runtime claim cannot be released; inspect its recorded owner before cleanup.'),
      {
        code: 'STIM_MACOS_OWNER_UNVERIFIED',
      },
    );
  }
  return true;
}

/** Stops the workspace's app here, or its session on the hosting Mac, which must confirm the session stopped. */
export function stopMacosApp(root: string, operation?: StimContext): Promise<boolean> {
  const stop = async () => {
    operation?.signal.throwIfAborted();
    const record = requiredMacosRecord(root);
    if (!record?.host) return stopMacosAppHeld(root, operation);
    await stopHostedMacos(root, record.host, operation?.signal);
    operation?.signal.throwIfAborted();
    const { host: _host, hostLaunched: _launched, ...stopped } = record;
    await withWorkspaceStateLockAsync(
      root,
      () => writeWorkspaceState(root, { macos: { ...stopped, supervisor: undefined } }),
      operation?.signal,
    );
    return true;
  };
  return withWorkspaceProcessLock(workspaceDir(root), 'macos-launch', stop, {
    external: true,
    waitMs: 0,
    ownerPurpose: 'stop macOS app',
    signal: operation?.signal,
    declareSpawnsFor: operation,
  });
}
