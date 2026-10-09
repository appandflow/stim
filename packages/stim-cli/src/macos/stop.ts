import { readMacosRecord, type MacosProcess } from '@stim-cli/core/state';
import { stopHostedMacos } from '../device-host/hosted-macos.ts';
import { inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { runningBundleInstances } from './instances.ts';
import { macosRuntimeClaim, requiredMacosRecord } from './state.ts';
import { readClaimSet } from '../ownership-claim.ts';

const APP_EXIT_MS = 5000;
const SUPERVISOR_EXIT_MS = 2 * APP_EXIT_MS + 2000;

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function stopProcesses(records: readonly MacosProcess[], waitMs = APP_EXIT_MS): Promise<void> {
  let live = [...new Map(records.map((record) => [record.pid, record])).values()];
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
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
    for (const record of live) signal(record.pid, name);
    const exited = await Promise.all(live.map((record) => waitForProcessExit(record, waitMs)));
    live = live.filter((_, index) => !exited[index]);
    if (!live.length) return;
  }
  throw new Error(`Owned macOS process ${live.map((record) => record.pid).join(', ')} did not exit.`);
}

/** Stops every running copy of the workspace's owned app bundle, including copies LaunchServices started. */
export async function stopBundleInstances(root: string): Promise<boolean> {
  const instances = runningBundleInstances(root);
  await stopProcesses(instances);
  return instances.length > 0;
}

export async function stopMacosAppHeld(root: string): Promise<boolean> {
  const record = requiredMacosRecord(root);
  if (record?.supervisor) await stopProcesses([record.supervisor], SUPERVISOR_EXIT_MS);
  const app = readMacosRecord(root)?.app ?? record?.app;
  const instances = runningBundleInstances(root);
  await stopProcesses(app ? [app, ...instances] : instances);
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
export function stopMacosApp(root: string): Promise<boolean> {
  const stop = async () => {
    const record = requiredMacosRecord(root);
    if (!record?.host) return stopMacosAppHeld(root);
    await stopHostedMacos(root, record.host);
    const { host: _host, hostLaunched: _launched, ...stopped } = record;
    writeWorkspaceState(root, { macos: { ...stopped, supervisor: undefined } });
    await stopBundleInstances(root);
    return true;
  };
  return withWorkspaceProcessLock(workspaceDir(root), 'macos-launch', stop, {
    external: true,
    waitMs: 0,
    ownerPurpose: 'stop macOS app',
  });
}
