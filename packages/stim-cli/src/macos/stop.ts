import { readMacosRecord, type MacosProcess } from '@stim-cli/core/state';
import { inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { workspaceDir } from '../workspace/paths.ts';
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

export function stopMacosApp(root: string): Promise<boolean> {
  return withWorkspaceProcessLock(workspaceDir(root), 'macos-launch', () => stopMacosAppHeld(root), {
    external: true,
    waitMs: 0,
    ownerPurpose: 'stop macOS app',
  });
}
