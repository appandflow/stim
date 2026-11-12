import { daemonClaimRoot } from '@stim-cli/core/state';
import { readClaimSet, type ClaimOwner } from '@stim-cli/core/ownership-claim';
import { inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';

// compat C30 until 2.1.0
const EXIT_WAIT_MS = 10_000;

export interface LegacyDaemonHolder {
  owner: ClaimOwner;
  /** Whether the claim carries the record a pre-2.0 stim-daemon writes: its socket and its mode. */
  stimDaemon: boolean;
}

/** The live exclusive holder of the daemon claim, which only a stim-daemon from before Stim 2.0 takes. */
export function legacyDaemonHolder(): LegacyDaemonHolder | null {
  try {
    const holder = readClaimSet(daemonClaimRoot()).live.find((entry) => entry.mode === 'exclusive');
    return holder
      ? {
          owner: holder.owner,
          stimDaemon: typeof holder.details.socket === 'string' && typeof holder.details.mode === 'string',
        }
      : null;
  } catch {
    return null;
  }
}

/** Sends SIGTERM to `owner` only while its identity reads `same`, in this one synchronous step. */
function terminate(owner: ClaimOwner): boolean {
  if (inspectProcessIdentity(owner) !== 'same') return false;
  try {
    process.kill(owner.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Stops a stim-daemon from before Stim 2.0 that holds this home's daemon claim exclusively, and waits for its process
 * to end. The old daemon has no stop request; on SIGTERM it releases its claim, and it owns no child: dev servers,
 * log collectors and devices run on and stay as they are. Returns the pid it stopped, or null when it signalled nothing
 * or the process was still running after the wait.
 */
export async function takeOverLegacyDaemon(): Promise<number | null> {
  const holder = legacyDaemonHolder();
  if (!holder?.stimDaemon || !terminate(holder.owner)) return null;
  return (await waitForProcessExit(holder.owner, EXIT_WAIT_MS)) ? holder.owner.pid : null;
}
// compat end

/** The remedy for a holder Stim does not stop: its pid and the command that ends it. */
export function legacyDaemonStop(pid: number): string {
  return process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
}
