import {
  ClaimUnavailableError,
  isClaimUnavailable,
  processGroupAlive,
  releaseClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import type { UnverifiedCleanup } from '@stim-cli/core/state';
import { reportChildOf, WorkspaceProcessCleanupError } from '../engine/workspace-process-error.ts';

const MAX_CONTAINED_CLEANUPS = 8;

type Log = (level: 'info' | 'error', event: string, msg: string) => void;

export function isUnverifiedCleanup(error: unknown): error is ClaimUnavailableError {
  return isClaimUnavailable(error) && 'reportCleanup' in error;
}

/** The key that names the child an unverified cleanup refusal identifies, or null when it names none. */
export function childKey(error: unknown): string | null {
  const child = reportChildOf(error);
  return child ? `${child.pid}:${child.processToken ?? ''}` : null;
}

export interface CleanupWatch {
  /** Watches `error`'s child and returns true, or returns false when stimd cannot stay up for it. */
  contain(error: unknown, ending: boolean): boolean;
  /** Drops every child found stopped, releasing the claims only it retained. */
  settle(): void;
  pending(): boolean;
  reason(): string | null;
  errors(): ClaimUnavailableError[];
  /** The keys of the children still watched. */
  keys(): string[];
  /** Each child still watched: since when, what failed and how a person checks it. */
  entries(): UnverifiedCleanup[];
}

/**
 * The children whose cleanup stimd's tick, a Metro or tunnel stop, or a job on one of its threads could not verify.
 * Each keeps stimd up until a later check finds it stopped, which releases the claims its failure retained once no other
 * unverified child holds them. Only a refusal that names one child and how to check it is contained, each child once and
 * at most `MAX_CONTAINED_CLEANUPS` of them; any other unverified cleanup ends stimd. A thread keeps its own watch, since
 * the checks are functions that cannot leave it.
 */
export function createCleanupWatch(log: Log): CleanupWatch {
  let unsettled: {
    error: ClaimUnavailableError;
    settled: () => boolean;
    claims: readonly ClaimHandle[];
    since: string;
  }[] = [];
  return {
    contain(error: unknown, ending: boolean): boolean {
      if (ending || !isUnverifiedCleanup(error)) return false;
      const key = childKey(error);
      const settled = cleanupCheck(error);
      if (!key || !settled) return false;
      if (unsettled.some((entry) => childKey(entry.error) === key)) return true;
      if (unsettled.length >= MAX_CONTAINED_CLEANUPS) return false;
      unsettled.push({
        error,
        settled,
        claims: error instanceof WorkspaceProcessCleanupError ? error.claims : [],
        since: new Date().toISOString(),
      });
      log(
        'error',
        'daemon_cleanup_unverified',
        `stimd goes on and stays up until the child has stopped: ${error.message} ${error.remedy ?? ''}`.trim(),
      );
      return true;
    },
    settle() {
      const stopped = unsettled.filter((entry) => entry.settled());
      unsettled = unsettled.filter((entry) => !stopped.includes(entry));
      const stillHeld = new Set(unsettled.flatMap((entry) => entry.claims.map((held) => held.path)));
      for (const entry of stopped) {
        const released = entry.claims
          .filter((held) => !stillHeld.has(held.path) && releaseClaim(held))
          .map((held) => held.path);
        log(
          'info',
          'daemon_cleanup_settled',
          `a child whose cleanup was not verified has stopped${released.length ? `; released ${released.join(', ')}` : ''}`,
        );
      }
    },
    pending: () => unsettled.length > 0,
    reason: () => (unsettled.length > 0 ? 'a child whose cleanup was not verified may still run' : null),
    errors: () => unsettled.map((entry) => entry.error),
    keys: () => unsettled.flatMap((entry) => childKey(entry.error) ?? []),
    entries: () =>
      unsettled.map((entry) => {
        const child = reportChildOf(entry.error)?.pid ?? 0;
        const stop = process.platform === 'win32' ? `taskkill /PID ${process.pid} /F` : `kill ${process.pid}`;
        return {
          since: entry.since,
          child,
          message: entry.error.message,
          remedy: `${entry.error.remedy ?? 'Check that the child and its descendants have stopped.'} The wait ends once child ${child} and its process group have stopped. Stopping this stimd is also safe: run \`${stop}\`, and the next stim command starts a new one.`,
        };
      }),
  };
}

/** How a later check learns that a child whose cleanup was not verified has stopped, or null when nothing can tell. */
function cleanupCheck(error: object): (() => boolean) | null {
  for (const key of ['cleanupSettled', 'reportResourceSettled']) {
    const check: unknown = Reflect.get(error, key);
    if (typeof check === 'function') return () => check() === true;
  }
  const child = reportChildOf(error);
  return child && process.platform !== 'win32' ? () => !processGroupAlive(child.pid) : null;
}
