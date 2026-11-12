import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../packages/core/ownership-claim.ts';

const PROGRESS_MS = 30_000;

function describeHolder(holder) {
  const cwd = typeof holder.details.cwd === 'string' ? holder.details.cwd : 'unknown directory';
  return `pid ${holder.owner.pid} in ${cwd} since ${holder.startedAt}`;
}

function arrivalOrder(a, b) {
  return a.startedAt.localeCompare(b.startedAt) || a.claimId.localeCompare(b.claimId);
}

/**
 * Takes one of `slots` machine-wide slots under `dir` and resolves to a release function. Callers queue in arrival
 * order: only the head of the queue tries the slots. A slot is an exclusive ownership claim whose liveness is its
 * holder's process identity, so a dead holder frees its slot. A claim store that cannot be read, written or judged
 * (a corrupt claim, an unwritable `dir`) never blocks: the run proceeds without the cap and says so on stderr.
 */
export async function acquireTestSlot({ dir, slots, details, log, pollMs = 500 }) {
  const queueRoot = join(dir, 'queue');
  const slotRoots = Array.from({ length: slots }, (_, index) => join(dir, `slot-${index}`));
  const warn = (what, err) => log(`test slot: ${what} (${err.message.split('\n')[0]}); running without the cap.`);

  let queued = null;
  try {
    queued = tryAcquireClaim({ root: queueRoot, mode: 'shared', details, label: 'test queue' }).acquired ?? null;
  } catch (err) {
    warn('the queue is unavailable', err);
  }
  const leave = () => releaseClaim(queued);

  let lastReport = 0;
  try {
    for (;;) {
      const waiting = queued ? readClaimSet(queueRoot).live.toSorted(arrivalOrder) : [];
      const position = queued ? waiting.findIndex((claim) => claim.claimId === queued.claimId) : 0;
      if (position <= 0) {
        const busy = [];
        let unusable = 0;
        for (const root of slotRoots) {
          try {
            const attempt = tryAcquireClaim({ root, mode: 'exclusive', details, label: 'test slot' });
            if (attempt.acquired) {
              const claim = attempt.acquired;
              leave();
              return () => releaseClaim(claim);
            }
            if (attempt.held) busy.push(attempt.held);
          } catch (err) {
            unusable += 1;
            warn(`${root} cannot be judged`, err);
          }
        }
        if (busy.length === 0 && unusable > 0) {
          leave();
          return () => {};
        }
        if (Date.now() - lastReport >= PROGRESS_MS) {
          lastReport = Date.now();
          log(`test slot: all ${slots} slots are in use, waiting for ${busy.map(describeHolder).join('; ')}.`);
        }
      } else if (Date.now() - lastReport >= PROGRESS_MS) {
        lastReport = Date.now();
        log(
          `test slot: queued behind ${position} earlier run${position === 1 ? '' : 's'} (${waiting.slice(0, position).map(describeHolder).join('; ')}).`,
        );
      }
      await sleep(pollMs);
    }
  } catch (err) {
    leave();
    throw err;
  }
}
