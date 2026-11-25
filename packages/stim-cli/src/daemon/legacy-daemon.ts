import { daemonClaimRoot, legacyDaemonSocket } from '@stim-cli/core/state';
import { readClaimSet, type ClaimHolder, type ClaimOwner } from '@stim-cli/core/ownership-claim';

// compat C32 until 2.1.0
/** Whether `holder` carries what a pre-2.0 stim-daemon writes. */
export function isStimDaemonClaim(holder: ClaimHolder): boolean {
  return (
    holder.mode === 'exclusive' &&
    holder.details.socket === legacyDaemonSocket() &&
    typeof holder.details.mode === 'string' &&
    holder.details.build === undefined
  );
}

/** The live exclusive holder of the daemon claim, which only a stim-daemon from before Stim 2.0 takes. */
export function legacyDaemonHolder(): { owner: ClaimOwner } | null {
  try {
    const holder = readClaimSet(daemonClaimRoot()).live.find((entry) => entry.mode === 'exclusive');
    return holder ? { owner: holder.owner } : null;
  } catch {
    return null;
  }
}

// compat end

/** The command that stops a holder of the daemon claim from before Stim 2.0. */
export function legacyDaemonStop(pid: number): string {
  return process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
}
