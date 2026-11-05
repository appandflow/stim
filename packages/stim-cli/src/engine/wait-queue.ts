import { join } from 'node:path';
import type { DaemonWaiter } from '@stim-cli/core/state';
import {
  ClaimRefusedError,
  inspectClaimSet,
  tryAcquireClaim,
  type ClaimHandle,
  type ClaimHolder,
} from '../ownership-claim.ts';
import { getConfigDir } from '../workspace/config.ts';

export type WaitResource = DaemonWaiter['resource'];

const QUEUE: Record<WaitResource, { dir: string; label: string }> = {
  build: { dir: 'build-waits', label: 'build wait' },
  boot: { dir: 'device-waits', label: 'device wait' },
};

const MINUTE_MS = 60_000;

function waitQueueRoot(resource: WaitResource): string {
  return join(getConfigDir(), QUEUE[resource].dir);
}

/** The runs waiting for `resource`, in arrival order. */
export function liveWaiters(resource: WaitResource): ClaimHolder[] {
  const root = waitQueueRoot(resource);
  const survey = inspectClaimSet(root, { label: QUEUE[resource].label });
  if (survey.exclusive)
    throw new ClaimRefusedError({
      root,
      claimPath: survey.exclusive.path,
      reason: 'the wait queue is held exclusively',
      label: QUEUE[resource].label,
    });
  return survey.shared.toSorted(
    (a, b) =>
      (Number(a.details.sequence) || 0) - (Number(b.details.sequence) || 0) ||
      a.startedAt.localeCompare(b.startedAt) ||
      a.claimId.localeCompare(b.claimId),
  );
}

/** Joins the end of the `resource` queue: a shared claim numbered after every live waiter. */
export function takeWaitTicket(
  resource: WaitResource,
  details: Record<string, unknown>,
  waiters: readonly ClaimHolder[],
): ClaimHandle {
  const root = waitQueueRoot(resource);
  const sequence = Math.max(0, ...waiters.map((holder) => Number(holder.details.sequence) || 0)) + 1;
  const attempt = tryAcquireClaim({
    root,
    mode: 'shared',
    label: QUEUE[resource].label,
    details: { ...details, sequence },
  });
  if (attempt.acquired) return attempt.acquired;
  throw new ClaimRefusedError({
    root,
    claimPath: attempt.held?.path ?? root,
    reason: 'the wait queue is held exclusively',
    label: QUEUE[resource].label,
  });
}

/** A waiter's 1-based position, or the position it would take on joining. */
export function queuePosition(waiters: readonly ClaimHolder[], ticket: ClaimHandle | undefined): number {
  const index = ticket ? waiters.findIndex((holder) => holder.claimId === ticket.claimId) : -1;
  return index < 0 ? waiters.length + 1 : index + 1;
}

/** The longest a run waits in a queue, whatever holds it up: the old build-slot ceiling. */
const ABSOLUTE_WAIT_CEILING_MS = 90 * MINUTE_MS;

/**
 * How long a run at `position` waits while what holds it up cannot be shown to be alive, before it refuses with
 * `STIM_AT_CAPACITY`: max(10 minutes, position x 5 minutes).
 */
export function positionCeilingMs(position: number): number {
  return Math.max(10 * MINUTE_MS, position * 5 * MINUTE_MS);
}

export type WaitOverdue =
  | { kind: 'absolute'; waitedMs: number }
  | { kind: 'unverified'; position: number; waitedMs: number; reason: string };

/**
 * A waiter's ceiling. It never refuses while every holder ahead of it is provably alive or its position improves; it
 * refuses once a holder's liveness has stayed unestablished for the position ceiling, or after 90 minutes in all.
 * `update` takes the position and why a holder's liveness is unknown, or null when every holder is provably alive.
 */
export function waitCeiling(now: () => number): {
  update: (position: number, unverified: string | null) => void;
  overdue: () => WaitOverdue | null;
} {
  const started = now();
  let position = Infinity;
  let since: number | null = null;
  let reason = '';
  return {
    update(next, unverified) {
      if (unverified === null) since = null;
      else if (since === null || next < position) since = now();
      reason = unverified ?? '';
      position = next;
    },
    overdue() {
      const at = now();
      if (at - started >= ABSOLUTE_WAIT_CEILING_MS) return { kind: 'absolute', waitedMs: at - started };
      return since !== null && at - since >= positionCeilingMs(position)
        ? { kind: 'unverified', position, waitedMs: at - since, reason }
        : null;
    },
  };
}

/** Every run waiting for a build slot or a device boot, in arrival order per resource; unreadable queues are skipped. */
export function listWaiting(): DaemonWaiter[] {
  const waiting: DaemonWaiter[] = [];
  for (const resource of ['build', 'boot'] as const) {
    let waiters: ClaimHolder[];
    try {
      waiters = liveWaiters(resource);
    } catch {
      continue;
    }
    for (const [index, holder] of waiters.entries()) {
      const { root, displayName, platform } = holder.details;
      waiting.push({
        resource,
        position: index + 1,
        workspace: typeof root === 'string' ? root : null,
        label: typeof displayName === 'string' ? displayName : typeof root === 'string' ? root : 'a run',
        ...(typeof platform === 'string' ? { platform } : {}),
        since: holder.startedAt,
      });
    }
  }
  return waiting;
}
