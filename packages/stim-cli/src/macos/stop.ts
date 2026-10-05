import { readMacosRecord, type MacosProcess } from '@stim-cli/core/state';
import { stopHostedMacos } from '../device-host/hosted-macos.ts';
import { inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { macosRuntimeClaim, requiredMacosRecord } from './state.ts';
import { readClaimSet } from '../ownership-claim.ts';

async function stopProcess(record: MacosProcess | undefined): Promise<void> {
  if (!record) return;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const identity = inspectProcessIdentity(record);
    if (identity === 'gone' || identity === 'different') return;
    if (identity !== 'same') {
      throw Object.assign(new Error(`Cannot verify macOS owner pid ${record.pid}; no signal was sent.`), {
        code: 'STIM_MACOS_OWNER_UNVERIFIED',
      });
    }
    process.kill(record.pid, signal);
    if (await waitForProcessExit(record, 5000)) return;
  }
  throw new Error(`Owned macOS process ${record.pid} did not exit.`);
}

export async function stopMacosAppHeld(root: string): Promise<boolean> {
  const record = requiredMacosRecord(root);
  if (!record) return false;
  await stopProcess(record.supervisor);
  await stopProcess(readMacosRecord(root)?.app ?? record.app);
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
    return true;
  };
  return withWorkspaceProcessLock(workspaceDir(root), 'macos-launch', stop, {
    external: true,
    waitMs: 0,
    ownerPurpose: 'stop macOS app',
  });
}
