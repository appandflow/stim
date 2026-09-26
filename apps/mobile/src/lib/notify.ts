/**
 * Which attention items notify, and when. packages/server/src/notify.ts holds the same code;
 * packages/server/__tests__/attention-agreement.test.ts fails when the two disagree.
 */

interface NotifyEntry {
  occurrence: string;
  since: number;
  heldSince: number;
  seenAt: number;
  notifiedAt: number | null;
  done: boolean;
  count?: number;
}

export type NotifyEntries = Record<string, NotifyEntry>;

export interface NotifyChoice {
  events: readonly string[];
  /** Leaves out workspace items whose workspace no agent drives. */
  agentOnly: boolean;
}

export interface NotifyCandidate {
  key: string;
  event: string;
  occurrence: string;
  reason: string;
  driven: boolean | null;
  count?: number;
}

/** How long an item must hold before it notifies: log errors settle, and an offline machine may reconnect. */
const SETTLE_MS: Readonly<Record<string, number>> = { 'log-errors': 10_000, offline: 60_000 };
/** Log errors that keep arriving still notify this long after the first one. */
const MAX_SETTLE_MS: number = 60_000;
const LOG_COOLDOWN_MS: number = 5 * 60_000;
/** An item absent this long is forgotten, so a later one notifies again; a shorter gap is the same problem. */
const FORGET_MS: number = 2 * 60_000;

export interface NotifyDiff<C> {
  entries: NotifyEntries;
  notify: C[];
  /** When a held item becomes due, if one is waiting. */
  wakeAt: number | null;
}

/**
 * The notifications `candidates` owe since `entries`, the state the previous call returned. Null `entries`
 * records every candidate without notifying, so what is already wrong at the first check stays quiet. An item
 * notifies once per occurrence. `awakeSince` restarts the settle time, for a checker that was not running.
 */
export function diffAttention<C extends NotifyCandidate>(
  entries: NotifyEntries | null,
  candidates: C[],
  choice: NotifyChoice,
  now: number,
  awakeSince = 0,
): NotifyDiff<C> {
  const next: NotifyEntries = {};
  const notify: C[] = [];
  let wakeAt: number | null = null;
  for (const candidate of candidates) {
    const prev = entries?.[candidate.key];
    let entry: NotifyEntry =
      prev && prev.occurrence === candidate.occurrence
        ? { ...prev, seenAt: now }
        : {
            occurrence: candidate.occurrence,
            since: now,
            heldSince: prev && !prev.done ? prev.heldSince : now,
            seenAt: now,
            notifiedAt: prev?.notifiedAt ?? null,
            done: entries === null,
            ...(prev?.count !== undefined ? { count: prev.count } : {}),
          };
    if (entries === null) entry = { ...entry, count: candidate.count };
    next[candidate.key] = entry;
    if (entry.done) continue;
    const wanted = choice.events.includes(candidate.event) && !(choice.agentOnly && candidate.driven === false);
    if (!wanted) {
      next[candidate.key] = { ...entry, done: true, count: candidate.count };
      continue;
    }
    const settle = SETTLE_MS[candidate.event] ?? 0;
    let dueAt = Math.max(Math.min(entry.since + settle, entry.heldSince + MAX_SETTLE_MS), awakeSince + settle);
    if (candidate.event === 'log-errors' && entry.notifiedAt !== null) {
      dueAt = Math.max(dueAt, entry.notifiedAt + LOG_COOLDOWN_MS);
    }
    if (now < dueAt) {
      wakeAt = wakeAt === null ? dueAt : Math.min(wakeAt, dueAt);
      continue;
    }
    next[candidate.key] = { ...entry, done: true, notifiedAt: now, count: candidate.count };
    notify.push(
      candidate.event === 'log-errors' ? { ...candidate, reason: newErrors(candidate, entry.count) } : candidate,
    );
  }
  for (const [key, entry] of Object.entries(entries ?? {})) {
    if (!(key in next) && now - entry.seenAt < FORGET_MS) next[key] = entry;
  }
  return { entries: next, notify, wakeAt };
}

function newErrors(candidate: NotifyCandidate, before: number | undefined): string {
  const count = candidate.count ?? 0;
  const added = before !== undefined && count > before ? count - before : count;
  const noun = added === 1 ? 'error' : 'errors';
  return added === count ? `${count} ${noun} in the logs` : `${added} new ${noun} in the logs`;
}
