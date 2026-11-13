import { daemonClaimRoot, legacyDaemonSocket } from '@stim-cli/core/state';
import { readClaimSet, type ClaimHolder, type ClaimOwner } from '@stim-cli/core/ownership-claim';
import { inspectProcessIdentity, waitForProcessExit, type ProcessIdentityStatus } from '../process-identity.ts';

// compat C32 until 2.1.0
const EXIT_WAIT_MS = 3000;

type Log = (level: 'info' | 'warn', event: string, message: string) => void;

export interface LegacyDaemonHolder {
  owner: ClaimOwner;
  /** Whether the claim carries what a pre-2.0 stim-daemon writes: its socket and its mode, and no build. */
  stimDaemon: boolean;
}

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
export function legacyDaemonHolder(): LegacyDaemonHolder | null {
  try {
    const holder = readClaimSet(daemonClaimRoot()).live.find((entry) => entry.mode === 'exclusive');
    return holder ? { owner: holder.owner, stimDaemon: isStimDaemonClaim(holder) } : null;
  } catch {
    return null;
  }
}

/** Sends SIGTERM to `owner` only while its identity reads `same`, in this one synchronous step. */
function terminate(owner: ClaimOwner): ProcessIdentityStatus | 'signalled' | 'failed' {
  const identity = inspectProcessIdentity(owner);
  if (identity !== 'same') return identity;
  try {
    process.kill(owner.pid, 'SIGTERM');
    return 'signalled';
  } catch {
    return 'failed';
  }
}

/**
 * Stops a stim-daemon from before Stim 2.0 that holds this home's daemon claim exclusively. The old daemon has no stop
 * request; on SIGTERM it releases its claim at once and exits after the tick in progress. It owns no child: dev servers,
 * log collectors and devices run on and stay as they are. Waits up to {@link EXIT_WAIT_MS} for the process to end; one
 * that has released its claim and still runs is left to finish its tick, and one that still holds the claim makes the
 * caller's claim attempt fail. Logs the signal, or why none was sent, and the outcome.
 */
export async function takeOverLegacyDaemon(log: Log): Promise<void> {
  const holder = legacyDaemonHolder();
  if (!holder?.stimDaemon) return;
  const { owner } = holder;
  const sent = terminate(owner);
  if (sent !== 'signalled') {
    log('warn', 'stimd_takeover_skipped', `stim-daemon pid ${owner.pid} was not signalled: its identity reads ${sent}`);
    return;
  }
  log('info', 'stimd_takeover_signal', `sent SIGTERM to stim-daemon pid ${owner.pid}, whose identity read same`);
  if (await waitForProcessExit(owner, EXIT_WAIT_MS)) {
    log('info', 'stimd_takeover', `stopped stim-daemon pid ${owner.pid}, from an older Stim`);
    return;
  }
  log(
    'warn',
    'stimd_takeover_overlap',
    `stim-daemon pid ${owner.pid} still runs ${EXIT_WAIT_MS / 1000} s after SIGTERM and ${legacyDaemonHolder() ? 'still holds the daemon claim, so stimd cannot take it' : 'has released the daemon claim, so stimd takes it while that daemon finishes its tick'}`,
  );
}
// compat end

/** The remedy for a holder Stim does not stop: its pid and the command that ends it. */
export function legacyDaemonStop(pid: number): string {
  return process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`;
}
